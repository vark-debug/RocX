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
 * - 抽帧策略：
 *   1) video 元素 attached + 320×180 显示尺寸（保证解码器真的 decode）
 *   2) 等 canplay（HAVE_FUTURE_DATA，buffer 够首帧渲染）
 *   3) seek 到 0.001 强制触发 seeked（部分 webview currentTime=0 不触发 seeked）
 *   4) 等 seeked 后 drawImage（双保险：再 seek 到 0 让画面是首帧而不是中间帧）
 * - 失败原因诊断：每步加 console.log，方便排查 stuck 在哪
 * - 抽帧失败 / 文件不存在 / 写入失败：都返回 ok=false，主流程不受影响
 */
async function extractFirstFrameToJpeg(
  videoSrc: string,
  thumbPath: string,
): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    let phase = "init";
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      console.log(`[thumbs] ${thumbPath} done phase=${phase}`, r);
      try {
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
    video.playsInline = true;
    // 关键：尺寸必须给到让解码器认为值得解码（之前 1×1 太小，
    // 某些 webview 会跳过首帧 decode → loadeddata 触发但 buffer 没就绪 → seeked 等不到）
    video.style.position = "fixed";
    video.style.left = "-99999px";
    video.style.top = "0";
    video.style.width = "320px";
    video.style.height = "180px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.style.display = "block";
    document.body.appendChild(video);

    const cleanup = () => {
      try { video.remove(); } catch (_) {}
    };

    // 大文件（2K 高码率 mp4 30~50MB）下载缓冲 + 解码可能慢；放宽到 25s
    const TIMEOUT_MS = 25000;
    const timer = setTimeout(() => {
      cleanup();
      done({ ok: false, error: `video 抽帧超时（卡在 ${phase}, readyState=${video.readyState}, networkState=${video.networkState}）` });
    }, TIMEOUT_MS);

    const tryDraw = () => {
      phase = "draw";
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          cleanup();
          done({ ok: false, error: "video 尺寸无效 vw=" + vw + " vh=" + vh });
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
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", THUMB_QUALITY);
        const b64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");

        const fs: any = uxp.storage.localFileSystem;
        (async () => {
          try {
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
            const thumbName = thumbPath.split("/").pop() || "thumb.jpg";
            const bytes = base64ToBytes(b64);
            const entry = await fs.createEntryWithUrl(`${baseUrl}/${THUMBS_SUBDIR}/${thumbName}`, {
              type: uxp.storage.types.file,
              overwrite: true,
            });
            await entry.write(bytes, { format: uxp.storage.formats.binary });
            const written = entry.nativePath || (await fs.getNativePath(entry));
            cleanup();
            (done as any).thumbPath = written;
            done({ ok: true });
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

    const trySeek = () => {
      phase = "seek";
      try {
        // 用 0.001 强制触发 seeked（currentTime=0 在部分 webview 不触发）
        video.currentTime = 0.001;
      } catch (e: any) {
        clearTimeout(timer);
        cleanup();
        done({ ok: false, error: "seek 失败: " + String(e?.message || e) });
      }
    };

    /**
     * 检查 readyState：HAVE_METADATA=1 / HAVE_CURRENT_DATA=2 / HAVE_FUTURE_DATA=3 / HAVE_ENOUGH_DATA=4
     * 需要至少 HAVE_CURRENT_DATA（首帧已可绘制）才 seek
     */
    const tryProceed = () => {
      const rs = video.readyState;
      console.log(`[thumbs] ${thumbPath} readyState=${rs} vw=${video.videoWidth} vh=${video.videoHeight} dur=${video.duration}`);
      if (rs >= 2 && video.videoWidth && video.videoHeight) {
        trySeek();
      }
      // 还没就绪：什么都不做，继续等 loadeddata / canplay
    };

    const onLoadedData = () => {
      phase = "loadeddata";
      tryProceed();
    };
    const onCanPlay = () => {
      phase = "canplay";
      tryProceed();
    };
    const onSeeked = () => {
      phase = "seeked";
      // 双保险：seeked 后再把 currentTime 设回 0，避免 0.001 偏移带来的画面不是首帧
      try {
        video.currentTime = 0;
      } catch (_) {}
      // 帧已绘制，再来一次 seeked（currentTime=0 → 0）也会触发，给它一个微 task 再 draw
      requestAnimationFrame(() => {
        // 检查 readyState >= 2（current frame 渲染了）
        if (video.readyState >= 2) {
          tryDraw();
        } else {
          // 还没渲染完成，再等一次 seeked
          const onSeeked2 = () => {
            phase = "seeked2";
            tryDraw();
          };
          video.addEventListener("seeked", onSeeked2, { once: true });
          // 兜底超时（如果 seeked 不触发）
          setTimeout(() => {
            if (!settled) {
              console.warn(`[thumbs] ${thumbPath} 二次 seeked 超时，尝试强制 draw (readyState=${video.readyState})`);
              if (video.readyState >= 2) tryDraw();
              else cleanup(), done({ ok: false, error: "seeked2 超时" });
            }
          }, 5000);
        }
      });
    };
    const onError = (e: any) => {
      clearTimeout(timer);
      cleanup();
      done({ ok: false, error: "video load 错误: " + String((e as any)?.message || e) + ` (code=${(e as any)?.target?.error?.code})` });
    };

    video.addEventListener("loadedmetadata", () => {
      phase = "loadedmetadata";
      console.log(`[thumbs] ${thumbPath} loadedmetadata vw=${video.videoWidth} vh=${video.videoHeight}`);
    }, { once: true });
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    video.addEventListener("canplay", onCanPlay, { once: true });
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    // 进度事件埋点（卡住时排查用）
    video.addEventListener("stalled", () => {
      console.warn(`[thumbs] ${thumbPath} stalled phase=${phase} readyState=${video.readyState}`);
    });
    video.addEventListener("waiting", () => {
      console.warn(`[thumbs] ${thumbPath} waiting phase=${phase} readyState=${video.readyState}`);
    });

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
