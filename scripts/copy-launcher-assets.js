// scripts/copy-launcher-assets.js
// 在 build/package/zip 模式下,把 public-zip/launcher.{ps1,command} 拷到 dist 根。
// vite-uxp-plugin 的 copyZipAssets 只在 mode==="zip" 时生效,build/package 不拷,
// 这里用一个独立 vite 插件补齐 build/package 模式。
//
// 调用方:vite.config.ts 内 plugins 数组。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const LAUNCHER_FILES = [
    // .command 必须带可执行位，否则 macOS 弹「因为你没有正确的访问权限」而拒绝运行。
    // Windows 签出/git 归档会丢 exec 位，所以拷贝后统一显式 chmod，不依赖源文件权限。
    { src: 'launcher.cmd', dst: 'launcher.cmd', mode: 0o755 },
    { src: 'launcher.ps1', dst: 'launcher.ps1', mode: 0o755 },
    { src: 'launcher.command', dst: 'launcher.command', mode: 0o755 },
];

/**
 * @param {{mode?: string}} opts
 * @returns {import('vite').Plugin}
 */
export function copyLauncherAssets(opts = {}) {
    const { mode } = opts;
    const copyAll = () => {
        const srcDir = path.join(repoRoot, 'public-zip');
        const distDir = path.join(repoRoot, 'dist');
        if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return;
        for (const { src, dst, mode: fileMode } of LAUNCHER_FILES) {
            const srcPath = path.join(srcDir, src);
            if (!fs.existsSync(srcPath)) continue;
            const dstPath = path.join(distDir, dst);
            fs.copyFileSync(srcPath, dstPath);
            // copyFileSync 会保留源文件 mode，但源 mode 可能是 644（Windows 上传的 zip）
            try {
                fs.chmodSync(dstPath, fileMode);
            } catch (e) {
                console.warn(`[rocx] chmod ${mode} 失败: ${dstPath}`, e);
            }
            console.log(`[rocx] copied ${src} -> dist/${dst} (mode ${fileMode.toString(8)})`);
        }
    };
    return {
        name: 'rocx-copy-launcher-assets',
        // 不设 apply:'build' —— dev 模式(vite build --watch)也要拷贝。
        // 否则 dev 下 dist/ 里没有 launcher 脚本，UXP 探测失败，
        // 「抓帧→PS」会整级跳过 launcher 脚本降级。
        buildStart() {
            // vite build --watch 下每次重建都会先清空 dist,
            // 在 buildStart(清空之前)拷一次,保证首轮也有。
            if (mode === 'dev') copyAll();
        },
        closeBundle() {
            copyAll();
        },
    };
}
