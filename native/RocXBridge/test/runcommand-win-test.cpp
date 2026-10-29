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

    // 3) 中文参数往返 ——
    //    mac 侧新增的可灵图片生成(text_to_image / image_to_image)会把中文 prompt
    //    和含中文/空格的素材路径经 addon 传给 CLI，这里覆盖 UTF-8 转换路径。
    //    TrimToUtf8Boundary 的 off-by-one 曾经多砍一个完整中文字符。
    printf("\n=== 3) 中文参数往返 (UTF-8 边界) ===\n");
    const std::string cnPrompt = u8"一只在赛博朋克城市雨夜中奔跑的猫，霓虹灯光";
    const std::string cnPath =
        "C:\\Users\\Administrator\\Pictures\\\xE6\xB5\x8B\xE8\xAF\x95 \xE5\x9B\xBE\xE7\x89\x87\\frame 01.jpg";
    printf("prompt 字节长度: %zu\n", cnPrompt.size());
    printf("path   字节长度: %zu\n", cnPath.size());

    // 用 node 把 argv 逐个打印出来，验证 addon 传给子进程的内容与原值完全一致。
    const std::string dumpJs = "console.log(JSON.stringify(process.argv.slice(2)))";
    CommandResult r3 = RunCommandForPlatform(
        nodePath, {"-e", dumpJs, "marker", cnPrompt, cnPath}, "", 30000);
    printf("ok=%d exitCode=%d error='%s'\n", r3.ok ? 1 : 0, r3.exitCode, r3.error.c_str());
    printf("stdout: %s\n", r3.out.c_str());

    bool argsRoundTrip = false;
    if (r3.ok) {
        // stdout 是 JSON 数组，反斜杠会被转义成 \\ ，所以比对前先做同样转义。
        // 中文不会被 JSON 转义，直接比对原文。
        const std::string needle = "\"" + cnPrompt + "\"";
        std::string escapedPath;
        for (char c : cnPath) {
            if (c == '\\') escapedPath += "\\\\";
            else escapedPath += c;
        }
        const std::string needlePath = "\"" + escapedPath + "\"";
        argsRoundTrip = r3.out.find(needle) != std::string::npos &&
                        r3.out.find(needlePath) != std::string::npos;
        if (!argsRoundTrip) {
            printf("  期望含 prompt: %s\n", needle.c_str());
            printf("  期望含 path  : %s\n", needlePath.c_str());
            printf("  实际 stdout  : %s\n", r3.out.c_str());
        }
    }
    if (!argsRoundTrip) {
        printf("FAIL: 中文参数经 addon 后未原样传递\n");
        return 1;
    }
    printf("中文 prompt 与中文+空格路径均原样传递 ✅\n");

    printf("\nRESULT: OK\n");
    return 0;
}
