#!/bin/bash
# launcher.command — RocX 抓帧→PS 启动器 (macOS)
#
# 由 UXP `shell.openPath` 启动（manifest 已加 .command 到 launchProcess.extensions 白名单）。
# UXP 不支持传参,args JSON 由 UXP 端写到 pluginDataFolder;
# macOS 上 pluginDataFolder 真实路径形如:
#   $HOME/Library/Application Support/Adobe/UXP/PluginsStorage/PPRO/<ver>/Developer/<pluginId>/PluginData
# 注意中间有 Adobe/ 一层,且目录名带 PR 版本号(Developer/External 由安装方式决定),
# 所以这里用 find 在 UXP 根目录下递归搜,不硬编码层级。

PLUGIN_ID="com.rocx.uxp"

# 调试日志：UXP shell.openPath 启动的进程没有 stdout，落盘到 /tmp 供实机排查
ROCX_LOG="/tmp/rocx-launcher.log"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$ROCX_LOG"; }
log "--- launcher.command 启动 (pid=$$) ---"

# macOS 打开 .command 必然拉起 Terminal.app 窗口，本脚本结束后要把它关掉。
#
# 注意不能用 `trap ... EXIT` 直接关窗：trap 执行时脚本自身尚未退出，Terminal 认为
# 窗口里还有进程在跑，close 会弹「是否终止正在运行的进程」确认框。
# 正确做法是派一个脱离父进程的后台小进程，等本脚本的 shell 真正退出后再关窗 ——
# 此时窗口内无运行中进程，Terminal 会静默关闭。
#
# TERM_PROGRAM 由 Terminal 注入，仅在 Terminal 环境下非空，用于避免在普通终端
# 手动调试时误关用户自己的窗口。
TERM_WIN_ID=""
if [ -n "${TERM_PROGRAM:-}" ]; then
    TERM_WIN_ID=$(osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null || echo "")
fi
if [ -n "$TERM_WIN_ID" ]; then
    # $$ 就是终端窗口里的那个进程本身（Terminal 直接 exec .command，不套额外 shell），
    # 所以等 $$ 退出即代表窗口内已无运行中进程。不能等 $PPID，那是 Terminal 自身，永不退出。
    nohup bash -c '
        while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
        sleep 0.3
        osascript -e "tell application \"Terminal\" to close (every window whose id is $2)" >/dev/null 2>&1
    ' _ "$$" "$TERM_WIN_ID" >/dev/null 2>&1 &
    disown 2>/dev/null || true
    log "已安排后台关窗 (脚本 pid=$$, window id=$TERM_WIN_ID)"
fi

# 1) 定位 args JSON（取 mtime 最新的一个，PR 可能同时留有多版本目录）
UXP_ROOT="$HOME/Library/Application Support/Adobe/UXP"
ARGS_FILE=$(find "$UXP_ROOT" -name "rocx-launcher-args.json" -type f 2>/dev/null \
    | while read -r f; do echo "$(stat -f %m "$f") $f"; done \
    | sort -rn | head -n 1 | cut -d' ' -f2-)
log "搜索根目录: $UXP_ROOT"

if [ -z "$ARGS_FILE" ] || [ ! -f "$ARGS_FILE" ]; then
    log "❌ 未找到 rocx-launcher-args.json，退出"
    exit 0
fi
log "✅ 命中 args JSON: $ARGS_FILE"

# 2) 读取 args JSON
# 用 sed 抠 path 字段，不依赖 python3（GUI 环境下 PATH 常常没有 python3）
ARGS_JSON=$(cat "$ARGS_FILE")
log "args JSON 原文: $ARGS_JSON"
IMAGE_PATH=$(printf '%s' "$ARGS_JSON" \
    | sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
log "解析到图片路径: $IMAGE_PATH"

# 消费后立即删除,防重复启动
rm -f "$ARGS_FILE" 2>/dev/null || true

if [ -z "$IMAGE_PATH" ] || [ ! -f "$IMAGE_PATH" ]; then
    log "❌ 图片路径无效或文件不存在，退出"
    exit 0
fi

# 3) mdfind 优先
PS_APP=$(mdfind 'kMDItemCFBundleIdentifier == "com.adobe.Photoshop"' 2>/dev/null | head -n 1)
log "mdfind 结果: ${PS_APP:-<空>}"

# 4) glob 兜底
if [ -z "$PS_APP" ] || [ ! -d "$PS_APP" ]; then
    PS_APP=$(ls -d /Applications/Adobe\ Photoshop*/Photoshop.app 2>/dev/null | head -n 1)
    log "glob 兜底结果: ${PS_APP:-<空>}"
fi

# 5) 启动
if [ -n "$PS_APP" ] && [ -d "$PS_APP" ]; then
    if open -a "$PS_APP" "$IMAGE_PATH" 2>>"$ROCX_LOG"; then
        log "✅ 已启动 PS: $PS_APP"
    else
        log "❌ open 启动失败: $PS_APP"
    fi
else
    log "❌ 未定位到 Photoshop.app，退出"
fi

exit 0
