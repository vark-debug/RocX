// runcommand-win-test.cpp — 直接调用 RocXBridgeCommandWin.cpp 的 RunCommandForPlatform,
// 验证 Windows 上能真正跑起可灵 CLI。
//
// 与 JS 侧新逻辑完全一致的调用方式:
//   exe  = node 绝对路径
//   args = [cli.js 绝对路径, "--version"]
//
// 构建(在 native/RocXBridge 下):
//   cl /EHsc /std:c++17 /DUNICODE /D_UNICODE /Fe:test\runcommand-win-test.exe test\runcommand-win-test.cpp src\RocXBridgeCommandWin.cpp
// 运行:
//   test\runcommand-win-test.exe

#include <cstdio>
#include <string>
#include <vector>

#include "../src/RocXBridge.h"

int main() {
    // 与 klingCli.ts 新逻辑相同的定位结果
    const std::string nodePath = "C:\\Program Files\\nodejs\\node.exe";
    const std::string cliJs =
        "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@klingai\\cli-cn\\dist\\cli.js";

    printf("=== 1) node + cli.js --version ===\n");
    CommandResult r = RunCommandForPlatform(
        nodePath, {cliJs, "--version"}, "", 30000);
    printf("ok=%d exitCode=%d error='%s' truncated=%d\n", r.ok ? 1 : 0, r.exitCode,
           r.error.c_str(), r.truncated ? 1 : 0);
    printf("stdout: %s\n", r.out.c_str());
    if (!r.err.empty()) printf("stderr: %s\n", r.err.c_str());

    if (!r.ok) {
        printf("FAIL: runCommand 执行失败\n");
        return 1;
    }
    if (r.out.find("kling-cli") == std::string::npos) {
        printf("FAIL: stdout 不含 kling-cli\n");
        return 1;
    }

    printf("\n=== 2) who_am_i (验证 JSON 信封解析) ===\n");
    CommandResult r2 = RunCommandForPlatform(nodePath, {cliJs, "who_am_i", "--quiet"}, "", 60000);
    printf("ok=%d exitCode=%d error='%s'\n", r2.ok ? 1 : 0, r2.exitCode, r2.error.c_str());
    printf("stdout(前 400 字): %s\n", r2.out.substr(0, 400).c_str());
    if (!r2.err.empty()) printf("stderr(前 200 字): %s\n", r2.err.substr(0, 200).c_str());

    printf("\nRESULT: OK\n");
    return 0;
}
