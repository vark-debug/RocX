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
      minVersion: "26.5.0",
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
    localFileSystem: "fullAccess",
    launchProcess: {
      schemes: ["https", "slack", "file", "ws"],
      extensions: [".xd", ".psd", ".bat", ".cmd", ""],
    },
    network: {
      domains: [
        `ws://localhost:${extraPrefs.hotReloadPort}`,
        "https://api.minimax.cn",
        "https://cdn.hailuoai.com",
        // MiniMax 生成结果 CDN（用户报告实际响应域名）
        "https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com",
      ],
    },
    clipboard: "readAndWrite",
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