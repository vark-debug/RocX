/*
 * RocXBridge.cpp — Adobe UXP Hybrid Plugin 入口
 *
 * 职责:把 platform 层结果 (OpenFileResult) 包成 JS 对象返回给 UXP 侧。
 * 所有 addon_apis 调用都必须经过 try/catch,entry point 不得抛异常穿透到 V8。
 *
 * Apache 2.0
 */
#include "RocXBridge.h"

#include <cstdio>
#include <string>
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

    std::fprintf(stderr, "[RocXBridge] init ok, openFileInPhotoshop registered\n");
    return exports;
}

void RocXBridgeTerminate(addon_env env) {
    (void)env;
    std::fprintf(stderr, "[RocXBridge] terminate\n");
}

UXP_ADDON_INIT(RocXBridgeInit)
UXP_ADDON_TERMINATE(RocXBridgeTerminate)
