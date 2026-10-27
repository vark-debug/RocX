/*
 * runCommand 的独立测试 — 不依赖 UXP 宿主,直接调平台层实现。
 * 编译: 见同目录 run-test.sh
 */
#import <Foundation/Foundation.h>

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/RocXBridgeCommand.mm"

static int g_failed = 0;

static void Expect(bool cond, const char* what) {
    if (cond) {
        std::printf("  ✓ %s\n", what);
    } else {
        std::printf("  ✗ %s\n", what);
        ++g_failed;
    }
}

int main() {
    std::printf("[1] 正常执行并捕获 stdout\n");
    {
        CommandResult r = RunCommandForPlatform("/bin/echo", {"hello", "world"}, "", 5000);
        Expect(r.ok, "ok == true");
        Expect(r.exitCode == 0, "exitCode == 0");
        Expect(r.out == "hello world\n", "stdout 内容正确");
        Expect(r.err.empty(), "stderr 为空");
        Expect(!r.truncated, "未截断");
    }

    std::printf("[2] 捕获 stderr,stdout 与 stderr 分离\n");
    {
        CommandResult r = RunCommandForPlatform("/bin/sh", {"-c", "echo out; echo err 1>&2"}, "", 5000);
        Expect(r.ok, "ok == true");
        Expect(r.out.find("out") != std::string::npos, "stdout 含 out");
        Expect(r.err.find("err") != std::string::npos, "stderr 含 err");
        Expect(r.out.find("err") == std::string::npos, "stdout 不含 stderr 内容");
        Expect(r.err.find("out") == std::string::npos, "stderr 不含 stdout 内容");
    }

    std::printf("[3] 非零退出码\n");
    {
        CommandResult r = RunCommandForPlatform("/bin/sh", {"-c", "exit 3"}, "", 5000);
        Expect(!r.ok, "ok == false");
        Expect(r.exitCode == 3, "exitCode == 3");
        Expect(!r.error.empty(), "error 非空");
    }

    std::printf("[4] 可执行文件不存在\n");
    {
        CommandResult r = RunCommandForPlatform("/nonexistent/binary/xyz", {"a"}, "", 2000);
        Expect(!r.ok, "ok == false");
        Expect(r.error == "spawn failed", "error == spawn failed");
    }

    std::printf("[5] 超时 kill\n");
    {
        auto t0 = std::chrono::steady_clock::now();
        CommandResult r = RunCommandForPlatform("/bin/sh", {"-c", "sleep 30"}, "", 1000);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - t0)
                      .count();
        Expect(!r.ok, "ok == false");
        Expect(r.error == "timeout", "error == timeout");
        Expect(ms < 5000, "在超时附近返回(未等满 30s)");
    }

    std::printf("[6] 空路径\n");
    {
        CommandResult r = RunCommandForPlatform("", {}, "", 1000);
        Expect(!r.ok, "ok == false");
        Expect(r.error == "empty exe path", "error == empty exe path");
    }

    std::printf("[7] UTF-8 中文输出\n");
    {
        CommandResult r = RunCommandForPlatform("/bin/echo", {"可灵积分制"}, "", 5000);
        Expect(r.ok, "ok == true");
        Expect(r.out.find("可灵积分制") != std::string::npos, "中文正常捕获");
    }

    std::printf("[8] 超长输出截断 + UTF-8 边界\n");
    {
        // 输出 1MB 纯 ASCII(截断边界测试用纯 ASCII 更可控),
        // 再单独用中文验证 UTF-8 边界不被切坏
        CommandResult r = RunCommandForPlatform(
            "/bin/sh", {"-c", "dd if=/dev/zero bs=1024 count=1024 2>/dev/null | tr '\\0' 'a'"}, "", 10000);
        std::printf("    (实际捕获 %zu 字节, truncated=%d)\n", r.out.size(), (int)r.truncated);
        Expect(r.truncated, "truncated == true");
        Expect(r.out.size() == 256 * 1024, "截断到 256KB");
    }

    std::printf("[9] 多字节字符不被截成非法序列\n");
    {
        // 输出 300KB 中文(每字 3 字节),256KB 边界正好落在多字节字符中间
        CommandResult r = RunCommandForPlatform(
            "/bin/sh", {"-c", "dd if=/dev/zero bs=1024 count=300 2>/dev/null | tr '\\0' '可'"}, "", 10000);
        Expect(r.truncated, "truncated == true");
        bool valid = true;
        size_t i = 0;
        while (i < r.out.size()) {
            unsigned char c = static_cast<unsigned char>(r.out[i]);
            size_t n = 1;
            if ((c & 0x80) == 0) {
                n = 1;
            } else if ((c & 0xE0) == 0xC0) {
                n = 2;
            } else if ((c & 0xF0) == 0xE0) {
                n = 3;
            } else if ((c & 0xF8) == 0xF0) {
                n = 4;
            } else {
                valid = false;
                break;
            }
            if (i + n > r.out.size()) {
                valid = false;
                break;
            }
            i += n;
        }
        Expect(valid, "截断后仍是合法 UTF-8 序列");
    }

    std::printf("\n%s\n", g_failed == 0 ? "全部通过" : "有失败项");
    return g_failed == 0 ? 0 : 1;
}
