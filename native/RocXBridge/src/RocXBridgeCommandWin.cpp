/*
 * RocXBridgeCommandWin.cpp — Windows 命令执行
 *
 * 用 CreateProcessW + CreatePipe() 执行命令并捕获 stdout/stderr。
 * 不用 ShellExecuteExW —— 那套无法重定向输出,且现存代码里的进程句柄未关闭属既有缺陷。
 *
 * Apache 2.0
 */
#include <windows.h>

#include <string>
#include <vector>

#include "RocXBridge.h"

namespace {

/** stdout/stderr 各自的上限(字节) */
constexpr size_t kMaxOutputBytes = 256 * 1024;

std::wstring wideFromUtf8(const char* utf8) {
    if (utf8 == nullptr || *utf8 == '\0') {
        return std::wstring();
    }
    int needed = ::MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (needed <= 1) {
        return std::wstring();
    }
    // -1 模式写入会带上结尾的 '\0',所以要按 needed(含终止符)分配再 pop_back
    std::wstring wide(static_cast<size_t>(needed), L'\0');
    ::MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], needed);
    wide.pop_back();
    return wide;
}

std::string utf8FromWide(const std::wstring& wide) {
    if (wide.empty()) {
        return std::string();
    }
    int needed = ::WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 1) {
        return std::string();
    }
    std::string utf8(static_cast<size_t>(needed), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, &utf8[0], needed, nullptr, nullptr);
    utf8.pop_back();
    return utf8;
}

/**
 * 给可执行文件路径补上 .cmd / .bat 后缀查找。
 * npm 全局安装的 kling 在 Windows 上是 kling.cmd,CreateProcessW 不能直接执行批处理,
 * 需要用 cmd.exe /c 包裹(见下 BuildCommandLine)。
 *
 * 注意:必须搜 PATH —— 传入的 exe 可能是裸命令名(如 "cmd.exe"、"kling"),
 * GetFileAttributesW 只按当前工作目录解析,而 PR 拉起的进程 CWD 不可控,
 * 直接判定"找不到"会让可灵 CLI 误报成"未安装"。
 */
bool ResolveExecutable(const std::wstring& exe, std::wstring* resolved) {
    if (exe.empty()) {
        return false;
    }

    // 1) 绝对/相对路径直接命中
    if (::GetFileAttributesW(exe.c_str()) != INVALID_FILE_ATTRIBUTES) {
        *resolved = exe;
        return true;
    }

    // 2) 补后缀后再试(同目录下的 foo.cmd / foo.bat / foo.exe)
    const wchar_t* exts[] = {L".cmd", L".bat", L".exe", L""};
    for (const wchar_t* ext : exts) {
        std::wstring candidate = exe + ext;
        if (::GetFileAttributesW(candidate.c_str()) != INVALID_FILE_ATTRIBUTES) {
            *resolved = candidate;
            return true;
        }
    }

    // 3) 搜 PATH。SearchPathW 会依次尝试传入的扩展名和 PATHEXT,
    //    裸命令名("cmd.exe" / "kling")靠这步才能找到。
    wchar_t found[MAX_PATH * 2] = { 0 };
    DWORD n = ::SearchPathW(nullptr, exe.c_str(), nullptr, MAX_PATH * 2, found, nullptr);
    if (n > 0 && n < MAX_PATH * 2) {
        *resolved = found;
        return true;
    }

    // 4) 裸命令名 + 常见扩展名再搜一次(如 "kling" -> kling.cmd)
    if (exe.find(L'.') == std::wstring::npos) {
        for (const wchar_t* ext : exts) {
            if (ext[0] == L'\0') continue;
            std::wstring named = exe + ext;
            n = ::SearchPathW(nullptr, named.c_str(), nullptr, MAX_PATH * 2, found, nullptr);
            if (n > 0 && n < MAX_PATH * 2) {
                *resolved = found;
                return true;
            }
        }
    }

    return false;
}

/** 引号包裹,Windows 命令行解析需要 */
std::wstring QuoteArg(const std::wstring& arg) {
    bool needsQuote = arg.empty() || arg.find_first_of(L" \t\"") != std::wstring::npos;
    if (!needsQuote) {
        return arg;
    }
    std::wstring out = L"\"";
    for (wchar_t c : arg) {
        if (c == L'"') {
            out += L"\\\"";
        } else {
            out += c;
        }
    }
    out += L"\"";
    return out;
}

