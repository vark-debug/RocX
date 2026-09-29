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
