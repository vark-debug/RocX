/**
 * 视频首帧缩略图生成（UXP 端）
 *
 * 流程：
 *   1) UXP 端用 `<video>` + `<canvas>` + drawImage 抽首帧
 *   2) canvas.toDataURL("image/jpeg", 0.7) → base64
 *   3) 解码 base64 → Uint8Array → 写入 plugin-data:/AI-Generated-Media/Thumbs/<recordId>.jpg
 *
 * 关键点：
 *   - 视频是已下载好的本地 mp4（plugin-data:/AI-Generated-Media/<id>.mp4），
 *     把 nativePath 转成 file:// URL 给 <video src>
 *   - 抽帧失败不抛错（try/catch 静默）——缩略图失败不应阻塞主流程
 *   - 不在 records.json 里记录 thumbPath（文件名按 recordId 推算）
 *   - 每次下载完成后由 downloadFile 异步触发，不阻塞 polling / UI
 */
import { uxp } from "../globals";
import { filesCore, WORK_DIR_NAME } from "./files";

const THUMBS_SUBDIR = "Thumbs";
const THUMB_WIDTH = 320;       // 缩略图宽度（高度按比例）
const THUMB_QUALITY = 0.7;     // JPEG 质量

/**
 * 解析 file:// URL 给 UXP <video src> 用
 * 注意：plugin-data 容器内的视频用 plugin-data:/ 协议更稳（file:// 偶尔被沙箱拒）
 */
