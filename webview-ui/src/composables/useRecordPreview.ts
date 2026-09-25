import { ref, watch, onMounted } from "vue";
import type { GenerationRecord } from "@shared/messages";
import { bridge } from "../services/bridge";

/**
 * 记录预览 composable：canvas 抽帧 / 视频 / 缩略图 URL 缓存
 * 从 RecordsPanel.vue 抽出，保持原有所有方法 / 状态 / 行为完全不变
 */
export function useRecordPreview(
  records: () => GenerationRecord[],
  selectedIdRef: () => string | null,
) {
  // 8 个 ref 缓存（命名 / 类型 / 默认值与现有完全一致）
  const videoUrlCache = ref<Record<string, { path: string; url: string }>>({});
  const thumbUrlCache = ref<Record<string, { path: string; url: string }>>({});
  const loadingVideoIds = ref<Set<string>>(new Set());
  const loadingThumbIds = ref<Set<string>>(new Set());
  const fileUrlFailedIds = ref<Set<string>>(new Set());
  const canvasThumbCache = ref<Record<string, string>>({});
  const canvasThumbPending = ref<Set<string>>(new Set());
  const canvasThumbFailed = ref<Set<string>>(new Set());

  const mainFrameBlob = ref<string | null>(null);
  let mainFrameSeq = 0;

  // ---------- canvas 抽帧 ----------
  async function extractFirstFrame(
    recordId: string,
    videoUrl: string,
  ): Promise<string | null> {
    if (!videoUrl) return null;
    return await new Promise((resolve) => {
      const video = document.createElement("video") as HTMLVideoElement;
      video.muted = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.style.position = "fixed";
      video.style.left = "-99999px";
      video.style.top = "0";
      video.style.width = "320px";
      video.style.height = "180px";
      video.style.display = "block";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      document.body.appendChild(video);

      let settled = false;
      const cleanup = () => {
        try { video.remove(); } catch (_) {}
      };
      const done = (url: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url);
      };

      const timer = setTimeout(() => done(null), 25000);

      const onError = () => {
        clearTimeout(timer);
        done(null);
      };

      const drawFromVideo = () => {
        try {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (!vw || !vh) return false;
          const canvas = document.createElement("canvas") as HTMLCanvasElement;
          canvas.width = 320;
          canvas.height = Math.round(vh * (320 / vw));
          const ctx = canvas.getContext("2d");
          if (!ctx) return false;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            clearTimeout(timer);
            if (blob) {
              try {
                const url = URL.createObjectURL(blob);
                done(url);
              } catch (_) {
                done(null);
              }
            } else {
              done(null);
            }
          }, "image/jpeg", 0.7);
          return true;
        } catch (_) {
          return false;
        }
      };

      const onSeeked = () => {
        try { video.currentTime = 0; } catch (_) {}
        requestAnimationFrame(() => {
          if (video.readyState >= 2) {
            if (!drawFromVideo()) {
              clearTimeout(timer);
              done(null);
            }
          } else {
            const onSeeked2 = () => {
              if (!drawFromVideo()) {
                clearTimeout(timer);
                done(null);
              }
            };
            video.addEventListener("seeked", onSeeked2, { once: true });
            setTimeout(() => {
              if (!settled) {
                if (video.readyState >= 2) {
                  if (!drawFromVideo()) done(null);
                } else {
                  done(null);
                }
              }
            }, 5000);
          }
        });
      };

      video.addEventListener("loadeddata", () => {
        if (video.readyState >= 2 && video.videoWidth) {
          try { video.currentTime = 0.001; } catch (_) {}
        }
      }, { once: true });
      video.addEventListener("canplay", () => {
        if (!settled && video.videoWidth) {
          try { video.currentTime = 0.001; } catch (_) {}
        }
      }, { once: true });
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });

      try {
        video.src = videoUrl;
        video.load();
      } catch (_) {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  async function resolveUrl(rec: GenerationRecord): Promise<string> {
    if (!rec.workFile) return "";
    if (fileUrlFailedIds.value.has(rec.id)) {
      const r = await bridge.readAsDataUrl(rec.workFile);
      return r.ok && r.dataUrl ? r.dataUrl : "";
    }
    try {
      const u = await bridge.toLocalFileUrl(rec.workFile);
      if (typeof u === "string" && u) return u;
    } catch (e) {
      console.warn("[RecordsPanel] toLocalFileUrl failed", e);
    }
    return "";
  }

  async function loadVideoUrl(rec: GenerationRecord) {
    if (!rec.workFile) return;
    const cached = videoUrlCache.value[rec.id];
    if (cached && cached.path === rec.workFile && cached.url) return;
    if (loadingVideoIds.value.has(rec.id)) return;
    loadingVideoIds.value.add(rec.id);
    try {
      const url = await resolveUrl(rec);
      if (url)
        videoUrlCache.value = {
          ...videoUrlCache.value,
          [rec.id]: { path: rec.workFile, url },
        };
    } catch (e) {
      console.warn("[RecordsPanel] loadVideoUrl failed", e);
    } finally {
      loadingVideoIds.value.delete(rec.id);
    }
  }

  async function loadThumbUrl(rec: GenerationRecord) {
    if (!rec.workFile) return;
    const cached = thumbUrlCache.value[rec.id];
    if (cached && cached.path === rec.workFile && cached.url) return;
    if (loadingThumbIds.value.has(rec.id)) return;
    loadingThumbIds.value.add(rec.id);
    try {
      const url = await resolveUrl(rec);
      thumbUrlCache.value = {
        ...thumbUrlCache.value,
        [rec.id]: { path: rec.workFile, url: url || "" },
      };
    } catch (e) {
      console.warn("[RecordsPanel] thumb failed", e);
      thumbUrlCache.value = {
        ...thumbUrlCache.value,
        [rec.id]: { path: rec.workFile, url: "" },
      };
    } finally {
      loadingThumbIds.value.delete(rec.id);
    }
  }

  async function getCanvasThumbUrl(rec: GenerationRecord): Promise<string | null> {
    if (!rec || !rec.workFile) return null;
    if (rec.status !== "generated" && rec.status !== "imported") return null;
    if (canvasThumbCache.value[rec.id]) return canvasThumbCache.value[rec.id];
    if (canvasThumbFailed.value.has(rec.id)) return null;
    if (canvasThumbPending.value.has(rec.id)) return null;
    canvasThumbPending.value.add(rec.id);
    try {
      let vUrl = videoUrlOf(rec);
      if (!vUrl) vUrl = await resolveUrl(rec);
      if (!vUrl) {
        canvasThumbFailed.value.add(rec.id);
        return null;
      }
      const blobUrl = await extractFirstFrame(rec.id, vUrl);
      if (blobUrl) {
        canvasThumbCache.value = { ...canvasThumbCache.value, [rec.id]: blobUrl };
        return blobUrl;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      canvasThumbPending.value.delete(rec.id);
    }
  }

  function videoUrlOf(rec: GenerationRecord) {
    const c = videoUrlCache.value[rec.id];
    return c && c.path === rec.workFile ? c.url : "";
  }

  function thumbUrlOf(rec: GenerationRecord) {
    const c = thumbUrlCache.value[rec.id];
    if (!c || c.path !== rec.workFile) return "";
    return c.url;
  }

  function thumbModeOf(rec: GenerationRecord): "image" | "video" | "placeholder" {
    if (rec.status !== "generated" && rec.status !== "imported") return "placeholder";
    if (canvasThumbCache.value[rec.id]) return "image";
    if (thumbUrlOf(rec)) return "video";
    return "placeholder";
  }

  async function triggerCanvasThumbs() {
    for (const r of records()) {
      if (canvasThumbCache.value[r.id]) continue;
      if (canvasThumbFailed.value.has(r.id)) continue;
      if (canvasThumbPending.value.has(r.id)) continue;
      try {
        await loadThumbUrl(r);
        if (r.id === selectedIdRef()) await loadVideoUrl(r);
        await getCanvasThumbUrl(r);
      } catch (_) {}
    }
    await generateMainFrame();
  }

  async function generateMainFrame() {
    const all = records();
    const selId = selectedIdRef();
    const rec = all.find((r) => r.id === selId) || null;
    if (!rec || !rec.workFile) {
      mainFrameBlob.value = null;
      return;
    }
    if (rec.status !== "generated" && rec.status !== "imported") {
      mainFrameBlob.value = null;
      return;
    }
    const mySeq = ++mainFrameSeq;
    try {
      let vUrl = videoUrlOf(rec);
      if (!vUrl) vUrl = await resolveUrl(rec);
      if (mySeq !== mainFrameSeq) return;
      if (!vUrl) {
        mainFrameBlob.value = null;
        return;
      }
      const blobUrl = await extractFirstFrame(rec.id, vUrl);
      if (mySeq !== mainFrameSeq) return;
      mainFrameBlob.value = blobUrl;
    } catch (_) {
      if (mySeq === mainFrameSeq) mainFrameBlob.value = null;
    }
  }

  async function onVideoError(rec: GenerationRecord) {
    if (!rec.workFile || fileUrlFailedIds.value.has(rec.id)) return;
    fileUrlFailedIds.value.add(rec.id);
    videoUrlCache.value = {
      ...videoUrlCache.value,
      [rec.id]: { path: rec.workFile, url: "" },
    };
    thumbUrlCache.value = {
      ...thumbUrlCache.value,
      [rec.id]: { path: rec.workFile, url: "" },
    };
    await loadThumbUrl(rec);
    if (selectedIdRef() === rec.id) await loadVideoUrl(rec);
  }

  function onThumbError(rec: GenerationRecord) {
    thumbUrlCache.value = {
      ...thumbUrlCache.value,
      [rec.id]: { path: rec.workFile || "", url: "" },
    };
  }

  // ---------- 自动挂载：watch records / selectedId ----------
  watch(
    () => records(),
    (rs) => {
      rs.forEach((r) => {
        const cv = videoUrlCache.value[r.id];
        const ct = thumbUrlCache.value[r.id];
        if (
          (cv && cv.path !== r.workFile) ||
          (ct && ct.path !== r.workFile)
        ) {
          const nextV = { ...videoUrlCache.value };
          const nextT = { ...thumbUrlCache.value };
          delete nextV[r.id];
          delete nextT[r.id];
          videoUrlCache.value = nextV;
          thumbUrlCache.value = nextT;
          fileUrlFailedIds.value.delete(r.id);
        }
        loadThumbUrl(r);
        if (selectedIdRef() && r.id === selectedIdRef()) loadVideoUrl(r);
      });
    },
    { immediate: true, deep: true },
  );

  watch(selectedIdRef, (id) => {
    const rec = records().find((r) => r.id === id);
    if (rec) loadVideoUrl(rec);
  });

  watch(selectedIdRef, () => {
    mainFrameBlob.value = null;
  });

  onMounted(() => {
    records().forEach((r) => {
      loadThumbUrl(r);
      if (r.id === selectedIdRef()) loadVideoUrl(r);
    });
    triggerCanvasThumbs();
  });

  watch(
    () => records(),
    () => { triggerCanvasThumbs(); },
    { deep: true },
  );

  return {
    // 缓存状态
    videoUrlCache,
    thumbUrlCache,
    canvasThumbCache,
    loadingVideoIds,
    loadingThumbIds,
    fileUrlFailedIds,
    canvasThumbPending,
    canvasThumbFailed,
    mainFrameBlob,
    // 同步工具
    videoUrlOf,
    thumbUrlOf,
    thumbModeOf,
    onVideoError,
    onThumbError,
    // 异步工具
    loadVideoUrl,
    loadThumbUrl,
    triggerCanvasThumbs,
    generateMainFrame,
  };
}