/**
 * 组装命令行。
 * .cmd/.bat 必须经 cmd.exe /c 执行,CreateProcessW 无法直接运行批处理。
 */
std::wstring BuildCommandLine(const std::wstring& exe,
                              const std::vector<std::string>& args,
                              bool* needCmdWrapper) {
    std::wstring resolved;
    if (!ResolveExecutable(exe, &resolved)) {
        *needCmdWrapper = false;
        return L"";
    }

    bool isBatch = false;
    size_t dot = resolved.find_last_of(L'.');
    if (dot != std::wstring::npos) {
        std::wstring ext = resolved.substr(dot);
        std::wstring lower;
        for (wchar_t c : ext) {
            lower += (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
        }
        isBatch = (lower == L".cmd" || lower == L".bat");
    }

    std::wstring line;
    if (isBatch) {
        *needCmdWrapper = true;
        line = L"cmd.exe /d /s /c \"";
        line += QuoteArg(resolved);
        for (const auto& a : args) {
            line += L" ";
            line += QuoteArg(wideFromUtf8(a.c_str()));
        }
        line += L"\"";
    } else {
        *needCmdWrapper = false;
        line = QuoteArg(resolved);
        for (const auto& a : args) {
            line += L" ";
            line += QuoteArg(wideFromUtf8(a.c_str()));
        }
    }
    return line;
}

/**
 * 从管道读出至多 limit 字节,追加到 buf。
 * 返回 false 表示管道已关闭(EOF)。
 */
bool DrainPipe(HANDLE h, std::string* buf, size_t limit, bool* truncated) {
    char chunk[8192];
    while (true) {
        DWORD n = 0;
        if (!::ReadFile(h, chunk, sizeof(chunk), &n, nullptr)) {
            return false;
        }
        if (n == 0) {
            return false;  // EOF
        }
        size_t remaining = (buf->size() < limit) ? (limit - buf->size()) : 0;
        size_t take = (static_cast<size_t>(n) < remaining) ? static_cast<size_t>(n) : remaining;
        if (take > 0) {
            buf->append(chunk, take);
        }
        if (static_cast<size_t>(n) > remaining) {
            *truncated = true;
        }
    }
}

/**
 * 取 UTF-8 序列在起始字节处声明的字符长度。
 * 0x00-0x7F 为 1 字节 ASCII;0xC0-0xDF 为 2 字节;0xE0-0xEF 为 3 字节;0xF0-0xF7 为 4 字节。
 * 与 macOS 版 RocXBridgeCommand.mm 的 Utf8CharLength 保持一致。
 */
size_t Utf8CharLength(unsigned char lead) {
    if (lead < 0x80) {
        return 1;  // ASCII
    }
    if ((lead & 0xE0) == 0xC0) {
        return 2;
    }
    if ((lead & 0xF0) == 0xE0) {
        return 3;
    }
    if ((lead & 0xF8) == 0xF0) {
        return 4;
    }
    return 1;  // 非法起始字节,按单字节处理
}

/** 按完整 UTF-8 字符边界截断 */
void TrimToUtf8Boundary(std::string* s) {
    if (s->empty()) {
        return;
    }
    size_t i = 0;
    while (i < 4 && i < s->size()) {
        unsigned char c = static_cast<unsigned char>((*s)[s->size() - 1 - i]);
        if ((c & 0xC0) == 0x80) {
            ++i;
            continue;
        }
        // i 是已扫描的续字节数,起始字节本身还要占 expected 字节,
        // 整个字符共 expected 字节,已保留的完整字符需要砍掉 i 个续字节。
        size_t expected = Utf8CharLength(c);
        if (i + 1 < expected) {
            s->resize(s->size() - i);
        }
        return;
    }
    if (i >= 4) {
        s->resize(s->size() - 3);
    }
}

}  // namespace

