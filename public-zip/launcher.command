#!/bin/bash
# launcher.command — RocX 抓帧→PS 启动器 (macOS)
#
# 由 UXP `shell.openPath` 启动（manifest 已加 .command 到 launchProcess.extensions 白名单）。
# UXP 不支持传参,args JSON 由 UXP 端写到 pluginDataFolder;
# pluginDataFolder 真实路径形如:
#   $HOME/Library/Application Support/UXP/PluginsStorage/<app>/<ver>/Developer/<pluginId>/PluginData
# 路径包含 PR 版本号,本脚本用 glob 搜索所有可能的版本目录。

set -e

PLUGIN_ID="com.rocx.uxp"

# 1) 定位 args JSON
ARGS_FILE=""
for pattern in \
    "$HOME/Library/Application Support/UXP/PluginsStorage"/*/*/Developer/"$PLUGIN_ID"/PluginData/rocx-launcher-args.json \
    "$HOME/Library/Application Support/UXP/$PLUGIN_ID/rocx-launcher-args.json"
do
    # shellcheck disable=SC2086
    found=$(ls -t $pattern 2>/dev/null | head -n 1 || true)
    if [ -n "$found" ] && [ -f "$found" ]; then
        ARGS_FILE="$found"
        break
    fi
done

if [ -z "$ARGS_FILE" ]; then
    exit 0
fi

# 2) 读取 args JSON
ARGS_JSON=$(cat "$ARGS_FILE")
IMAGE_PATH=$(echo "$ARGS_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("path",""))')

# 消费后立即删除,防重复启动
rm -f "$ARGS_FILE" 2>/dev/null || true

if [ -z "$IMAGE_PATH" ] || [ ! -f "$IMAGE_PATH" ]; then
    exit 0
fi

# 3) mdfind 优先
PS_APP=$(mdfind 'kMDItemCFBundleIdentifier == "com.adobe.Photoshop"' 2>/dev/null | head -n 1)

# 4) glob 兜底
if [ -z "$PS_APP" ] || [ ! -d "$PS_APP" ]; then
    PS_APP=$(ls -d /Applications/Adobe\ Photoshop*/Photoshop.app 2>/dev/null | head -n 1)
fi

# 5) 启动
if [ -n "$PS_APP" ] && [ -d "$PS_APP" ]; then
    open -a "$PS_APP" "$IMAGE_PATH" 2>/dev/null || true
fi

exit 0
