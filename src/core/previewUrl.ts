/**
 * 预览资源路径转换:
- toLocalFileUrl: 把 nativePath 转成 webview 可加载的 file:// URL,
  必要时复制到 plugin-data 预览缓存(用户目录 file:// 会被 WKWebView 拒绝)。
- readAsDataUrl: 直接读成 base64 data URL,给 <video>/<img> 显示。

依赖 pathUtils 与 fileIO 的 getEntryAnyPath / getFileByPath / readFileBytes。
 */
import { uxp } from "../globals";
import { getFs, getEntryAnyPath, getFileByPath, extOf } from "./pathUtils";
import { WORK_DIR_NAME } from "./workDir";
import { readFileBytes } from "./fileIO";

export const previewUrlCore = {
  /**
   * 把本地文件路径转成 webview 可加载的 file:// URL。
   *
   * webview(WKWebView) 只能加载插件容器内的本地资源;项目旁 Imports/References
   * 等用户目录的 file:// 会被拒绝(Not allowed to load local resource)。
   * 对非 plugin-data 路径:复制到 plugin-data:/preview-cache/(按文件名幂等),
   * 返回容器内 file:// URL。
   *
   * 已为 file:// 路径或 plugin-data 内的路径:直接返回原 URL,不做处理。
   */
  async toLocalFileUrl(localPath: string): Promise<string> {
    if (!localPath) return "";
    if (localPath.startsWith("file://")) return localPath;
    const plainUrl = "file://" + localPath.replace(/ /g, "%20");
    const normalized = String(localPath).replace(/\\/g, "/");
    const inContainer =
      /PluginData\//.test(normalized) || /PluginsStorage\//.test(normalized);
    if (inContainer) return plainUrl;
    try {
      const fs = getFs();
      const src = await getEntryAnyPath(localPath, {
        pluginDataDirName: WORK_DIR_NAME,
      });
      if (!src || src.isFolder) return plainUrl;
      let dir: any = null;
      try {
        dir = await fs.getEntryWithUrl("plugin-data:/preview-cache");
      } catch (e) {
        dir = null;
      }
      if (!dir) {
        dir = await fs.createEntryWithUrl("plugin-data:/preview-cache", {
          type: uxp.storage.types.folder,
          overwrite: false,
        });
      }
      if (!dir) return plainUrl;
      const name = normalized.split("/").pop() || `file-${Date.now()}`;
      let dest: any = null;
      try {
        dest = await dir.getEntry(name);
      } catch (e) {
        dest = null;
      }
      if (!dest) {
        try {
          dest = await src.copyTo(dir, name, { overwrite: false });
        } catch (e) {
          // 并发/重名兜底:再查一次
          try {
            dest = await dir.getEntry(name);
          } catch (e2) {
            dest = null;
          }
        }
      }
      if (!dest) return plainUrl;
      const np = dest.nativePath || (await fs.getNativePath(dest));
      return "file://" + String(np).replace(/ /g, "%20");
    } catch (e) {
      return plainUrl;
    }
  },

  /**
   * 把视频 / 图片读成 base64 data URL,让 WebView 直接 <video>/<img src=""> 显示
   * 避免 file:// 被 WebView 拦截。
   */
  async readAsDataUrl(fileOrPath: any | string): Promise<{
    ok: boolean;
    dataUrl?: string;
    mime?: string;
    size?: number;
    error?: string;
  }> {
    try {
      let file = fileOrPath;
      if (typeof fileOrPath === "string") {
        file = await getFileByPath(fileOrPath);
        if (!file) return { ok: false, error: "无法访问文件" };
      }
      const ab = await readFileBytes(file);
      if (!ab) return { ok: false, error: "读取为空" };

      const bytes = new Uint8Array(ab);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const sub = bytes.subarray(i, i + CHUNK);
        bin += String.fromCharCode.apply(null, Array.from(sub));
      }
      const b64 = btoa(bin);

      // 根据扩展名推断 mime
      const name: string = file?.name || fileOrPath || "";
      const ext = extOf(name).toLowerCase();
      const mime =
        ext === "mp4"
          ? "video/mp4"
          : ext === "webm" || ext === "mov"
          ? "video/" + ext
          : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "png"
          ? "image/png"
          : ext === "gif"
          ? "image/gif"
          : ext === "webp"
          ? "image/webp"
          : "application/octet-stream";

      return {
        ok: true,
        dataUrl: `data:${mime};base64,${b64}`,
        mime,
        size: bytes.length,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};