function toVideoSrcUrl(nativePath: string): string | null {
  if (!nativePath) return null;
  const normalized = String(nativePath).replace(/\\/g, "/");
  // plugin-data 容器内走 plugin-data: 协议
  const marker = `/${WORK_DIR_NAME}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx >= 0 && /PluginData\//.test(normalized)) {
    const rel = normalized.slice(idx + marker.length);
    return `plugin-data:/${WORK_DIR_NAME}/${rel}`;
  }
  // 其它（项目旁等）走 file://
  return "file://" + nativePath.replace(/ /g, "%20");
}

/** base64 → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 把 mp4 文件抽首帧并写到 plugin-data Thumbs 目录
 * - 返回 { ok, thumbPath }，失败 ok=false（不抛错）
 * - <video> 用 load() + loadeddata + currentTime=0 + seeked 等首帧 ready
 * - 抽帧失败 / 文件不存在 / 写入失败：都返回 ok=false，主流程不受影响
 */
async function extractFirstFrameToJpeg(
  videoSrc: string,
  thumbPath: string,
): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      try {
        // 清理：source 清空 + load() 释放解码器
        if (video.src && videoSrc) {
          try { video.removeAttribute("src"); video.load(); } catch (_) {}
        }
      } catch (_) {}
      resolve(r);
    };

    const video = document.createElement("video") as HTMLVideoElement;
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    // 必须加到 DOM 才能触发解码（部分 UXP 版本 detached video 不 decode）
    video.style.position = "fixed";
    video.style.left = "-99999px";
    video.style.top = "0";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    document.body.appendChild(video);

    const cleanup = () => {
      try { video.remove(); } catch (_) {}
    };

    // 超时兜底（视频解码失败 / 文件坏）
    const timer = setTimeout(() => {
      cleanup();
      done({ ok: false, error: "video 抽帧超时" });
    }, 8000);

    const onLoaded = () => {
      // 等待视频尺寸 ready
      if (!video.videoWidth || !video.videoHeight) {
        // 部分 UXP 版本 loadeddata 时 videoWidth 还未就绪，等 loadedmetadata
        return;
      }
      try {
        // seek 到 0（已是 0 也要 seek 一次以触发解码）
        video.currentTime = 0;
      } catch (e: any) {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, error: "seek 失败: " + String(e?.message || e) });
        return;
      }
    };

    const onSeeked = () => {
      clearTimeout(timer);
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          cleanup();
          done({ ok: false, error: "video 尺寸无效" });
          return;
        }
        const ratio = THUMB_WIDTH / vw;
        const w = THUMB_WIDTH;
        const h = Math.round(vh * ratio);
        const canvas = document.createElement("canvas") as HTMLCanvasElement;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          done({ ok: false, error: "canvas 2d 上下文不可用" });
          return;
        }
        // 黑底（H.264 首帧偶发透明，避免白底闪烁）
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", THUMB_QUALITY);
        const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");

        // 落盘
        const fs: any = uxp.storage.localFileSystem;
        (async () => {
          try {
            // ensure Thumbs 目录
            const baseUrl = `plugin-data:/${WORK_DIR_NAME}`;
            let dir: any;
            try {
              dir = await fs.getEntryWithUrl(`${baseUrl}/${THUMBS_SUBDIR}`);
            } catch (_) {
              dir = null;
            }
            if (!dir) {
              try {
                dir = await fs.createEntryWithUrl(`${baseUrl}/${THUMBS_SUBDIR}`, {
                  type: uxp.storage.types.folder,
                  overwrite: false,
                });
              } catch (e: any) {
                cleanup();
                done({ ok: false, error: "无法创建 Thumbs 目录: " + String(e?.message || e) });
                return;
              }
            }
            // 写文件
            const thumbName = thumbPath.split("/").pop() || "thumb.jpg";
            const bytes = base64ToBytes(b64);
            const entry = await fs.createEntryWithUrl(`${baseUrl}/${THUMBS_SUBDIR}/${thumbName}`, {
              type: uxp.storage.types.file,
              overwrite: true,
            });
            await entry.write(bytes, { format: uxp.storage.formats.binary });
            const written = entry.nativePath || (await fs.getNativePath(entry));
            cleanup();
            done({ ok: true, error: undefined });
            console.log("[thumbs] 写入缩略图:", written);
            // thumbPath 通过返回值暴露给调用方
            (done as any).thumbPath = written;
          } catch (e: any) {
            cleanup();
            done({ ok: false, error: "写入缩略图失败: " + String(e?.message || e) });
          }
        })();
      } catch (e: any) {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, error: "drawImage 失败: " + String(e?.message || e) });
      }
    };

    const onError = (e: any) => {
      clearTimeout(timer);
      cleanup();
      done({ ok: false, error: "video load 错误: " + String((e as any)?.message || e) });
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("loadeddata", () => {
      // loadeddata 时 videoWidth/videoHeight 应该已就绪
      if (video.videoWidth && video.videoHeight) {
        onLoaded();
      }
    }, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    try {
      video.src = videoSrc;
      video.load();
    } catch (e: any) {
      clearTimeout(timer);
      cleanup();
      done({ ok: false, error: "video.src 失败: " + String(e?.message || e) });
    }
  }).then((r: any) => {
    if (r.ok && r.thumbPath) return { ok: true, thumbPath: r.thumbPath };
    return r;
  }) as Promise<{ ok: boolean; thumbPath?: string; error?: string }>;
}

export const thumbsCore = {
  /**
   * 给已下载的视频生成首帧缩略图
   * - 由 downloadFile 完成后异步调用，不阻塞主流程
   * - 失败时静默返回 ok=false，不抛错
   * - 返回的 thumbPath 是 plugin-data 内的 nativePath（容器内 file:// 加载无沙箱问题）
   */
  async generate(args: {
    recordId: string;
    videoPath: string;
  }): Promise<{ ok: boolean; thumbPath?: string; error?: string }> {
    try {
      if (!args.videoPath) return { ok: false, error: "videoPath 为空" };
      const src = toVideoSrcUrl(args.videoPath);
      if (!src) return { ok: false, error: "无法构造 video src URL" };
      const thumbName = `${args.recordId}.jpg`;
      console.log("[thumbs] generate start:", { recordId: args.recordId, src });
      const r = await extractFirstFrameToJpeg(src, thumbName);
      return r;
    } catch (e: any) {
      console.warn("[thumbs] generate EXCEPTION:", e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 拿到缩略图路径（按 recordId 推算）
   * - 用于 webview 端直接尝试加载（不必为每条记录预生成）
   * - 注意：文件可能不存在，webview 端需要容错
   */
  async getThumbPath(recordId: string): Promise<string | null> {
    try {
      const fs: any = uxp.storage.localFileSystem;
      const url = `plugin-data:/${WORK_DIR_NAME}/${THUMBS_SUBDIR}/${recordId}.jpg`;
      const entry = await fs.getEntryWithUrl(url);
      if (entry && !entry.isFolder) {
        return entry.nativePath || (await fs.getNativePath(entry));
      }
      return null;
    } catch (_) {
      return null;
    }
  },

  /**
   * 把 nativePath 转成 webview 可加载的 file:// URL
   * （plugin-data 容器内的 file:// WKWebView 允许加载）
   */
  toWebviewUrl(nativePath: string): string {
    if (!nativePath) return "";
    return "file://" + String(nativePath).replace(/ /g, "%20");
  },

  /**
   * 确保缩略图存在：已存在直接返回；不存在则从 records.json 找 record.workFile
   * 异步触发 generate（fire-and-forget，不阻塞调用方）。
   * - 用于 webview 启动时补全历史记录 / downloadFile 异常时漏生成的缩略图
   * - 总是返回 { ok: true }（生成是后台异步），避免 webview 误以为失败
   */
  async ensureThumb(args: { recordId: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const existing = await this.getThumbPath(args.recordId);
      if (existing) return { ok: true };
      // 异步查 records.json 拿 workFile
      const { recordsCore } = await import("./records");
      const rec = await recordsCore.read();
      if (!rec.ok || !rec.data) {
        return { ok: true, error: "records 不可读（异步生成跳过）" };
      }
      const r = rec.data.records.find((x) => x.id === args.recordId);
      if (!r || !r.workFile) {
        return { ok: true, error: "record 或 workFile 不存在" };
      }
      // 检查 workFile 是否还在
      const { filesCore } = await import("./files");
      const wf = await filesCore.getEntryAnyPath(r.workFile);
      if (!wf || wf.isFolder) {
        return { ok: true, error: "workFile 已不可访问" };
      }
      console.log(`[thumbs] ensureThumb 后台触发: ${args.recordId} ← ${r.workFile}`);
      // 异步生成（fire-and-forget）
      this.generate({ recordId: args.recordId, videoPath: r.workFile })
        .then((gr) => {
          if (!gr.ok) {
            console.warn(`[thumbs] ensureThumb 生成失败:`, gr.error);
          } else {
            console.log(`[thumbs] ensureThumb 补生成成功: ${gr.thumbPath}`);
          }
        })
        .catch((e) => {
          console.warn(`[thumbs] ensureThumb 异常:`, e?.message || e);
        });
      return { ok: true };
    } catch (e: any) {
      // 兜底：永远不抛错
      console.warn("[thumbs] ensureThumb EXCEPTION:", e?.message || e);
      return { ok: true, error: String(e?.message || e) };
    }
  },
};