CommandResult RunCommandForPlatform(const std::string& exe,
                                    const std::vector<std::string>& args,
                                    const std::string& cwd,
                                    int timeoutMs) {
    CommandResult result;

    if (exe.empty()) {
        result.error = "empty exe path";
        return result;
    }

    bool needCmdWrapper = false;
    std::wstring cmdLine = BuildCommandLine(wideFromUtf8(exe.c_str()), args, &needCmdWrapper);
    if (cmdLine.empty()) {
        result.error = "executable not found";
        return result;
    }

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = nullptr;
    sa.bInheritHandle = TRUE;

    HANDLE outRead = nullptr;
    HANDLE outWrite = nullptr;
    HANDLE errRead = nullptr;
    HANDLE errWrite = nullptr;

    if (!::CreatePipe(&outRead, &outWrite, &sa, 0)) {
        result.error = "pipe failed";
        return result;
    }
    if (!::CreatePipe(&errRead, &errWrite, &sa, 0)) {
        ::CloseHandle(outRead);
        ::CloseHandle(outWrite);
        result.error = "pipe failed";
        return result;
    }

    // 读端不可继承,否则子进程退出后父进程仍收不到 EOF
    ::SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    ::SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si;
    ::ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = outWrite;
    si.hStdError = errWrite;
    si.hStdInput = ::GetStdHandle(STD_INPUT_HANDLE);

    PROCESS_INFORMATION pi;
    ::ZeroMemory(&pi, sizeof(pi));

    std::wstring cwdWide = cwd.empty() ? std::wstring() : wideFromUtf8(cwd.c_str());
    std::vector<wchar_t> mutableLine(cmdLine.begin(), cmdLine.end());
    mutableLine.push_back(L'\0');

    BOOL created = ::CreateProcessW(
        nullptr,
        mutableLine.data(),
        nullptr,
        nullptr,
        TRUE,
        CREATE_NO_WINDOW,
        nullptr,
        cwdWide.empty() ? nullptr : cwdWide.c_str(),
        &si,
        &pi);

    // 父进程关掉写端
    ::CloseHandle(outWrite);
    ::CloseHandle(errWrite);

    if (!created) {
        ::CloseHandle(outRead);
        ::CloseHandle(errRead);
        result.error = "spawn failed";
        return result;
    }

    // 管道读端由下面的 PeekNamedPipe 轮询实现超时,无需 SetNamedPipeHandleState
    // (该 API 只对命名管道有效,CreatePipe 创建的是匿名管道)

    bool outOpen = true;
    bool errOpen = true;
    bool timedOut = false;
    int elapsedMs = 0;

    while (outOpen || errOpen) {
        if (outOpen) {
            DWORD avail = 0;
            if (::PeekNamedPipe(outRead, nullptr, 0, nullptr, &avail, nullptr)) {
                if (avail > 0) {
                    DrainPipe(outRead, &result.out, kMaxOutputBytes, &result.truncated);
                } else if (::WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) {
                    // 进程已退出,把剩余数据读干净
                    DrainPipe(outRead, &result.out, kMaxOutputBytes, &result.truncated);
                    outOpen = false;
                }
            } else {
                outOpen = false;
            }
        }
        if (errOpen) {
            DWORD avail = 0;
            if (::PeekNamedPipe(errRead, nullptr, 0, nullptr, &avail, nullptr)) {
                if (avail > 0) {
                    DrainPipe(errRead, &result.err, kMaxOutputBytes, &result.truncated);
                } else if (::WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) {
                    DrainPipe(errRead, &result.err, kMaxOutputBytes, &result.truncated);
                    errOpen = false;
                }
            } else {
                errOpen = false;
            }
        }

        if (!outOpen && !errOpen) {
            break;
        }

        if (timeoutMs > 0) {
            elapsedMs += 50;
            if (elapsedMs >= timeoutMs) {
                timedOut = true;
                break;
            }
        }
        ::Sleep(20);
    }

    if (timedOut) {
        ::TerminateProcess(pi.hProcess, 1);
        ::WaitForSingleObject(pi.hProcess, 5000);
        result.ok = false;
        result.exitCode = -1;
        result.error = "timeout";
    } else {
        ::WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD code = 0;
        if (::GetExitCodeProcess(pi.hProcess, &code)) {
            result.exitCode = static_cast<int>(code);
        }
        result.ok = (result.exitCode == 0);
        if (!result.ok && result.error.empty()) {
            result.error = "non-zero exit";
        }
    }

    // 清理句柄(既有 ShellExecuteExW 路径遗留的句柄泄漏,这里不重蹈)
    ::CloseHandle(outRead);
    ::CloseHandle(errRead);
    ::CloseHandle(pi.hThread);
    ::CloseHandle(pi.hProcess);

    TrimToUtf8Boundary(&result.out);
    TrimToUtf8Boundary(&result.err);
    return result;
}
