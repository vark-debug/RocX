import { defineConfig } from "vite";
import { runAction, uxp, uxpSetup } from "vite-uxp-plugin";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { copyLauncherAssets } from "./scripts/copy-launcher-assets.js";

import { config } from "./uxp.config";

const action = process.env.BOLT_ACTION;
const mode = process.env.MODE;
process.env.VITE_BOLT_MODE = mode;
process.env.VITE_BOLT_WEBVIEW_UI = (config.webviewUi === true).toString();
process.env.VITE_BOLT_WEBVIEW_PORT = config.webviewReloadPort.toString();

if (action) runAction(config, action);

const shouldNotEmptyDir =
  mode === "dev" && config.manifest.requiredPermissions?.enableAddon;

export default defineConfig({
  plugins: [
    uxp(config, mode),
    vue(),
    // 把 public-zip/launcher.{ps1,command} 拷到 dist 根目录;
    // vite-uxp-plugin 的 copyZipAssets 只在 mode==="zip" 时生效,
    // build/package 模式需要这个插件补齐,launcher 脚本才能被 UXP shell.openPath 启动。
    copyLauncherAssets({ mode }),
  ],
  build: {
    sourcemap: mode && ["dev", "build"].includes(mode) ? "inline" : false,
    minify: false,
    emptyOutDir: !shouldNotEmptyDir,
    rollupOptions: {
      external: [
        "premierepro", 
        "RocXBridge.uxpaddon",
        "uxp",
        "fs",
        "os",
        "path",
        "process",
        "shell",
      ],
      output: {
        // format: "cjs",
        format: "iife", // Needed for Webview UI in Vue to prevent global overrides
      },
    },
  },
  publicDir: "public",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  define: {
    __ROCX_DRY_RUN__: JSON.stringify(process.env.ROCX_DRY_RUN === "1"),
    // 开发模式开关：仅 MODE=dev 时暴露调试工具
    __ROCX_DEV__: JSON.stringify(mode === "dev"),
    // 默认启用的 provider 列表（默认 ["minimax"]；环境变量 ROCX_PROVIDERS=minimax,kling 可覆盖）
    __ROCX_PROVIDERS__: JSON.stringify(
      (process.env.ROCX_PROVIDERS || "minimax").split(",").filter(Boolean),
    ),
  },
});
