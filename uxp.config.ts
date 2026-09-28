import { UXP_Manifest, UXP_Config, UXP_Config_Extra } from "vite-uxp-plugin";
import { version } from "./package.json";

const extraPrefs: UXP_Config_Extra = {
  hotReloadPort: 8080,
  webviewUi: true,
  webviewReloadPort: 8082,
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
      minVersion: "25.6.0",
    },
  ],
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
     * 网络白名单：按当前启用的 provider 域名集合维护。
     * 扩展 provider 时（如 kling / runway），需在此追加对应域名，
     * 并同步 `requiredPermissions.webview.domains`。
     */
    localFileSystem: "fullAccess",
    launchProcess: {
      schemes: ["https", "slack", "file", "ws"],
      extensions: [".xd", ".psd", ".bat", ".cmd", ""],
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