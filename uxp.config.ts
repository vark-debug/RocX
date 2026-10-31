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
      // Adobe 官方对 UXP Hybrid Plugin 的最低要求是 PR 26.2（Minimum Requirements 表）。
      // 本插件是 Hybrid 插件（内嵌 C++ uxpaddon），按官方口径把下限提到 26.2；
      // 更早版本加载 addon 即报 "Addon is not supported"（此前 25.6.0 下限只覆盖
      // UXP DOM 能力，但可灵在 25.6 上本来就用不了，与其留一个半残的 25.6，不如
      // 让低版本用户走 CEP 版兄弟仓库 rocx-cep）。
      // https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/
      minVersion: "26.2.0",
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
        // RunningHub 图片 provider：上传 / 创建 / 查询 API（host 侧 binary 上传 + webview 侧 fetch 共用）
        "https://www.runninghub.cn",
        // RunningHub 生成结果 COS 下载（区域/桶名不固定：ap-beijing/ap-guangzhou 等，通配覆盖）
        "https://*.myqcloud.com",
        // 火山方舟 Ark 图片 provider：API（ark.cn-beijing.volces.com）+ 生成结果 CDN
        // （ark-content-generation-*.tos-*.volces.com），通配覆盖
        "https://*.volces.com",
        // 飞书多维表格自动化 webhook（租户级子域名，如 xxx.feishu.cn，必须通配）
        "https://*.feishu.cn",
        // 钉钉连接器 webhook（测试用）
        "https://connector.dingtalk.com",
        // Kling 生成结果 CDN。
        //
        // ⚠ 必须通配，且两个主域名都要：
        //   - 主机名含分片编号，实测见过 v2- / v4-（kechuangai.com）与 p2- / p4-（klingai.com），
        //     编号会随 CDN 调度变化，写死单个主机迟早失效。
        //   - 主域名本身迁移过：2026-07 前后从 *.klingai.com 换成了 *.kechuangai.com。
        //   - 路径前缀也变过（/ksc2/ 与 /bs2/upload-ylab-stunt/）。
        //
        // 可灵的 API / OAuth / 上传票据请求由 CLI 子进程（node）发出，是独立 OS 进程，
        // 不受 UXP network.domains 约束 —— 这里只管 UXP 侧下载生成结果。
        "https://*.kechuangai.com",
        "https://*.klingai.com",
        // 扩展 provider 时在此追加，例如：
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
        // RunningHub 图片 provider：webview 侧 createImage / queryTask fetch
        "https://www.runninghub.cn",
        // 火山方舟 Ark 图片 provider：webview 侧 createImage fetch（同步 API）+ 结果 CDN
        "https://*.volces.com",
        // Kling 生成结果 CDN：webview 侧图片记录预览会直连 resultUrl（RecordFeedBlock / RecordsPanel），
        // 视频走本地 workFile（容器内 file://）不触网。通配理由同 network.domains。
        "https://*.kechuangai.com",
        "https://*.klingai.com",
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