#!/bin/bash
# runCommand 平台层独立测试(不依赖 UXP 宿主)
#
# 平台实现文件 include 了 RocXBridge.h(为了 CommandResult 结构),
# 而 RocXBridge.h 又 include 了 UXP SDK 的 UxpAddon.h。
# 测试只需要 CommandResult,不需要 UXP SDK,所以先用 stub 头文件占位。
set -e
cd "$(dirname "$0")"

STUB_DIR="$(pwd)/.stub"
mkdir -p "$STUB_DIR"

cat > "$STUB_DIR/UxpAddon.h" <<'EOF'
// 测试桩:仅满足 RocXBridge.h 的 include 需求
#pragma once
#include "uxp_stub_types.h"
EOF

cat > "$STUB_DIR/uxp_stub_types.h" <<'EOF'
// 测试桩:addon_value 等类型占位
#pragma once
typedef void* addon_value;
typedef void* addon_env;
typedef void* addon_callback_info;
typedef void* addon_deferred;
struct addon_apis { int dummy; };
inline void Check(int) {}
EOF

# stub 目录优先于真实 SDK 路径
clang++ -std=c++17 -O0 -g -fobjc-arc \
  -I "$STUB_DIR" -I "../src" \
  -framework Foundation \
  runCommandTest.mm \
  -o runCommandTest

./runCommandTest
