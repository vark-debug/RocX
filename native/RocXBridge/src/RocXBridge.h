/*
 * RocXBridge.h — Adobe UXP Hybrid Plugin addon 公共接口
 *
 * 对外导出两个 native function:
 *   - openFileInPhotoshop(path):用指定应用打开图片
 *   - runCommand(opts):执行命令并捕获 stdout/stderr
 * 平台特定实现见 RocXBridgeMac.mm / RocXBridgeWin.cpp / RocXBridgeCommand*.{mm,cpp}
 *
 * Apache 2.0
 */
#ifndef ROCX_BRIDGE_H
#define ROCX_BRIDGE_H

#include <string>
#include <vector>

#include "UxpAddon.h"

/** 平台层执行结果 */
struct OpenFileResult {
    bool ok = false;
    std::string error;  // ok=false 时填人类可读原因
};

/** 命令执行结果 */
struct CommandResult {
    bool ok = false;
    int exitCode = -1;
    std::string out;       // stdout
    std::string err;       // stderr
    std::string error;     // ok=false 时填人类可读原因(如 "timeout" / "spawn failed")
    bool truncated = false;  // 输出超过上限被截断
};

/**
 * 平台分发:用指定应用打开图片文件
 * - macOS:NSWorkspace + bundle id "com.adobe.Photoshop",不依赖系统 jpg 默认关联
 * - Windows:注册表扫描 Photoshop\ApplicationPath + ShellExecuteExW
 *
 * @param utf8Path 文件绝对路径(UTF-8,非 null 结尾由调用方保证)
 */
OpenFileResult OpenFileInPhotoshopForPlatform(const char* utf8Path);

/**
 * 平台分发:执行命令并捕获输出
 * - macOS:posix_spawn + pipe()
 * - Windows:CreateProcessW + CreatePipe()
 *
 * @param exe 可执行文件绝对路径
 * @param args 参数列表(不含 argv[0])
 * @param cwd 工作目录,空字符串表示不切换
 * @param timeoutMs 超时毫秒数,<=0 表示不超时
 */
CommandResult RunCommandForPlatform(const std::string& exe,
                                    const std::vector<std::string>& args,
                                    const std::string& cwd,
                                    int timeoutMs);

/**
 * exports.openFileInPhotoshop 的 C++ 实现(JS 线程调用)
 * 入参:本地文件绝对路径字符串;返回 { ok: boolean, error?: string }
 */
addon_value OpenFileInPhotoshopImpl(addon_env env, addon_callback_info info);

/**
 * exports.runCommand 的 C++ 实现(JS 线程调用)
 * 入参:{ exe: string, args?: string[], cwd?: string, timeoutMs?: number }
 * 返回:Promise<{ ok, exitCode, out, err, error?, truncated }>
 */
addon_value RunCommandImpl(addon_env env, addon_callback_info info);

/**
 * addon init 入口 — 把 openFileInPhotoshop / runCommand 挂到 exports 后返回 exports
 * 签名必须为 (addon_env, addon_value, const addon_apis&),由 UXP_ADDON_INIT 宏展开调用
 */
addon_value RocXBridgeInit(addon_env env, addon_value exports, const addon_apis& addonAPIs);

/**
 * addon terminate 入口 — 签名必须为 (addon_env),由 UXP_ADDON_TERMINATE 宏展开调用
 */
void RocXBridgeTerminate(addon_env env);

#endif /* ROCX_BRIDGE_H */
