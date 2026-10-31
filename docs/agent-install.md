# RocX · Agent 自动化安装指南（macOS）

> 目标读者：**执行安装的 AI Agent**（TraeCode / Claude Code / Cursor / opencode 等），以及写自动化脚本的人。
> 最终目标：**把与运行环境有关的一切（插件本体、依赖、登录）全部由 agent 干完，人只负责最后那一下「同意授权」。**
>
> 本文档所有路径、命令、目录结构均为**本机实测结论**（macOS 26.x / arm64 / Premiere Pro 26.5.0 / Adobe UXP 8.x）。
> 与项目内置的 [README](../README.md) 面向「最终用户手动安装」，两者分工不同。
>
> **目标机器 PR < 25.6（如 PR 2021），或没有 / 不想装 AME？** → 改装 CEP 版兄弟仓库 **[rocx-cep](https://github.com/vark-debug/rocx-cep)**，见下文「[CEP 版替代方案](#cep-版替代方案pr--256--免-ame)」章节（其可灵 CLI 步骤与本文 §3 / §4 完全通用）。

---

## 0. 一页速查

| # | 任务 | 自动化程度 | 需要人介入 | 本文档章节 |
|---|---|---|---|---|
| 1 | 装 RocX 插件本体 | ✅ 全自动 | 仅需**重启 PR** | [§2](#2-安装插件本体) |
| 2 | 装可灵 CLI（`@klingai/cli-cn`） | ✅ 全自动 | 无 | [§3](#3-安装可灵-cli) |
| 3 | 登录可灵 CLI | ⚠️ 半自动 | **浏览器点一次「同意」** | [§4](#4-登录可灵-cli) |
| 4 | 校验与收尾 | ✅ 全自动 | 无 | [§5](#5-校验与收尾) |

> **前置探测发现 PR < 25.6、或用户明确不想装 AME？** 别硬装 UXP 版 —— 改装 CEP 版兄弟仓库 [rocx-cep](https://github.com/vark-debug/rocx-cep)，见下文「CEP 版替代方案」章节。

**agent 的一句话职责**：跑完 §2 → §3 → §4 的命令，把 §4 里「请用户在浏览器里点同意」这句话转告用户，然后跑 §5 确认就绪。

**不需要 agent 管的**（已具备或超出范围）：

- API Key（MiniMax / RunningHub / 火山方舟）—— 用户自己在插件设置页填，agent 不碰
- 可灵账号密码 —— agent 不碰，只引导走 OAuth
- 抓视频依赖的 **Adobe Media Encoder (AME)** —— 第三方软件，需用户自行安装（[§6](#6-依赖与前置检查)）

---

## 1. 前置环境探测

先跑这一段，把结果记下来，后面每一步都要用。

```bash
# 1) macOS 架构（决定 addon 用哪个二进制）
uname -m                       # 期望: arm64 或 x86_64

# 2) Premiere Pro 是否安装 + 版本
ls -d /Applications/Adobe\ Premiere\ Pro*/Adobe\ Premiere\ Pro*.app 2>/dev/null
defaults read "$(ls -d /Applications/Adobe\ Premiere\ Pro*/Adobe\ Premiere\ Pro*.app | head -1)/Contents/Info.plist" CFBundleShortVersionString
# 最低要求 25.6.0（manifest host.minVersion）

# 3) Premiere Pro 是否正在运行（决定能不能立刻生效）
pgrep -f "Adobe Premiere Pro" >/dev/null && echo "运行中" || echo "未运行"

# 4) Adobe Media Encoder 是否安装（抓视频功能依赖）
ls -d /Applications/Adobe\ Media\ Encoder*/Adobe\ Media\ Encoder*.app 2>/dev/null

# 5) node 是否可用 + 版本（可灵 CLI 需要）
command -v node && node -v        # 最低 v18，实测 v24.18.0 可用

# 6) npm 全局 prefix 是否可写（决定装到哪）
npm prefix -g
[ -w "$(npm prefix -g)" ] && echo "可写" || echo "不可写 → 需改 prefix，见 §3.3"
```

**探测结论决定后续动作**：

| 探测结果 | 动作 |
|---|---|
| PR 未运行 | ✅ 最佳时机，装完插件直接让用户开 PR 即可生效 |
| PR 运行中 | 装完插件**必须重启 PR**（§2.4） |
| PR 版本 < 25.6.0 | ⛔ UXP 版无法加载（Hybrid addon 需要 PR 25.6+）→ **改装 CEP 版**（见下文「CEP 版替代方案」） |
| node 缺失 | 先装 node（[§6.2](#62-node-缺失)） |
| npm prefix 不可写 | 改用自定义 prefix（[§3.3](#33-prefix-不可写时的降级方案)） |
| AME 缺失 | 不阻塞安装；告知用户「抓视频功能不可用」，或建议改装 CEP 版（抓视频免 AME） |

---

## CEP 版替代方案（PR < 25.6 / 免 AME）

[rocx-cep](https://github.com/vark-debug/rocx-cep) 是本项目的 **CEP 架构兄弟仓库**。目标机器命中以下任一情况时，应改装它而不是继续走本文的 UXP 安装流程：

- **PR 版本低于 25.6** —— UXP 版的 Hybrid addon 装不上；CEP 版实测 **PR 2021（Windows）** 与 **PR 2026（macOS）**
- **没有 / 不想装 Adobe Media Encoder** —— CEP 版抓视频走 PR 内置导出管线，**无 AME 依赖**

当前能力边界：**仅可灵**一个生成后端（文生视频 / 图生视频 / 文生图 / 图生图，走 `kling` CLI 登录态，无需 API Key）；MiniMax / RunningHub / 火山方舟 等 HTTP API 平台与飞书多维表格上报**暂未接入**。抓帧 / 抓帧→PS / 抓视频 / 提示词模板 / 智能填参 / 生成记录均已具备。

**agent 安装步骤**（CEP 版比 UXP 版简单得多，无需 UPIA 与 UPI.db 登记）：

```bash
# 1) 下载 Release 安装包（资产命名 RocX-CEP_<版本>.zip，按最新 tag 替换）
gh release download v0.1.1 -R vark-debug/rocx-cep -p 'RocX-CEP_*.zip' -O /tmp/rocx-cep.zip

# 2) 解压到 CEP 扩展目录（解压后得到 extensions/com.rocx.cep/）
unzip /tmp/rocx-cep.zip -d "$HOME/Library/Application Support/Adobe/CEP/extensions/"

# 3) 开 PlayerDebugMode（未签名扩展需要；也可改用 Release 里的 .zxp 拖进 ZXP Installer，免此步）
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1

# 4) 可灵 CLI 安装与登录：与本文 §3 / §4 完全相同（CLI 全局安装，UXP / CEP 两版共用）
```

然后重启 PR，菜单 **窗口 → 扩展 → RocX** 打开面板。详细说明（含 Windows 的 PowerShell 注册表写法）见其仓库 README。

---

## 2. 安装插件本体

### 2.1 两条可选路径

| 路径 | 手段 | 是否需要人点 | 适用 |
|---|---|---|---|
| **A（推荐）** | Adobe 官方 **UPIA** 命令行安装器 | ❌ 不需要 | **agent 自动化首选** |
| B | 手动拷贝目录 | ❌ 不需要 | UPIA 不可用时的降级 |

> **重要**：Adobe 官方文档明确写了「**不能**像 CEP 那样直接把插件文件写进 UXP 插件目录」——因为 UXP 需要同步更新注册数据库。
> 走 UPIA 就是让 Adobe 自己的工具去写数据库，这是唯一「静默且合规」的路径。

### 2.2 路径 A：UPIA 命令行安装（推荐）

UPIA（Unified Plugin Installer Agent）随 Adobe Creative Cloud 一起安装，**macOS 上是 root 权限的只读系统路径**：

```
/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent
```

**第 1 步：拿到 CCX 包**

从 GitHub Release 下载（无需登录）：

```bash
# 方式 1：GitHub Release（正式发布版）
curl -fL -o /tmp/rocx.ccx \
  https://github.com/vark-debug/RocX/releases/download/v0.4.1/com.rocx.uxp_premierepro.ccx

# 方式 2：从源码构建（要装本项目的可灵 provider / 需要未发布功能时）
cd /path/to/RocX && npm install && npm run ccx     # 产物在 ccx/com.rocx.uxp_premierepro.ccx
```

**第 2 步：安装**

```bash
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

"$UPIA" --install /tmp/rocx.ccx
```

预期输出：

```
Installing extension with file path = /tmp/rocx.ccx
Installation Successful for extension with file path = /tmp/rocx.ccx
```

**第 3 步：验证落地**

```bash
# 插件代码落在系统级目录（注意：用户名这一层是 UPIA 加的）
ls -1 "/Library/Application Support/Adobe/UXP/Plugins/$(whoami)/External/"

# 应看到 com.rocx.uxp_premierepro_<版本号>
# 校验关键文件齐全（缺 addon → 「抓帧→PS」不可用）
D="/Library/Application Support/Adobe/UXP/Plugins/$(whoami)/External/com.rocx.uxp_premierepro_0.4.1"
ls "$D/manifest.json" "$D/index.html" "$D/webview-ui/main.html" "$D/mac/arm64/RocXBridge.uxpaddon"
```

**第 4 步：确认注册表已更新**

UXP 的插件注册信息在 Adobe 的 UPI 数据库里：

```bash
DB="$HOME/Library/Application Support/Adobe/UPI/Configuration/DB/UPI.db"
sqlite3 -header -column "$DB" \
  "SELECT ExtID, ExtName, ExtVersion, ExtIDInFile FROM Tb_ExtBasicInfo WHERE ExtName LIKE '%rocx%';"
```

预期能看到一行 `rocx | 0.4.1 | com.rocx.uxp_premierepro`。

> ⚠️ **重复安装会产生重复记录**（实测）：同一个版本装两次，`Tb_ExtBasicInfo` 会出现**两条** `ExtID` 不同、
> 但 `ExtVersion` / `ExtIDInFile` 完全相同的行（本机装完一次又重装一次，从 1 条变成 3 条）。
> 原因是 UPIA 每次 `--install` 都插一条新记录，而不是做 upsert。
>
> **agent 幂等做法**：安装前先查 DB，若已存在同版本记录就**跳过安装**：
>
> ```bash
> DB="$HOME/Library/Application Support/Adobe/UPI/Configuration/DB/UPI.db"
> ALREADY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM Tb_ExtBasicInfo WHERE ExtName='rocx' AND ExtVersion='0.4.1';")
> if [ "$ALREADY" -gt 0 ]; then
>   echo "已安装，跳过"
> else
>   "$UPIA" --install /tmp/rocx.ccx
> fi
> ```
>
> 若已经产生了重复记录，清理（**先备份**）：
>
> ```bash
> cp "$DB" /tmp/UPI.db.backup
>
> # 找出重复行：rocx 同版本保留最小 ExtID，其余为冗余
> sqlite3 "$DB" "
> DELETE FROM Tb_ExtFileMap    WHERE ExtID IN (SELECT ExtID FROM Tb_ExtBasicInfo WHERE ExtName='rocx' AND ExtID NOT IN (SELECT MIN(ExtID) FROM Tb_ExtBasicInfo WHERE ExtName='rocx' GROUP BY ExtVersion));
> DELETE FROM Tb_ExtProductMap WHERE ExtID IN (SELECT ExtID FROM Tb_ExtBasicInfo WHERE ExtName='rocx' AND ExtID NOT IN (SELECT MIN(ExtID) FROM Tb_ExtBasicInfo WHERE ExtName='rocx' GROUP BY ExtVersion));
> DELETE FROM Tb_ExtStatus      WHERE ExtID IN (SELECT ExtID FROM Tb_ExtBasicInfo WHERE ExtName='rocx' AND ExtID NOT IN (SELECT MIN(ExtID) FROM Tb_ExtBasicInfo WHERE ExtName='rocx' GROUP BY ExtVersion));
> DELETE FROM Tb_ExtBasicInfo   WHERE ExtName='rocx' AND ExtID NOT IN (SELECT MIN(ExtID) FROM Tb_ExtBasicInfo WHERE ExtName='rocx' GROUP BY ExtVersion);
> "
> ```
>
> ⚠️ 注意 `DELETE` 的 `WHERE` **必须同时限定 `ExtName='rocx'`**。
> 只写 `ExtID NOT IN (...)` 会把**其它插件**（Smart-Export / timelinebarstudio 等）的记录一起删掉 —— 实测踩过这个坑。

### 2.3 路径 B：手动拷贝（降级方案）

若 UPIA 不存在（没装 Creative Cloud Desktop / 企业版精简部署），可手动拷贝。但要**同时**手工补注册表，否则 PR 扫不到。

```bash
DEST="/Library/Application Support/Adobe/UXP/Plugins/$(whoami)/External/com.rocx.uxp_premierepro_0.4.1"

# 1) 解包 CCX
mkdir -p /tmp/rocx-unpack && cd /tmp/rocx-unpack
unzip -oq /tmp/rocx.ccx

# 2) 拷到目标目录（目录名必须是 <pluginId>_<app>_<version>）
sudo mkdir -p "$DEST"
sudo cp -R /tmp/rocx-unpack/. "$DEST/"

# 3) 手工登记进 UPI.db（字段参考本机已有的其它插件）
#    ExtName=rocx, ExtVersion=<版本>, ExtIDInFile=com.rocx.uxp_premierepro
```

> ⚠️ 步骤 3 的字段与 `Tb_ExtBasicInfo` 的其它列（`FilePath` / `NeedRestart` / `ExtDestType` 等）耦合，
> **不建议 agent 手改 sqlite**。优先回到路径 A；路径 B 仅在「确认 PR 能扫到目录」的机器上用（可先拷完重启 PR 验证面板出不出来）。

### 2.4 重启 Premiere Pro

**这是唯一的硬性人工步骤。** UXP 插件在 PR 启动时扫描插件目录，运行中拷贝不会生效。

agent 应做的是：

```bash
# 若 PR 正在运行 → 提示用户手动退出并重开（不要 kill，PR 可能有未保存工程）
pgrep -f "Adobe Premiere Pro" >/dev/null && echo "⚠️ 请手动退出 Premiere Pro 后重新打开"

# 若 PR 未运行 → 可以直接拉起
open -a "Adobe Premiere Pro 2026"
```

**为什么不 agent 直接杀 PR**：PR 是有状态的重型应用，强杀会丢未保存的工程序列。优雅退出要走 `osascript`：

```bash
# 优雅退出：先问用户（PR 若弹了保存对话框会卡住）
osascript -e 'tell application "Adobe Premiere Pro 2026" to quit'
# 若有未保存内容，PR 会弹保存框 → 需要人点
```

**验证插件已加载**：重启后打开面板 **窗口 > 扩展 > RocX**，面板出现即成功。

### 2.5 卸载（agent 需要回滚时）

```bash
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
"$UPIA" --remove rocx
```

> ⚠️ **实测坑**：`--remove` 返回 `Failed to remove rocx, status = -406`，但**插件目录其实已被删除**。
> 也就是说 **退出码不可信，必须用「目录是否还在」来判定成败**：

```bash
# 判定：目录不存在 = 卸载成功
ls -d "/Library/Application Support/Adobe/UXP/Plugins/$(whoami)/External/com.rocx.uxp_premierepro_0.4.1" 2>/dev/null \
  && echo "❌ 仍存在" || echo "✅ 已删除"
```

（`-406` 大概率是 UPIA 在删完目录后才去清注册表，发现记录状态不符就报错了。）

---

## 3. 安装可灵 CLI

可灵 provider **不走 HTTP API**，而是调本机的 `kling` CLI 子进程。所以必须先装 CLI。

### 3.1 包名与落地结构

| 项 | 值 |
|---|---|
| 国内站包名 | `@klingai/cli-cn`（实测最新 `0.2.3`） |
| 海外站包名 | `@klingai/cli-global`（同版本号） |
| bin 名 | `kling`（软链到 `dist/cli.js`） |
| JS 入口 | `<npm root -g>/@klingai/cli-cn/dist/cli.js` |

插件的 CLI 定位逻辑（[src/core/klingCli.ts](../src/core/klingCli.ts)）会**同时探测 `cli-cn` 和 `cli-global`**，装哪个都认。所以 agent 只需按用户所在区域选一个包名。

### 3.2 安装命令

**推荐：用 node 直接跑 npm 的 JS 入口**（绕开 PATH 与 shebang）

```bash
NODE="$(command -v node)"
NPMCLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"

# 国内站
"$NODE" "$NPMCLI" install -g @klingai/cli-cn
# 海外站（按需替换）
# "$NODE" "$NPMCLI" install -g @klingai/cli-global
```

**为什么不用 `npm i -g`**：`npm` 和 `kling` 一样是 `#!/usr/bin/env node` 的 shebang 脚本。
从 Dock 启动的 PR 继承的是精简 PATH，既没有 npm 全局 bin 目录也常常没有 node 本身，
直接跑会得到 `env: node: No such file or directory`（实测）。插件内部同样用 `node + npm-cli.js` 的方式定位 npm root，两者同构。

> 如果 agent 本身就在一个正常终端里（PATH 完整），`npm i -g @klingai/cli-cn` 也完全可以 —— 上面的写法只是更稳。

### 3.3 prefix 不可写时的降级方案

若 `npm prefix -g` 指向 `/usr/local`（需要 root），有两条路：

**方案 1：改 npm prefix（推荐，插件无需改动）**

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
# 确认 ~/.npmrc 里 prefix=... ，然后重装
"$NODE" "$NPMCLI" install -g @klingai/cli-cn
```

装完后 `npm root -g` 仍指向新 prefix，插件的 `locateNpmRoot` 能正常找到。

**方案 2：装到独立目录**

```bash
npm install -g --prefix "$HOME/.rocx/kling-cli" @klingai/cli-cn
```

落地结构（实测）：

```
~/.rocx/kling-cli/
├── bin/kling -> ../lib/node_modules/@klingai/cli-cn/dist/cli.js
└── lib/node_modules/@klingai/cli-cn/dist/cli.js
```

> ⚠️ 方案 2 需要改插件的 CLI 探测路径（`src/core/klingCli.ts` 的 `locateCliEntry` 增加一条候选），
> 否则插件认不到这个目录。**agent 场景下优先用方案 1**（不改代码）。

### 3.4 验证安装

```bash
NPM_ROOT="$("$NODE" "$NPMCLI" root -g)"
CLI_JS="$NPM_ROOT/@klingai/cli-cn/dist/cli.js"

# 版本检查：期望输出 kling-cli 0.2.3
"$NODE" "$CLI_JS" --version

# 能力发现（未登录时会报未登录，但说明 CLI 可正常执行）
"$NODE" "$CLI_JS" who_am_i --quiet
```

`who_am_i --quiet` 的输出是紧凑 JSON，**必须先 `login` 才有内容**：

```json
{"ok":true,"status":200,"body":{"user":{...},"availableModels":{...}}}
```

---

## 4. 登录可灵 CLI

### 4.1 机制

`kling login` 走 **OAuth 2.0 + PKCE**：

```
CLI 起本地 loopback server（端口 8787 / 8788 / 8789 / 8790）
  → 构造 authorizeUrl（含 code_challenge）
  → 调 open "<url>" 拉起系统默认浏览器
  → 用户在浏览器里登录可灵账号并点「同意」
  → 浏览器回调到 127.0.0.1:<端口>/callback，CLI 拿到 code
  → code 换 token，写入 ~/.kling/.credentials
```

**凭据落盘位置**：

```
~/.kling/.credentials          # 默认
$KLING_HOME/.credentials       # 设置了 KLING_HOME 时
```

**关键约束**：

| 约束 | 值 | 来源 |
|---|---|---|
| 授权超时 | **5 分钟** | `LOGIN_TIMEOUT_MS` |
| 本地回调端口 | 8787-8790 | `DEFAULT_LOOPBACK_PORTS` |
| 换账号 | **必须先 `logout`**，否则 `login` 会先吊销旧 token | CLI 的 `clearLoginState` |

### 4.2 agent 该做什么

**agent 不能代用户在浏览器里点「同意」** —— 这是 OAuth 协议的设计，浏览器上下文在 agent 够不到的地方。

agent 能做且应该做的：

1. 起 `kling login` 子进程（**后台**，不要阻塞）
2. 把「请在弹出的浏览器里完成授权」这句话明确转告用户
3. 轮询凭据是否写入 / 跑 `who_am_i` 验证
4. 超时未完成 → 明确报错，不要静默

### 4.3 执行

```bash
NPM_ROOT="$("$NODE" "$NPMCLI" root -g)"
CLI_JS="$NPM_ROOT/@klingai/cli-cn/dist/cli.js"

# 换账号时先登出（会走服务端登出 + 本地吊销 + 清凭据）
"$NODE" "$CLI_JS" logout 2>&1 | head -5

# 起登录（前台跑也行，但 agent 侧建议后台 + 轮询）
"$NODE" "$CLI_JS" login 2>&1 | tee /tmp/kling-login.log
```

CLI 会把授权 URL 打到 stderr：

```
[kling] Opening browser for login: https://...
[kling] Waiting for browser authorization...
```

**如果浏览器没自动弹出来**（无头环境 / `open` 失败），CLI 会把 URL 打到 stderr，agent 可以手动打开：

```bash
# 从日志里提取 URL 并用系统默认浏览器打开
URL=$(grep -oE 'https://[^ ]+' /tmp/kling-login.log | head -1)
[ -n "$URL" ] && open "$URL"
```

**登录成功的标志**：日志出现

```
[kling] Login successful; tokens saved to /Users/<user>/.kling/.credentials
```

### 4.4 验证登录

```bash
# 方式 1：看凭据文件（存在且非空）
ls -la ~/.kling/.credentials

# 方式 2：跑能力发现（更可靠，返回用户信息与模型清单）
"$NODE" "$CLI_JS" who_am_i --quiet
```

预期输出片段（实测）：

```json
{"ok":true,"status":200,"body":{"user":{"userId":4642291843},"mcpVersion":"1.3.3","availableModels":{...}}}
```

### 4.5 给用户的说明话术（agent 直接转达即可）

> 可灵登录需要您在浏览器里完成一次授权。
> 我已经打开了授权页面（或：请点击 <授权链接>），请在浏览器中登录您的可灵账号并点击「同意授权」。
> 授权完成后我会继续验证并收尾，整个过程需要在 5 分钟内完成。

---

## 5. 校验与收尾

### 5.1 一次性体检脚本

agent 完成全部步骤后跑这个，逐项应为 ✅：

```bash
#!/bin/bash
echo "=== 1. 插件落地 ==="
D="/Library/Application Support/Adobe/UXP/Plugins/$(whoami)/External/com.rocx.uxp_premierepro_0.4.1"
[ -f "$D/manifest.json" ] && echo "✅ 插件已安装" || echo "❌ 插件缺失"

echo "=== 2. C++ addon ==="
[ -f "$D/mac/arm64/RocXBridge.uxpaddon" ] && echo "✅ addon 在位" || echo "❌ addon 缺失"

echo "=== 3. 可灵 CLI ==="
NODE="$(command -v node)"
NPMCLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
CLI_JS="$("$NODE" "$NPMCLI" root -g)/@klingai/cli-cn/dist/cli.js"
[ -f "$CLI_JS" ] && echo "✅ CLI 已安装" || echo "❌ CLI 缺失"

echo "=== 4. 登录态 ==="
[ -s "$HOME/.kling/.credentials" ] && echo "✅ 凭据存在" || echo "❌ 未登录"

echo "=== 5. 能力发现 ==="
"$NODE" "$CLI_JS" who_am_i --quiet 2>&1 | head -c 120; echo

echo "=== 6. PR 运行状态 ==="
pgrep -f "Adobe Premiere Pro" >/dev/null && echo "⚠️  PR 运行中 → 需重启才生效" || echo "✅ PR 未运行"
```

### 5.2 插件内自检（用户视角）

插件设置面板里有「可灵 CLI 环境自检」，会显示：

- CLI 是否安装 / 是否登录
- 会员等级、灵感值余额、可用模型数
- 「重新检测」按钮

用户也可在面板顶部切到「可灵」平台，面板会直接提示环境未就绪的原因。

> 该自检结果会持久化到 `app-settings.json` 的 `klingEnv` 字段，所以第二次启动是**秒显**，不阻塞。

### 5.3 最终交付说明（agent → 用户）

建议 agent 最后给用户一段这样的收尾：

> ✅ 安装完成：
> - RocX 插件 v0.4.1 已安装到系统 UXP 目录
> - 可灵 CLI 0.2.3 已安装到 `<npm root -g>`
> - 可灵账号已登录（用户 ID `<userId>`）
>
> ⚠️ 还需您做一件事：**重启 Premiere Pro**（窗口 > 扩展 > RocX 打开面板）
> ⚠️ 抓视频功能需要 **Adobe Media Encoder**，本机未检测到 —— 请到 Adobe 官网安装后重启 PR。

---

## 6. 依赖与前置检查

### 6.1 Adobe Media Encoder（AME）

**抓视频**（把工作区栏片段作为参考视频）依赖 AME：
插件用 Premiere UXP 的 `EncoderManager.exportSequence`，转码由 AME 后台执行（`exportType` 含 `QUEUE_TO_AME`）。

- AME 缺失 → 抓视频失败；**抓帧不受影响**
- 检测：`ls -d /Applications/Adobe\ Media\ Encoder*/Adobe\ Media\ Encoder*.app`
- agent 无法代装（需 Creative Cloud 账号与授权），只能提示用户
- 用户不想装 AME 的另一条路：改装 [rocx-cep](https://github.com/vark-debug/rocx-cep)（CEP 版，抓视频免 AME，见「CEP 版替代方案」）

### 6.2 node 缺失

可灵 CLI 需要 node（最低 v18，实测 v24 可用）。

```bash
# Homebrew
brew install node

# 或 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts
```

装完必须让当前 shell 生效（`source ~/.zshrc`），并确认 `command -v node` 有输出。

> 插件自身**不需要** node（它是个 UXP 插件，不是 Node 应用），node 只是可灵 CLI 的宿主。

### 6.3 插件本体的架构要求

C++ Hybrid addon（`RocXBridge.uxpaddon`）按架构分发：

```
public-hybrid/mac/arm64/RocXBridge.uxpaddon   # Apple Silicon
public-hybrid/mac/x64/RocXBridge.uxpaddon     # Intel（构建时产出）
public-hybrid/win/x64/RocXBridge.uxpaddon     # Windows
```

> **注意**：`public-hybrid/` 已被 `.gitignore` 忽略，仓库里**不包含任何预编译 addon**。
> 每次出包都需要在对应平台执行 `npm run native:build` 产出，或从其他平台拷贝已编译的 `.uxpaddon` 到对应目录。
>
> - **Apple Silicon**：在 Mac 上 `npm run native:build` 产出 `mac/arm64/`
> - **Intel Mac**：需额外交叉编译一次，产出 `mac/x64/`（见 [cpp-hybrid-build.md](cpp-hybrid-build.md) 的交叉编译章节）
> - **Windows**：在 Windows 上 `npm run native:build:win` 产出 `win/x64/`
>
> agent 装到非 arm64 机器时必须检查这一项。

---

## 7. 常见故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| PR 里看不到 RocX 面板 | PR 未重启 / 插件目录没落地 / PR 版本 < 25.6 | 重启 PR；`ls` 目录；查 PR 版本 —— 版本 < 25.6 → 改装 CEP 版（见「CEP 版替代方案」） |
| 面板出现但提示「可灵环境未就绪」 | CLI 未装或未登录 | 跑 §3.4 / §4.4 验证 |
| `env: node: No such file or directory` | 用了 shebang 脚本且 PATH 精简 | 改用 `node + npm-cli.js`（§3.2） |
| `kling login` 浏览器不弹 | 无头环境 / `open` 失败 | 从 stderr 抓 URL 手动 `open`（§4.3） |
| 登录 5 分钟后失败 | 授权超时 | 重跑 `login`；期间不要关闭浏览器回调页 |
| 登录后 `who_am_i` 仍报未登录 | `login` 失败但被吞了 | 看 `~/.kling/logs/` 与 login 的 stderr |
| 换了账号还是旧账号 | `login` 只吊销不清本地 | 先 `kling logout` 成功后再 `login` |
| `file_upload` 慢（5s+） | 大文件 / 网络 | 正常；插件已做后台预上传优化 |
| UPIA `--remove` 返回 -406 | **退出码不可信**，目录其实已删 | 用 `ls` 判成败（§2.5） |
| 插件目录在 `/Library/...` 需 sudo | UPIA 装到系统级目录 | 这是正常状态；用户级路径 `~/Library/Application Support/Adobe/UXP/Plugins/` 只装第三方手动装的插件 |

---

## 8. agent 执行清单（可直接抄）

```markdown
## RocX 安装任务清单（macOS）

- [ ] 0. 跑前置探测（§1），记录 PR 版本 / node / npm prefix 可写性 / AME
  - **PR < 25.6 → 改走「CEP 版替代方案」章节，跳过下面第 1 步**（§3 / §4 的可灵 CLI 步骤照旧）
  - AME 缺失 → 不阻塞，收尾时提醒用户（或按需建议 CEP 版）
- [ ] 1. 下载 CCX：`curl -fL -o /tmp/rocx.ccx https://github.com/vark-debug/RocX/releases/download/v0.4.1/com.rocx.uxp_premierepro.ccx`
- [ ] 2. UPIA 安装：`"$UPIA" --install /tmp/rocx.ccx`，验证目录 + manifest.json + addon 在位
- [ ] 3. 装可灵 CLI：`"$NODE" "$NPMCLI" install -g @klingai/cli-cn`，验证 `kling-cli` 版本号
- [ ] 4. 起 `kling login`（后台），转告用户「请在浏览器点同意授权」（5 分钟内有效）
- [ ] 5. 验证登录：`who_am_i --quiet` 返回 ok:true
- [ ] 6. 提示用户重启 Premiere Pro
- [ ] 7. 跑体检脚本（§5.1），输出收尾报告（含 AME 缺失提醒）
```

---

## 附：本文档结论的实测来源

| 结论 | 验证方式 |
|---|---|
| UPIA 路径与 `--install` / `--remove` / `--list` 用法 | `UPIA --help` + 实机安装 / 卸载 / 重装 |
| 插件落 `/Library/Application Support/Adobe/UXP/Plugins/<user>/External/<id>_<app>_<ver>` | 安装后 `ls` + 读落盘 manifest.json |
| CCX 内 manifest 的 `id` 被改写为 `<id>_<app>`、entrypoint id 同步改写 | 解包 ccx 对比 `dist/manifest.json` |
| 插件注册表在 `UPI.db` 的 `Tb_ExtBasicInfo` | sqlite3 查询 |
| 可灵 CLI 包名 / bin / 版本 / 落地结构 | `npm view` + 实际安装 + `npm ls -g` |
| `login` 的 PKCE + loopback 8787-8790 + 5 分钟超时 + `.credentials` 路径 | 读 CLI 源码 `login()` |
| `who_am_i --quiet` 的输出结构 | 实机执行 |
| 插件的 CLI 定位逻辑（node + npm-cli.js，探测 cli-cn / cli-global） | 读 [src/core/klingCli.ts](../src/core/klingCli.ts) |
| PR 版本要求 25.6+ | 读 [uxp.config.ts](../uxp.config.ts) 的 `host.minVersion` |
| 抓视频依赖 AME | 读 [README](../README.md) 环境要求表 |
