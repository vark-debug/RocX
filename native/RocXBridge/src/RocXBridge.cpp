/*
 * RocXBridge.cpp — Adobe UXP Hybrid Plugin 入口
 *
 * 职责:把 platform 层结果 (OpenFileResult / CommandResult) 包成 JS 对象返回给 UXP 侧。
 * 所有 addon_apis 调用都必须经过 try/catch,entry point 不得抛异常穿透到 V8。
 *
 * Apache 2.0
 */
#include "RocXBridge.h"

#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

/** 从 addon_value 读出 UTF-8 字符串;类型不符返回空串 */
std::string GetStringFromValue(addon_env env, addon_value value) {
    size_t len = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, value, nullptr, 0, &len) != addon_ok) {
        return std::string();
    }
    std::vector<char> buf(len + 1);
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, value, buf.data(), buf.size(), &len) !=
        addon_ok) {
        return std::string();
    }
    return std::string(buf.data(), len);
}

/** 构造 { ok: boolean, error?: string } */
addon_value MakeResult(addon_env env, const OpenFileResult& r) {
    addon_value obj = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &obj));

    addon_value okVal = nullptr;
    Check(UxpAddonApis.uxp_addon_get_boolean(env, r.ok, &okVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "ok", okVal));

    if (!r.error.empty()) {
        addon_value errVal = nullptr;
        Check(UxpAddonApis.uxp_addon_create_string_utf8(env, r.error.c_str(), r.error.size(), &errVal));
        Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "error", errVal));
    }
    return obj;
}

/** 读出 int32 属性;不存在或类型不符返回默认值 */
int32_t GetInt32Prop(addon_env env, addon_value obj, const char* name, int32_t fallback) {
    addon_value v = nullptr;
    if (UxpAddonApis.uxp_addon_get_named_property(env, obj, name, &v) != addon_ok || v == nullptr) {
        return fallback;
    }
    int32_t out = fallback;
    if (UxpAddonApis.uxp_addon_get_value_int32(env, v, &out) != addon_ok) {
        return fallback;
    }
    return out;
}

/** 读出字符串属性;不存在时返回空串 */
std::string GetStringProp(addon_env env, addon_value obj, const char* name) {
    addon_value v = nullptr;
    if (UxpAddonApis.uxp_addon_get_named_property(env, obj, name, &v) != addon_ok || v == nullptr) {
        return std::string();
    }
    return GetStringFromValue(env, v);
}

/** 读出字符串数组属性;不存在时返回空 vector */
std::vector<std::string> GetStringArrayProp(addon_env env, addon_value obj, const char* name) {
    std::vector<std::string> out;
    addon_value v = nullptr;
    if (UxpAddonApis.uxp_addon_get_named_property(env, obj, name, &v) != addon_ok || v == nullptr) {
        return out;
    }
    bool isArray = false;
    if (UxpAddonApis.uxp_addon_is_array(env, v, &isArray) != addon_ok || !isArray) {
        return out;
    }
    uint32_t len = 0;
    if (UxpAddonApis.uxp_addon_get_array_length(env, v, &len) != addon_ok) {
        return out;
    }
    for (uint32_t i = 0; i < len; ++i) {
        addon_value item = nullptr;
        if (UxpAddonApis.uxp_addon_get_element(env, v, i, &item) != addon_ok || item == nullptr) {
            continue;
        }
        out.push_back(GetStringFromValue(env, item));
    }
    return out;
}

/** 构造命令执行结果对象 */
addon_value MakeCommandResult(addon_env env, const CommandResult& r) {
    addon_value obj = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &obj));

    addon_value okVal = nullptr;
    Check(UxpAddonApis.uxp_addon_get_boolean(env, r.ok, &okVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "ok", okVal));

    addon_value codeVal = nullptr;
    Check(UxpAddonApis.uxp_addon_create_int32(env, static_cast<int32_t>(r.exitCode), &codeVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "exitCode", codeVal));

    addon_value outVal = nullptr;
    Check(UxpAddonApis.uxp_addon_create_string_utf8(env, r.out.c_str(), r.out.size(), &outVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "out", outVal));

    addon_value errVal = nullptr;
    Check(UxpAddonApis.uxp_addon_create_string_utf8(env, r.err.c_str(), r.err.size(), &errVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "err", errVal));

    addon_value truncVal = nullptr;
    Check(UxpAddonApis.uxp_addon_get_boolean(env, r.truncated, &truncVal));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "truncated", truncVal));

    if (!r.error.empty()) {
        addon_value errorVal = nullptr;
        Check(UxpAddonApis.uxp_addon_create_string_utf8(env, r.error.c_str(), r.error.size(), &errorVal));
        Check(UxpAddonApis.uxp_addon_set_named_property(env, obj, "error", errorVal));
    }
    return obj;
}

