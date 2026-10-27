// 测试桩:addon_value 等类型占位
#pragma once
typedef void* addon_value;
typedef void* addon_env;
typedef void* addon_callback_info;
typedef void* addon_deferred;
struct addon_apis { int dummy; };
inline void Check(int) {}
