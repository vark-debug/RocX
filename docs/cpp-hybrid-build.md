# C++ Hybrid Plugin · Build & Distribution Guide

> 对应 spec：`.trae/specs/cpp-hybrid-plugin-ps-launch/`
> 用途：把「抓帧→PS」从纯 UXP `shell.openPath`（依赖系统 jpg 默认关联，实际会拉起「预览」）
> 升级到 C++ Hybrid Plugin 路径，用 macOS `NSWorkspace` / Windows `ShellExecuteExW`
> **强制**指定拉起 Photoshop。

## 1. 最低要求

| 组件 | 最低版本 |
|------|----------|
| Premiere | 22.3（UXP Hybrid Plugin 引入版本） |
| UXP Developer Tool (UDT) | 2.0 |
| macOS | 10.15 (Catalina) |
| Windows | 10 64-bit |
| Xcode CLT | 14+ |
| CMake | 3.15+ |
| Visual Studio | 2022 + C++ workload |

## 2. SDK 状态：已内置，无需下载

`native/RocXBridge/third_party/uxp-hybrid-sdk/` 已包含 Adobe 官方 SDK 源文件：

```
third_party/uxp-hybrid-sdk/src/
├── api/
│   ├── UxpAddonTypes.h      # addon_env / addon_value / addon_status 等基础类型
│   └── UxpAddonShared.h     # addon_apis 函数指针表 + entry point 声明
└── utilities/
    ├── UxpAddon.h           # UXP_ADDON_INIT / UXP_ADDON_TERMINATE 宏、Check()、HandlerScope
    └── UxpAddon.cpp         # CreateErrorFromException 实现
```

无需再从 Adobe Developer Console 下载。

## 3. 目录约定（关键）

产物落盘路径由 `vite-uxp-plugin` **写死**，不能改：

```
RocX/
├── public-hybrid/              ← cmake POST_BUILD 输出到这里
│   ├── mac/
│   │   ├── arm64/RocXBridge.uxpaddon
│   │   └── x64/RocXBridge.uxpaddon
│   └── win/x64/RocXBridge.uxpaddon
├── native/RocXBridge/          ← C++ 源码 + CMakeLists
└── dist/                       ← vite-uxp-plugin 自动从 public-hybrid/ 拷来
```

