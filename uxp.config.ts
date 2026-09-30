import { UXP_Manifest, UXP_Config, UXP_Config_Extra } from "vite-uxp-plugin";
import { version } from "./package.json";

const extraPrefs: UXP_Config_Extra = {
  hotReloadPort: 8080,
  webviewUi: true,
  webviewReloadPort: 8082,
  /**
   * Adobe UXP Hybrid Plugin 的 .uxpaddon 不走这里：vite-uxp-plugin 内置的
   * copyHybridBinaries() 会自动把 <root>/public-hybrid/* 拷进 dist/*，
   * cmake POST_BUILD 已把产物放到 public-hybrid/{mac,win}/<arch>/。
   */
  copyZipAssets: ["public-zip/*"],
  uniqueIds: true,
  debugger: "udt",
};

export const id = "com.rocx.uxp";
const name = "rocx";

const manifest: UXP_Manifest = {
  id,
  name,
  version,
  main: "index.html",
  manifestVersion: 6,
  host: [
    {
      app: "premierepro",
      // Adobe UXP Hybrid Plugin 最低要求 PR 25.6(2025-06 GA)。
      // PR < 25.6 没有 addon runtime,加载即报 "Addon is not supported"。
      // https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/build
      minVersion: "25.6.0",
    },
  ],
  /**
   * Adobe UXP Hybrid Plugin addon 声明:在插件内嵌 C++ uxpaddon;
   * 编译产物 RocXBridge.uxpaddon 放在 mac/{arm64,x64}/ 与 win/x64/ 目录,
   * 由 vite-uxp-plugin 的 copyHybridBinaries 从 public-hybrid/ 拷进 dist/。
   */
  addon: {
    name: "RocXBridge.uxpaddon",
  },
  entrypoints: [
    {
      type: "panel",
      id: `${id}.main`,
      label: {
        default: name,
      },
      minimumSize: { width: 300, height: 380 },
      maximumSize: { width: 2000, height: 2000 },
      preferredDockedSize: { width: 300, height: 380 },
      preferredFloatingSize: { width: 450, height: 400 },
      icons: [
        {
          width: 23,
          height: 23,
          path: "icons/dark.png",
          scale: [1, 2],
          theme: ["darkest", "dark", "medium"],
        },
        {
          width: 23,
          height: 23,
          path: "icons/light.png",
          scale: [1, 2],
          theme: ["lightest", "light"],
        },
      ],
    },
  ],
  featureFlags: {
    enableAlerts: true,
  },
  requiredPermissions: {
    /**
     * Adobe UXP Hybrid Plugin 加载 uxpaddon 必须开启
     */
    enableAddon: true,
    /**
     * 网络白名单：按当前启用的 provider 域名集合维护。
     * 扩展 provider 时（如 kling / runway），需在此追加对应域名，
     * 并同步 `requiredPermissions.webview.domains`。
     */
    localFileSystem: "fullAccess",
    launchProcess: {
      schemes: ["https", "slack", "file", "ws"],
      // 注意:shell.openPath 按文件扩展名走 LaunchServices(macOS)/ShellExecute(Win),
      // 必须在白名单里才能被允许执行。抓帧→PS 路径需要:
      //   .jpg/.jpeg/.webp/.png — 系统兜底 shell.openPath(localPath)
      //   .psd              — launcher 脚本 COM fallback 查 .psd UserChoice
      //   .ps1 / .command / .sh — 启动 launcher 脚本(无 C++ addon 时的 fallback 路径)
      extensions: [
        ".xd",
        ".psd",
        ".bat",
        ".cmd",
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".ps1",
        ".command",
        ".sh",
        "",
      ],
    },
    network: {
      domains: [
        `ws://localhost:${extraPrefs.hotReloadPort}`,
        // MiniMax 默认 provider 域名
        "https://api.minimax.cn",
        "https://cdn.hailuoai.com",
        // MiniMax 生成结果 CDN（用户报告实际响应域名）
        "https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com",
        // 飞书多维表格自动化 webhook（租户级子域名，如 xxx.feishu.cn，必须通配）
        "https://*.feishu.cn",
        // 钉钉连接器 webhook（测试用）
        "https://connector.dingtalk.com",
        // 扩展 provider 时在此追加，例如：
        // Kling: "https://api.klingai.com", "https://cdn.klingai.com"
        // Runway: "https://api.runwayml.com", "https://cdn.runwayml.com"
      ],
    },
    clipboard: "readAndWrite",
    /**
     * Webview 白名单：需与 network.domains 保持同步；
     * 扩展 provider 时同步在此追加对应域名。
     *
     * 注：飞书 / 钉钉 webhook 请求均由 UXP 端 `core/feishu.ts` 发出，webview
     * 不直接请求这两个域名，故此处不需要对应的白名单条目。
     */
    webview: {
      allow: "yes",
      allowLocalRendering: "yes",
      domains: [
        "https://api.minimax.cn",
        "https://cdn.hailuoai.com",
        "https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com",
      ],
      enableMessageBridge: "localAndRemote",
    },
    ipc: {
      enablePluginCommunication: true,
    },
    allowCodeGenerationFromStrings: true,
  },
  icons: [
    {
      width: 48,
      height: 48,
      path: "icons/plugin-icon.png",
      scale: [1, 2],
      theme: ["darkest", "dark", "medium", "lightest", "light", "all"],
      species: ["pluginList"],
    },
  ],
};

export const config: UXP_Config = {
  manifest,
  ...extraPrefs,
};