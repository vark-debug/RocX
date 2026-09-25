import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue"; 
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(), 
    viteSingleFile(),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: 8081,
  },
  build: {
    outDir: "../public/webview-ui",
  },
  define: {
    __ROCX_DRY_RUN__: JSON.stringify(process.env.ROCX_DRY_RUN === "1"),
    // 开发模式开关：仅 VITE_BOLT_MODE=dev 时暴露调试工具
    __ROCX_DEV__: JSON.stringify(process.env.VITE_BOLT_MODE === "dev"),
  },
});