[vite-uxp-plugin/lib/index.js](file:///Users/xucangshu/Desktop/PRAI/RocX/node_modules/vite-uxp-plugin/lib/index.js) 的 `copyHybridBinaries()` 只读 `<root>/public-hybrid`，
**不存在就静默 return**，addon 不会进包。因此：

- ✅ CMake 输出到 `public-hybrid/{mac,win}/<arch>/`
- ❌ 不要用 `copyZipAssets` —— 它只在 `npm run zip` 打包 zip 时生效，与 ccx 无关
- ❌ 不要输出到 `native/RocXBridge/dist/`

## 4. 常用命令

| 命令 | 作用 |
|------|------|
| `npm run native:build:mac` | 仅编译 C++ addon（当前架构），产物落 `public-hybrid/mac/<arch>/` |
| `npm run native:build` | 按平台分发（`dev`/`build`/`ccx`/`zip` 会自动前置执行） |
| `npm run dev` | native build + vite watch |
| `npm run ccx` | 生成 `ccx/com.rocx.uxp_premierepro.ccx` |

### 交叉编译 x64（M1/M2/M3 上同时产出 Intel 产物）

```bash
cmake -B native/RocXBridge/build-x64 -S native/RocXBridge \
      -DCMAKE_OSX_ARCHITECTURES=x86_64 \
      -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15
cmake --build native/RocXBridge/build-x64 --config Release
```

## 5. 验证 addon 是否真的被打进包

```bash
npm run ccx
unzip -l ccx/com.rocx.uxp_premierepro.ccx | grep uxpaddon
# 期望：mac/arm64/RocXBridge.uxpaddon

nm -gU public-hybrid/mac/arm64/RocXBridge.uxpaddon | grep uxp_addon
# 期望：_uxp_addon_init / _uxp_addon_terminate 两个导出符号
```

## 6. UDT 加载与调试

1. UDT → Add Plugin → 选 `dist/manifest.json`
2. 点 **Load**（不要用 "Load and Watch"，Hybrid 二进制在调试期间被锁）
3. Console 应出现 `[RocXBridge] init ok, openFileInPhotoshop registered`
4. 点面板「抓帧→PS」按钮，若走 native 路径 PS 会被拉起；若 PS 未装则 console 打印
   `[files] hybrid addon returned error, fallback to UXP: Photoshop is not installed`，
   并退到 `shell.openPath`（此时会是「预览」，属预期 fallback 行为）

### 重新编译 C++ 后

必须 **Unload → 重新 build → Load**，否则二进制被占用无法覆盖。JS/TS 侧改动可走热重载。

## 9. 抓帧→PS 启动顺序（v0.3+）

`openWithPhotoshopNative` 严格按以下顺序尝试拉起 Photoshop：

1. **C++ Hybrid Plugin**（`RocXBridge.openFileInPhotoshop`）
   - macOS：`NSWorkspace.openURLs:withApplicationBundleIdentifier:` + bundle id `com.adobe.Photoshop`
   - Windows：HKLM/HKCU `SOFTWARE\Adobe\Photoshop\{12.0..200.0}\ApplicationPath` + COM fallback
   - 要求 PR ≥ 26.2（25.6 仅有 hybrid 雏形），低于该版本报 `Addon is not supported`

2. **Launcher 脚本**（`launcher.cmd` / `launcher.command`）
   - C++ 不可用时由 `shell.openPath` 启动
   - Windows 用 `launcher.cmd`（批处理）作为入口，`.cmd` 内部再调 `powershell -File launcher.ps1`。
     直接传 `.ps1` 给 UXP `shell.openPath` 在某些版本会被拒（即使白名单已声明 `.ps1`），
     `.cmd` 是 UXP 白名单里最稳的 Windows 入口。
   - UXP `shell.openPath` 不支持额外参数 → UXP 端先把 `{path, ts}` 写到
     `%APPDATA%\Adobe\UXP\PluginsStorage\PPRO\<ver>\Developer\<pluginId>\PluginData\rocx-launcher-args.json`（Windows）
     或 `~/Library/Application Support/UXP/PluginsStorage/<app>/<ver>/Developer/<pluginId>/PluginData/rocx-launcher-args.json`（macOS）
   - launcher 用 glob 搜索所有 PR 版本目录,读 args JSON 后按以下顺序找 PS 路径:
     1. 注册表扫描 (HKLM/HKCU SOFTWARE\Adobe\Photoshop\{12.0..200.0})
     2. 硬编码扫描 Adobe Creative Cloud 默认路径 (CC 2018 ~ 2026+)
     3. .psd UserChoice COM fallback
   - 找到 PS 后 `Start-Process` / `open -a` 启动;消费后立即删除 args JSON,避免重复启动

**已知问题**:PR 25 启动的 PowerShell 进程读不到 `HKLM:\SOFTWARE\Adobe\Photoshop\200.0\ApplicationPath`
(沙箱/受限 session 限制了注册表访问),所以注册表分支在这台机器上 100% 走不通,
**实际依赖硬编码路径兜底**。如果用户把 PS 装到非默认位置,需要手动加到硬编码列表或修正注册表。

3. **系统兜底**（`shell.openPath(localPath)`）
   - 仅在 1、2 都失败时执行；走系统 jpg/psd 默认关联
   - 用户机器上若 jpg 默认关联被改成 WPS/Photos，仍可能拉到错的预览
   - 此时由 UI 层 toast 告知用户「PS 未检测到，已开系统默认」

manifest 白名单需包含 `.ps1` / `.command` / `.sh`（已在 `uxp.config.ts` 中配置）。

UXP Hybrid Plugin 脚本由 `scripts/copy-launcher-assets.js`（自定义 vite 插件）在 build/package 模式
自动从 `public-zip/` 拷到 `dist/` 根目录；zip 模式由 `vite-uxp-plugin` 的 `copyZipAssets` 处理。


## 7. 签名与公证

macOS 上未签名的 `.uxpaddon` 会被 Gatekeeper 拦截。发布前需：

```bash
codesign --force --options runtime --sign "Developer ID Application: <你的证书>" \
         public-hybrid/mac/arm64/RocXBridge.uxpaddon
xcrun notarytool submit public-hybrid/mac/arm64/RocXBridge.uxpaddon \
         --keychain-profile <profile> --wait
xcrun stapler staple public-hybrid/mac/arm64/RocXBridge.uxpaddon
```

arm64 与 x64 产物需**分别**签名。Windows 建议用 EV 证书签名，否则 SmartScreen 会拦。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|------|-------------|
| `[files] hybrid addon unavailable` | `dist/` 下没有 `mac/<arch>/RocXBridge.uxpaddon` → 检查 `public-hybrid/` 是否有产物、`npm run native:build` 是否执行 |
| `Failed to load Addon` | 二进制未签名（macOS）；或 PR 版本 < 22.3 |
| addon 加载了但 `openFileInPhotoshop` 是 undefined | 未在 `vite.config.ts` 的 `rollupOptions.external` 里加 `"RocXBridge.uxpaddon"`，被打包器改写 |
| PS 未安装 | 返回 `{ok:false, error:"Photoshop is not installed"}`，自动 fallback 到系统关联 |
| dev 模式 dist 被清空 | `vite.config.ts` 已有 `emptyOutDir: !shouldNotEmptyDir` 保护，勿删 |
