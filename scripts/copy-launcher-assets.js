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
    { src: 'launcher.cmd', dst: 'launcher.cmd' },
    { src: 'launcher.ps1', dst: 'launcher.ps1' },
    { src: 'launcher.command', dst: 'launcher.command' },
];

/**
 * @param {{mode?: string}} opts
 * @returns {import('vite').Plugin}
 */
export function copyLauncherAssets(opts = {}) {
    const { mode } = opts;
    return {
        name: 'rocx-copy-launcher-assets',
        apply: 'build',
        closeBundle() {
            const srcDir = path.join(repoRoot, 'public-zip');
            const distDir = path.join(repoRoot, 'dist');
            if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return;
            for (const { src, dst } of LAUNCHER_FILES) {
                const srcPath = path.join(srcDir, src);
                if (!fs.existsSync(srcPath)) continue;
                const dstPath = path.join(distDir, dst);
                fs.copyFileSync(srcPath, dstPath);
                console.log(`[rocx] copied ${src} -> dist/${dst}`);
            }
        },
    };
}
