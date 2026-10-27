/*
 * RocXBridgeCommand.mm — macOS 命令执行
 *
 * 用 posix_spawn + pipe() 执行命令并捕获 stdout/stderr。
 * 不用 NSWorkspace/ShellExecuteEx 那套"只启动不捕获"的路径 —— 那套无法拿到输出。
 *
 * Apache 2.0
 */
#import <Foundation/Foundation.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include <string>
#include <vector>

#include "RocXBridge.h"

extern char** environ;

namespace {

/** stdout/stderr 各自的上限(字节) */
constexpr size_t kMaxOutputBytes = 256 * 1024;

/** 管道读取的轮询间隔(毫秒) */
constexpr int kPollIntervalMs = 50;

/**
 * 从管道读出至多 limit 字节,追加到 buf。
 *
 * 返回值语义:
 *   false = 管道已真正关闭(EOF / 读错误),调用方不应再读
 *   true  = 暂时无更多数据(EAGAIN),管道仍开着,调用方应继续等
 *
 * 注意:非阻塞读遇到 EAGAIN 时**不能**当成 EOF —— 那会导致大输出被截在
 * 管道缓冲区大小(通常 64KB)处。
 */
bool DrainPipe(int fd, std::string* buf, size_t limit, bool* truncated) {
    char chunk[8192];
    while (true) {
        ssize_t n = ::read(fd, chunk, sizeof(chunk));
        if (n > 0) {
            size_t remaining = (buf->size() < limit) ? (limit - buf->size()) : 0;
            size_t take = (static_cast<size_t>(n) < remaining) ? static_cast<size_t>(n) : remaining;
            if (take > 0) {
                buf->append(chunk, take);
            }
            if (static_cast<size_t>(n) > remaining) {
                *truncated = true;
            }
            continue;
        }
        if (n == 0) {
            return false;  // 真 EOF
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return true;  // 暂时没数据,管道还开着
        }
        return false;  // 真错误
    }
}

/**
 * 阻塞读完管道剩余内容。
 * 用于子进程已退出后的收尾 —— 此时把读端切回阻塞模式,
 * 确保缓冲区里残留的数据一条不丢。
 */
void DrainPipeBlocking(int fd, std::string* buf, size_t limit, bool* truncated) {
    char chunk[8192];
    while (true) {
        ssize_t n = ::read(fd, chunk, sizeof(chunk));
        if (n > 0) {
            size_t remaining = (buf->size() < limit) ? (limit - buf->size()) : 0;
            size_t take = (static_cast<size_t>(n) < remaining) ? static_cast<size_t>(n) : remaining;
            if (take > 0) {
                buf->append(chunk, take);
            }
            if (static_cast<size_t>(n) > remaining) {
                *truncated = true;
            }
            continue;
        }
        if (n == 0) {
            return;  // EOF
        }
        if (errno == EINTR) {
            continue;
        }
        return;
    }
}

/**
 * 取 UTF-8 序列在起始字节处声明的字符长度。
 * 0x00-0x7F 为 1 字节 ASCII;0xC0-0xDF 为 2 字节;0xE0-0xEF 为 3 字节;0xF0-0xF7 为 4 字节。
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

/**
 * 按完整 UTF-8 字符边界截断,避免把一个多字节字符切成非法序列。
 *
 * 从尾部往回找最后一个字符的**起始字节**(非续字节 0b10xxxxxx),
 * 再按它声明的长度判断该字符是否完整;不完整则砍掉整个字符。
 */
void TrimToUtf8Boundary(std::string* s) {
    if (s->empty()) {
        return;
    }
    // 从尾部往回最多找 4 个字节(UTF-8 单字符最长 4 字节)
    for (size_t back = 1; back <= 4 && back <= s->size(); ++back) {
        unsigned char c = static_cast<unsigned char>((*s)[s->size() - back]);
        if ((c & 0xC0) == 0x80) {
            continue;  // 续字节,继续往前找
        }
        // c 是起始字节:已扫过的 back 字节 = 起始字节 + (back-1) 个续字节
        size_t charLen = Utf8CharLength(c);
        if (back < charLen) {
            // 字符不完整(被截断),砍掉整个残缺字符
            s->resize(s->size() - back);
        }
        return;
    }
    // 连续 4 个字节都是续字节:非法序列,砍掉末尾
    if (s->size() >= 4) {
        s->resize(s->size() - 4);
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

    int outPipe[2] = {-1, -1};
    int errPipe[2] = {-1, -1};
    if (::pipe(outPipe) != 0) {
        result.error = "pipe failed";
        return result;
    }
    if (::pipe(errPipe) != 0) {
        ::close(outPipe[0]);
        ::close(outPipe[1]);
        result.error = "pipe failed";
        return result;
    }

    // 组装 argv:argv[0] 用 exe 本身
    std::vector<char*> argv;
    argv.reserve(args.size() + 1);
    std::string exeCopy = exe;
    argv.push_back(const_cast<char*>(exeCopy.c_str()));
    std::vector<std::string> argCopy = args;
    for (auto& a : argCopy) {
        argv.push_back(const_cast<char*>(a.c_str()));
    }
    argv.push_back(nullptr);

    posix_spawn_file_actions_t fileActions;
    ::posix_spawn_file_actions_init(&fileActions);
    ::posix_spawn_file_actions_adddup2(&fileActions, outPipe[1], STDOUT_FILENO);
    ::posix_spawn_file_actions_adddup2(&fileActions, errPipe[1], STDERR_FILENO);
    // 关闭子进程里的管道读端,否则父进程读不到 EOF
    ::posix_spawn_file_actions_addclose(&fileActions, outPipe[0]);
    ::posix_spawn_file_actions_addclose(&fileActions, errPipe[0]);

    posix_spawnattr_t spawnAttrs;
    ::posix_spawnattr_init(&spawnAttrs);
    if (!cwd.empty()) {
        // chdir 只影响子进程;posix_spawn 没有直接的工作目录参数,
        // 这里用 file_actions 的 chdir 动作(Apple 扩展)。
        ::posix_spawn_file_actions_addchdir_np(&fileActions, cwd.c_str());
    }

    pid_t pid = 0;
    int spawnRc = ::posix_spawn(&pid, exe.c_str(), &fileActions, &spawnAttrs, argv.data(), environ);

    ::posix_spawnattr_destroy(&spawnAttrs);
    ::posix_spawn_file_actions_destroy(&fileActions);

    // 父进程关掉写端,否则读端永远等不到 EOF
    ::close(outPipe[1]);
    ::close(errPipe[1]);

    if (spawnRc != 0) {
        ::close(outPipe[0]);
        ::close(errPipe[0]);
        result.error = "spawn failed";
        return result;
    }

    // 非阻塞读,轮询等两个管道都结束
    ::fcntl(outPipe[0], F_SETFL, O_NONBLOCK);
    ::fcntl(errPipe[0], F_SETFL, O_NONBLOCK);

    bool outOpen = true;
    bool errOpen = true;
    bool timedOut = false;
    int elapsedMs = 0;

    while (outOpen || errOpen) {
        struct pollfd fds[2];
        int nfds = 0;
        int outIdx = -1;
        int errIdx = -1;
        if (outOpen) {
            outIdx = nfds;
            fds[nfds].fd = outPipe[0];
            fds[nfds].events = POLLIN;
            fds[nfds].revents = 0;
            ++nfds;
        }
        if (errOpen) {
            errIdx = nfds;
            fds[nfds].fd = errPipe[0];
            fds[nfds].events = POLLIN;
            fds[nfds].revents = 0;
            ++nfds;
        }

        int ready = ::poll(fds, static_cast<nfds_t>(nfds), kPollIntervalMs);
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }

        if (ready > 0) {
            if (outIdx >= 0 && (fds[outIdx].revents & (POLLIN | POLLHUP | POLLERR))) {
                // DrainPipe 返回 false 才代表管道真正关闭
                if (!DrainPipe(outPipe[0], &result.out, kMaxOutputBytes, &result.truncated)) {
                    outOpen = false;
                }
            }
            if (errIdx >= 0 && (fds[errIdx].revents & (POLLIN | POLLHUP | POLLERR))) {
                if (!DrainPipe(errPipe[0], &result.err, kMaxOutputBytes, &result.truncated)) {
                    errOpen = false;
                }
            }
        }

        // 检查子进程是否已退出 + 管道是否都关了
        if (outOpen || errOpen) {
            int status = 0;
            pid_t w = ::waitpid(pid, &status, WNOHANG);
            if (w == pid) {
                // 子进程已退出:切回阻塞模式,把管道里剩余的数据一条不剩读干净
                ::fcntl(outPipe[0], F_SETFL, 0);
                ::fcntl(errPipe[0], F_SETFL, 0);
                if (outOpen) {
                    DrainPipeBlocking(outPipe[0], &result.out, kMaxOutputBytes, &result.truncated);
                    outOpen = false;
                }
                if (errOpen) {
                    DrainPipeBlocking(errPipe[0], &result.err, kMaxOutputBytes, &result.truncated);
                    errOpen = false;
                }
                break;
            }
        }

        if (timeoutMs > 0) {
            elapsedMs += kPollIntervalMs;
            if (elapsedMs >= timeoutMs) {
                timedOut = true;
                break;
            }
        }
    }

    if (timedOut) {
        ::kill(pid, SIGKILL);
        int status = 0;
        ::waitpid(pid, &status, 0);
        result.ok = false;
        result.exitCode = -1;
        result.error = "timeout";
        TrimToUtf8Boundary(&result.out);
        TrimToUtf8Boundary(&result.err);
        ::close(outPipe[0]);
        ::close(errPipe[0]);
        return result;
    }

    ::close(outPipe[0]);
    ::close(errPipe[0]);

    // 等子进程彻底退出,取 exit code
    int status = 0;
    while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }

    TrimToUtf8Boundary(&result.out);
    TrimToUtf8Boundary(&result.err);

    result.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    result.ok = (result.exitCode == 0);
    if (!result.ok && result.error.empty()) {
        result.error = "non-zero exit";
    }
    return result;
}
