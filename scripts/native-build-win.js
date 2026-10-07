// scripts/native-build-win.js
// 在 Windows 上编译 RocXBridge.uxpaddon。
// 自动定位 cmake：优先 VS2026 自带 cmake,其次 PATH 上的 cmake。
// generator 固定为 "Visual Studio 18 2026"(VS2026 主版本号=18)。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const bridgeDir = path.join(repoRoot, 'native', 'RocXBridge');

// VS2026 自带 cmake 候选路径(按常见安装布局枚举)
const vs2026CmakeCandidates = [
    'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\18\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe',
];

let cmake = null;
for (const p of vs2026CmakeCandidates) {
    if (fs.existsSync(p)) { cmake = p; break; }
}
if (!cmake) {
    const which = spawnSync('where', ['cmake'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) {
        cmake = which.stdout.split(/\r?\n/)[0].trim();
    }
}
if (!cmake) {
    console.error('[native:build:win] cmake 未找到。请安装 Visual Studio 2022/2026 (含 "C++ 桌面开发" 工作负载) 或独立的 CMake。');
    process.exit(1);
}

console.log(`[native:build:win] using cmake: ${cmake}`);

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: bridgeDir, stdio: 'inherit', shell: false });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

run(cmake, ['-B', 'build', '-G', 'Visual Studio 18 2026', '-A', 'x64']);
run(cmake, ['--build', 'build', '--config', 'Release']);