/**
 * runCommand 的异步任务上下文。
 *
 * 进程执行放到后台线程(不能阻塞 JS 线程 —— addon_callback 跑在 JS 线程上,
 * 同步 waitpid 会让 PR 面板卡死);结束后通过 schedule_on_javascript_queue
 * 回到 JS 线程 resolve Promise。
 *
 * 生命周期:由 schedule_on_javascript_queue 的 deleter 负责释放,
 * 任务回调本身不持有所有权。
 */
struct RunCommandTask {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    CommandResult result;
};

/** 回到 JS 线程后 resolve Promise */
void ResolveRunCommandTask(addon_task_data data) {
    RunCommandTask* task = static_cast<RunCommandTask*>(data);
    if (task == nullptr) {
        return;
    }
    try {
        HandlerScope scope(task->env);
        addon_value obj = MakeCommandResult(task->env, task->result);
        UxpAddonApis.uxp_addon_resolve_deferred(task->env, task->deferred, obj);
    } catch (...) {
        // resolve 失败也不能让异常穿透到 V8;Promise 会保持 pending。
        std::fprintf(stderr, "[RocXBridge] failed to resolve runCommand promise\n");
    }
}

}  // namespace

addon_value OpenFileInPhotoshopImpl(addon_env env, addon_callback_info info) {
    try {
        addon_value arg = nullptr;
        size_t argc = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));

        if (argc < 1 || arg == nullptr) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "openFileInPhotoshop: missing path argument");
            return nullptr;
        }

        std::string path = GetStringFromValue(env, arg);
        if (path.empty()) {
            return MakeResult(env, OpenFileResult{false, "empty path"});
        }
        return MakeResult(env, OpenFileInPhotoshopForPlatform(path.c_str()));
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value RunCommandImpl(addon_env env, addon_callback_info info) {
    try {
        addon_value arg = nullptr;
        size_t argc = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));

        if (argc < 1 || arg == nullptr) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "runCommand: missing options argument");
            return nullptr;
        }

        std::string exe = GetStringProp(env, arg, "exe");
        std::vector<std::string> args = GetStringArrayProp(env, arg, "args");
        std::string cwd = GetStringProp(env, arg, "cwd");
        int32_t timeoutMs = GetInt32Prop(env, arg, "timeoutMs", 30000);

        if (exe.empty()) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "runCommand: missing exe path");
            return nullptr;
        }

        // 建 Promise,立即返回;真正的进程执行放后台线程
        addon_deferred deferred = nullptr;
        addon_value promise = nullptr;
        Check(UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promise));

        auto task = std::unique_ptr<RunCommandTask>(new RunCommandTask());
        task->env = env;
        task->deferred = deferred;

        RunCommandTask* raw = task.release();
        std::thread([raw, exe, args, cwd, timeoutMs]() {
            raw->result = RunCommandForPlatform(exe, args, cwd, timeoutMs);
            // deleter 负责释放 raw,任务回调不持有所有权
            UxpAddonApis.uxp_addon_schedule_on_javascript_queue(raw->env, ResolveRunCommandTask, raw,
                                                               [](addon_task_data d) {
                                                                   delete static_cast<RunCommandTask*>(d);
                                                               });
        }).detach();

        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value RocXBridgeInit(addon_env env, addon_value exports, const addon_apis& addonAPIs) {
    addon_value fn = nullptr;

    if (addonAPIs.uxp_addon_create_function(env, nullptr, 0, OpenFileInPhotoshopImpl, nullptr, &fn) !=
        addon_ok) {
        addonAPIs.uxp_addon_throw_error(env, nullptr, "RocXBridge: failed to wrap openFileInPhotoshop");
        return exports;
    }
    if (addonAPIs.uxp_addon_set_named_property(env, exports, "openFileInPhotoshop", fn) != addon_ok) {
        addonAPIs.uxp_addon_throw_error(env, nullptr, "RocXBridge: failed to populate exports");
        return exports;
    }

    addon_value cmdFn = nullptr;
    if (addonAPIs.uxp_addon_create_function(env, nullptr, 0, RunCommandImpl, nullptr, &cmdFn) !=
        addon_ok) {
        addonAPIs.uxp_addon_throw_error(env, nullptr, "RocXBridge: failed to wrap runCommand");
        return exports;
    }
    if (addonAPIs.uxp_addon_set_named_property(env, exports, "runCommand", cmdFn) != addon_ok) {
        addonAPIs.uxp_addon_throw_error(env, nullptr, "RocXBridge: failed to populate exports");
        return exports;
    }

    std::fprintf(stderr, "[RocXBridge] init ok, openFileInPhotoshop + runCommand registered\n");
    return exports;
}

void RocXBridgeTerminate(addon_env env) {
    (void)env;
    std::fprintf(stderr, "[RocXBridge] terminate\n");
}

UXP_ADDON_INIT(RocXBridgeInit)
UXP_ADDON_TERMINATE(RocXBridgeTerminate)
