<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import type { GenerationRecord } from "../services/messages";
import { bridge } from "../services/bridge";

const props = defineProps<{
  records: GenerationRecord[];
  initialSelectedId?: string;
  /** 正在生成的记录（用于在大视频预览区显示"生成中"卡片） */
  generating?: GenerationRecord | null;
}>();
const emit = defineEmits<{
  select: [GenerationRecord];
  "import-to-project": [string[]];
  delete: [string];
  retry: [GenerationRecord];
  "use-as-reference": [GenerationRecord];
  upgrade: [GenerationRecord];
}>();

const selectedId = ref<string | null>(props.initialSelectedId || props.records[0]?.id || null);

// 视频播放控制
const mainVideoRef = ref<HTMLVideoElement | null>(null);
// 每秒 tick 一次，让 generatingElapsed 自动刷新
const tick = ref(0);
let tickTimer: any = null;
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick.value++;
  }, 1000);
}
function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}
const isPlaying = ref(false);
function togglePlay() {
  const v = mainVideoRef.value;
  if (!v) return;
  if (v.paused) {
    v.play().catch(() => {});
  } else {
    v.pause();
  }
}

/**
 * 强制首帧渲染：通过 currentTime 微调触发 seeked 事件，让 video 元素真正把首帧绘制到画面上。
 * - 不用 play() → 不会触发 @play 中间状态（避免切记录时偶发性自动播放）
 * - 不用 pause() → 不会跨越记录去修改旧 video 的状态
 * - loadedmetadata 后 currentTime 已经默认在 0，但某些 webview 不会渲染；
 *   把 currentTime 设到 0.001 强制触发 seeked 即可拿到首帧画面
 * - 用 module-level 代号 primeSeq 防止旧记录残留的 seeked 回调污染新记录
 */
let firstFramePrimed = false;
let primeSeq = 0;
function primeFirstFrame() {
  const v = mainVideoRef.value;
  if (!v || firstFramePrimed) return;
  // 当前已处于播放态 → 用户主动在播，不要做任何 prime
  if (isPlaying.value) {
    firstFramePrimed = true;
    return;
  }
  firstFramePrimed = true;
  // 确保 video 处于 paused 状态（template 已经没显式 paused，要保护性 set 一下）
  try {
    if (!v.paused) v.pause();
  } catch (_) {}
  // 代号：切记录会递增，旧回调到来时直接忽略
  const mySeq = ++primeSeq;
  const onSeeked = () => {
    if (mySeq !== primeSeq) return; // 旧记录残留的回调，丢弃
    v.removeEventListener("seeked", onSeeked);
    // 不再做任何 video 操作；用户后续点 play 由 togglePlay 自己负责
  };
  v.addEventListener("seeked", onSeeked, { once: true });
  // 触发 seek：用 0.001 微偏移让 webview 真正 seek 到首帧（currentTime=0 在某些实现下不触发 seeked）
  try {
    v.currentTime = 0.001;
  } catch (_) {
    // 极端兜底：设不到就保持原状
    v.removeEventListener("seeked", onSeeked);
  }
}
// 切换记录时重置播放状态
watch(selectedId, () => {
  isPlaying.value = false;
  firstFramePrimed = false; // 新记录：允许重新触发首帧 seek
  primeSeq++; // 让旧记录残留的 seeked 回调失效
  const v = mainVideoRef.value;
  if (v && !v.paused) v.pause();
});

watch(
  () => props.records,
  (rs) => {
    if (!selectedId.value || !rs.find((r) => r.id === selectedId.value)) {
      selectedId.value = rs[0]?.id || null;
    }
  },
  { immediate: true },
);

const selected = computed(() =>
  props.records.find((r) => r.id === selectedId.value) || null,
);

// 每个 record 一个视频 URL：优先 file://（零拷贝，webview 已开 allowLocalRendering），
// file:// 被拦截时（onVideoError）仅对该记录回退 base64 data URL
const videoUrlCache = ref<Record<string, string>>({});
const thumbUrlCache = ref<Record<string, string>>({});
const loadingVideoIds = ref<Set<string>>(new Set());
const loadingThumbIds = ref<Set<string>>(new Set());
const fileUrlFailedIds = ref<Set<string>>(new Set());

/**
 * 缩略图：webview 端用隐藏 <video> + <canvas> + drawImage 抽首帧 → Blob URL 给 <img src> 用
 * - 优点：webview 端有完整浏览器栈，video/canvas 工作正常
 * - 内存缓存：recordId → blob URL（关闭面板失效，无需持久化）
 * - 失败保护：抽帧失败 → 永久标记 + 走 <video preload=metadata> 原路径
 * - 抽帧是 async 行为：第一次 thumbModeOf() 返回 'video'，抽帧完成后响应式刷新切到 'image'
 */
const canvasThumbCache = ref<Record<string, string>>({});  // recordId → blob: URL
const canvasThumbPending = ref<Set<string>>(new Set());
const canvasThumbFailed = ref<Set<string>>(new Set());

/**
 * 用隐藏 <video> 加载视频 → seek 0 → canvas drawImage → toBlob → blob URL
 * - 完整在 webview 端完成，避免 UXP 端的 video 元素 readyState 异常
 * - 与详情区 primeFirstFrame 用同样的 seek 0.001 技巧
 */
async function extractFirstFrame(recordId: string, videoUrl: string): Promise<string | null> {
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

    // 25s 总超时
    const timer = setTimeout(() => {
      done(null);
    }, 25000);

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
      // 双保险：seeked 后再 seek 0，让画面是首帧而不是中间帧
      try { video.currentTime = 0; } catch (_) {}
      requestAnimationFrame(() => {
        if (video.readyState >= 2) {
          if (!drawFromVideo()) {
            clearTimeout(timer);
            done(null);
          }
        } else {
          // 等第二次 seeked
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
      // readyState >= 2 时再 seek（loadeddata 在某些 webview 太早）
      if (video.readyState >= 2 && video.videoWidth) {
        try { video.currentTime = 0.001; } catch (_) {}
      }
    }, { once: true });
    video.addEventListener("canplay", () => {
      // canplay 兜底：buffer 完全 ready 后再 seek
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

async function getCanvasThumbUrl(rec: GenerationRecord): Promise<string | null> {
  if (!rec || !rec.workFile) return null;
  if (rec.status !== "generated" && rec.status !== "imported") return null;
  // 仅对视频类记录（workFile 是 mp4）
  if (canvasThumbCache.value[rec.id]) return canvasThumbCache.value[rec.id];
  if (canvasThumbFailed.value.has(rec.id)) return null;
  if (canvasThumbPending.value.has(rec.id)) return null;
  canvasThumbPending.value.add(rec.id);
  try {
    // 关键：之前用 thumbUrlOf()（纯同步读缓存）拿 url，但 thumbUrlCache 是异步
    // 填充的，triggerCanvasThumbs 立即执行时缓存还是空的 → 失败。
    // 改成直接 await resolveUrl() 拿真实可用的 file:// URL（与 videoUrlOf 同源）
    let vUrl = videoUrlOf(rec);
    if (!vUrl) {
      vUrl = await resolveUrl(rec);
    }
    if (!vUrl) {
      // resolveUrl 失败（文件不可访问 / file:// 被沙箱拒）→ 永久标记
      canvasThumbFailed.value.add(rec.id);
      return null;
    }
    const blobUrl = await extractFirstFrame(rec.id, vUrl);
    if (blobUrl) {
      canvasThumbCache.value = { ...canvasThumbCache.value, [rec.id]: blobUrl };
      return blobUrl;
    }
    // 抽帧失败：先不永久标记，让 records 变化 / watch 触发时重试
    // （避免 video 还在 loading 时过早判定）
    return null;
  } catch (_) {
    return null;
  } finally {
    canvasThumbPending.value.delete(rec.id);
  }
}

/** 缩略图显示模式 */
function thumbModeOf(rec: GenerationRecord): "image" | "video" | "placeholder" {
  if (rec.status !== "generated" && rec.status !== "imported") return "placeholder";
  if (canvasThumbCache.value[rec.id]) return "image";
  if (thumbUrlOf(rec)) return "video";
  return "placeholder";
}

/**
 * 触发 canvas 抽帧（在 mounted / records 变化 / 选中时）
 * - 顺序：先 await loadThumbUrl(rec) 等 url 就绪（确保 cache 有值），
 *   再调 getCanvasThumbUrl 拿真实 file:// URL，避免用空字符串触发永久失败
 * - 串行处理：避免一次创建 50 个隐藏 video 元素把 webview 卡死
 */
async function triggerCanvasThumbs() {
  for (const r of props.records) {
    if (canvasThumbCache.value[r.id]) continue;
    if (canvasThumbFailed.value.has(r.id)) continue;
    if (canvasThumbPending.value.has(r.id)) continue;
    try {
      // 先把 thumbUrlCache 加载好（fire-and-forget，但 await 让其完成）
      await loadThumbUrl(r);
      // 如果是当前选中的记录，顺便加载 videoUrlCache
      if (r.id === selectedId.value) {
        await loadVideoUrl(r);
      }
      await getCanvasThumbUrl(r);
    } catch (_) {
      // 忽略单个失败
    }
  }
}

/** 拿单个 record 的可播放 URL（file:// 优先） */
async function resolveUrl(rec: GenerationRecord): Promise<string> {
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
    // 失败/为空时放入空 URL 标记避免渲染层重复触发
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

/** <video> 加载 file:// 失败（被 webview 拦截）→ 仅该记录回退 base64 */
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
  if (selectedId.value === rec.id) await loadVideoUrl(rec);
}

/** 缩略图加载失败 → 置空该记录缩略图 URL，回退占位图（不回退 base64，避免拉整段视频） */
function onThumbError(rec: GenerationRecord) {
  thumbUrlCache.value = {
    ...thumbUrlCache.value,
    [rec.id]: { path: rec.workFile || "", url: "" },
  };
}

watch(
  () => props.records,
  (rs) => {
    rs.forEach((r) => {
      // workFile 变化（如导入后移动到项目旁 Imports/）→ 失效该记录预览缓存，按新路径重新加载
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
      if (selectedId.value && r.id === selectedId.value) loadVideoUrl(r);
    });
  },
  { immediate: true, deep: true },
);
watch(selectedId, (id) => {
  const rec = props.records.find((r) => r.id === id);
  if (rec) loadVideoUrl(rec);
});
onMounted(() => {
  props.records.forEach((r) => {
    loadThumbUrl(r);
    if (r.id === selectedId.value) loadVideoUrl(r);
  });
  // 触发 webview 端 canvas 抽帧（async，完成后 thumbModeOf 自动从 'video' 切到 'image'）
  triggerCanvasThumbs();
});

// records 变化时（新生成 / 导入完成），补抽帧
watch(
  () => props.records,
  () => {
    triggerCanvasThumbs();
  },
  { deep: true },
);

function statusOf(rec: GenerationRecord): { label: string; color: string } {
  switch (rec.status) {
    case "pending":
      return { label: "排队", color: "#888" };
    case "generating":
      return { label: "生成中", color: "#4b9cf5" };
    case "generated":
      return { label: "已生成", color: "#5cb85c" };
    case "imported":
      return { label: "已导入", color: "#5cb85c" };
    case "failed":
      return { label: "失败", color: "#d9534f" };
    default:
      return { label: rec.status, color: "#888" };
  }
}

const ERROR_TYPE_LABELS: Record<string, { title: string; cls: string }> = {
  insufficient_balance_error: { title: "💰 余额不足", cls: "failed-card-balance" },
  authorized_error: { title: "🔑 鉴权失败", cls: "failed-card-auth" },
  rate_limit_error: { title: "⏱ 触发限流", cls: "failed-card-ratelimit" },
  unprocessable_entity_error: {
    title: "⚠️ 内容敏感",
    cls: "failed-card-content",
  },
  bad_request_error: { title: "❌ 参数错误", cls: "failed-card-param" },
  server_error: { title: "💥 服务端错误", cls: "failed-card-server" },
  network_error: { title: "🌐 网络错误", cls: "failed-card-network" },
  missing_task_id: { title: "❓ 响应异常", cls: "failed-card-unknown" },
};

const failedCardClass = computed(() => {
  const t = selected.value?.error?.errorType;
  return ERROR_TYPE_LABELS[t || ""]?.cls || "failed-card-generic";
});

const failedTitle = computed(() => {
  const t = selected.value?.error?.errorType;
  if (t && ERROR_TYPE_LABELS[t]) return ERROR_TYPE_LABELS[t].title;
  if (selected.value?.error?.httpStatus === 402) return "💰 余额不足";
  if (selected.value?.error?.httpStatus === 401) return "🔑 鉴权失败";
  return "生成失败";
});

const errorTypeLabel = computed(() => {
  const t = selected.value?.error?.errorType;
  return t ? `错误类型: ${t}` : "";
});

const canRetrySelected = computed(() => {
  if (!selected.value) return false;
  // 余额不足 / 鉴权失败时不应直接"重试填入" — 但仍允许填回 UI 让用户改 prompt
  return !!selected.value.workFile || !!selected.value.prompt;
});

/** 当前选中记录的"生成中已耗时"（用于 generating 卡片显示） */
const generatingElapsed = computed(() => {
  const rec = selected.value;
  if (!rec?.submittedAt || rec.status !== "generating") return "";
  void tick.value;  // 依赖 tick 让每秒重新计算
  const ms = Date.now() - new Date(rec.submittedAt).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
});

// 根据选中记录的状态自动启停 tick
watch(
  () => selected.value?.status,
  (s) => {
    if (s === "generating") startTick();
    else stopTick();
  },
  { immediate: true },
);
onBeforeUnmount(stopTick);

function pick(rec: GenerationRecord) {
  selectedId.value = rec.id;
  emit("select", rec);
}

function videoUrlOf(rec: GenerationRecord) {
  const c = videoUrlCache.value[rec.id];
  return c && c.path === rec.workFile ? c.url : "";
}

function thumbUrlOf(rec: GenerationRecord) {
  const c = thumbUrlCache.value[rec.id];
  if (!c || c.path !== rec.workFile) return ""; // 无缓存或路径已变化
  return c.url;
}

function importToProjectSelected() {
  if (selected.value) emit("import-to-project", [selected.value.id]);
}
function retrySelected() {
  if (selected.value) emit("retry", selected.value);
}
function deleteSelected() {
  if (selected.value) emit("delete", selected.value.id);
}

/** 是否允许对此记录发起"像素提升到 2K"：
 *  - 模型必须是 H3（官方仅 H3 支持 video_regeneration）
 *  - 当前分辨率必须是 768P（已是 2K 不需要升级；480P 仅 H3-Max 支持而 H3-Max 不支持升级）
 *  - 状态必须是已生成 / 已导入（未生成没有源视频；生成中 / 失败也不允许）
 *  - 源任务必须已有 taskId
 */
const canUpgradeTo2K = computed(() => {
  const r = selected.value;
  if (!r) return false;
  if (r.status !== "generated" && r.status !== "imported") return false;
  if (r.params.model !== "MiniMax-H3") return false;
  if (r.params.resolution !== "768P") return false;
  if (!r.taskId) return false;
  return true;
});

function upgradeSelected() {
  if (selected.value) emit("upgrade", selected.value);
}
function useAsReference(rec: GenerationRecord) {
  emit("use-as-reference", rec);
}

/** 视频预览可拖拽：
 *  - dragstart：只传 native path，dataTransfer setData("text/uri-list", "file://...")
 *    （参考 Finder 拖拽语义 —— Finder 拖文件到 PR 也是只传路径）
 *  - dragend：dropEffect='none' 说明没有可接收目标 → fallback 弹 confirm 走按钮插入流程
 */
let dragStartedAt = 0;
let dragDropEffect: string | null = null;

function onDragStart(e: DragEvent) {
  if (!selected.value?.workFile) {
    e.preventDefault();
    return;
  }
  dragStartedAt = Date.now();
  dragDropEffect = null;
  const dt = e.dataTransfer;
  if (!dt) return;
  const nativePath = selected.value.workFile;
  const fileUrl = `file://${nativePath.replace(/ /g, "%20")}`;

  // 只传路径（仿 Finder 拖拽）
  dt.setData("text/uri-list", fileUrl);
  dt.setData("text/plain", fileUrl);
  dt.setData("text/x-rocx-record-id", selected.value.id);

  dt.effectAllowed = "copy";
  dt.dropEffect = "copy";
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function onDragEnd(e: DragEvent) {
  dragDropEffect = e.dataTransfer?.dropEffect ?? null;
  if (!selected.value?.workFile) return;
  if (Date.now() - dragStartedAt < 120) return;
  const accepted = ["copy", "move", "link"].includes(dragDropEffect ?? "");
  if (!accepted) {
    // 拖拽未被 PR 时间线接收 → fallback 弹导入到工程
    const ok = confirm(
      `未拖到 PR 时间线。是否改为导入到工程（出现在 Project 面板，不插入时间线）？`,
    );
    if (ok) emit("import-to-project", [selected.value.id]);
  }
}

const sortedRecords = computed(() => {
  return [...props.records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
});
</script>

<template>
  <section v-if="records.length > 0" class="records-panel">
    <!-- 左列：缩略图（竖向滚动） -->
    <div class="thumb-column">
      <div
        v-for="rec in sortedRecords"
        :key="rec.id"
        :class="['thumb-item', { active: rec.id === selectedId }]"
        @click="pick(rec)"
        :title="rec.prompt.slice(0, 60)"
      >
        <!-- 优先用 webview 端 canvas 抽帧得到的 blob URL（轻量、立即显示） -->
        <img
          v-if="thumbModeOf(rec) === 'image'"
          :src="canvasThumbCache[rec.id]"
          class="thumb-image"
          draggable="false"
        />
        <!-- 回退：<video preload="metadata"> 抽帧（canvas 抽帧进行中 / 失败） -->
        <video
          v-else-if="thumbModeOf(rec) === 'video'"
          :src="thumbUrlOf(rec)"
          class="thumb-video"
          muted
          preload="metadata"
          @error="onThumbError(rec)"
          @loadedmetadata="onMediaLoaded"
        />
        <div v-else class="thumb-placeholder">
          <span class="thumb-placeholder-icon">{{ rec.status === 'failed' ? '⚠' : '🎬' }}</span>
        </div>
        <div
          class="thumb-status"
          :style="{ background: statusOf(rec).color }"
          :title="statusOf(rec).label"
        ></div>
      </div>
    </div>

    <!-- 右列：详情 -->
    <div class="detail-column" v-if="selected">
      <!-- 顶部：参数摘要 + 提示词 + 状态 + 操作（一行；窄屏时隐藏提示词） -->
      <header class="detail-header">
        <div class="meta-line">
          <span
            v-if="selected.upgradedFromResolution"
            class="meta-badge upgrade-badge"
            :title="`由 ${selected.upgradedFromResolution} 升级而来`"
          >⬆ 升级</span>
          <span class="meta-model">{{ selected.params.model }}</span>
          <span class="meta-sep">·</span>
          <span class="meta-param">{{ selected.params.ratio }}</span>
          <span class="meta-sep">·</span>
          <span class="meta-param">{{ selected.params.duration }}s</span>
          <span class="meta-sep">·</span>
          <span class="meta-param">{{ selected.params.resolution }}</span>
          <span class="meta-sep">·</span>
          <span class="prompt-inline" :title="selected.prompt">{{ selected.prompt }}</span>
          <span class="meta-spacer"></span>
          <span class="status-dot" :style="{ background: statusOf(selected).color }"></span>
          <span class="status-label">{{ statusOf(selected).label }}</span>
          <button
            v-if="selected.status === 'failed' && selected.taskId"
            class="header-btn"
            @click="retrySelected"
            title="重试"
          >↻ 重试</button>
        </div>
      </header>

      <!-- 主预览 / 失败信息 -->
      <div class="preview-area">
        <div class="main-video-wrap">
          <video
            v-if="selected.workFile && videoUrlOf(selected)"
            ref="mainVideoRef"
            :src="videoUrlOf(selected)"
            class="main-video"
            preload="metadata"
            muted
            playsinline
            draggable="true"
            @error="onVideoError(selected)"
            @loadeddata="primeFirstFrame"
            @click="togglePlay"
            @dragstart="onDragStart"
            @dragover="onDragOver"
            @dragend="onDragEnd"
            @play="isPlaying = true"
            @pause="isPlaying = false"
          />
          <!-- 中心播放按钮 SVG -->
          <div
            v-if="!isPlaying && selected.workFile && videoUrlOf(selected)"
            class="play-overlay"
            @click.stop="togglePlay"
          >
            <svg viewBox="0 0 80 80" width="80" height="80">
              <circle cx="40" cy="40" r="36" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.6)" stroke-width="2"/>
              <polygon points="32,24 32,56 60,40" fill="#fff"/>
            </svg>
          </div>
          <div v-else-if="selected.status === 'generating'" class="failed-card generating-card">
            <!-- 顶部动态动画条 -->
            <div class="generating-bar">
              <div class="generating-bar-fill" />
            </div>
            <div class="failed-title">⏳ 生成中 · {{ generatingElapsed }}</div>
            <div class="failed-msg">{{ selected.prompt }}</div>
            <div v-if="selected.taskId" class="failed-req">
              task_id: {{ selected.taskId }}
            </div>
          </div>
          <div v-else-if="selected.status === 'failed'" class="failed-card" :class="failedCardClass">
            <div class="failed-title">{{ failedTitle }}</div>
            <div class="failed-msg">{{ selected.error?.message || '未知错误' }}</div>
            <div v-if="selected.error?.requestId" class="failed-req">
              request_id: {{ selected.error.requestId }}
            </div>
            <div v-if="selected.error?.errorType" class="failed-type">
              {{ errorTypeLabel }}
            </div>
            <div v-if="selected.error?.httpStatus" class="failed-status">
              HTTP {{ selected.error.httpStatus }}
            </div>
            <button
              v-if="canRetrySelected"
              class="retry-btn"
              @click="retrySelected"
            >↻ 填入生成器</button>
          </div>
        </div>
      </div>

      <!-- 底部操作按钮行 -->
      <div class="action-row">
        <button
          v-if="selected.workFile && (selected.status === 'generated' || selected.status === 'imported' || selected.status === 'failed')"
          class="action-btn primary"
          @click="importToProjectSelected"
          title="仅导入到 PR Project 面板，不插入时间线"
        >导入到工程</button>
        <button
          v-if="canUpgradeTo2K"
          class="action-btn upgrade-btn"
          @click="upgradeSelected"
          title="调用 video_regeneration 把这条 768P 视频提升到 2K（H3 专用）"
        >⬆ 升级到 2K</button>
        <button
          class="action-btn"
          @click="retrySelected"
          title="把这条记录的 prompt / 参数 / 参考素材填回生成器（不自动提交）"
        >↻ 填入生成器</button>
        <span class="action-spacer"></span>
        <button
          v-if="selected.status === 'generated' || selected.status === 'imported'"
          class="action-btn reference-btn"
          @click="useAsReference(selected)"
          title="把这条记录的视频作为参考素材添加到生成器"
        >用作参考</button>
      </div>
    </div>

    <div v-else class="detail-empty">选择左侧缩略图查看详情</div>
  </section>
</template>

<style lang="scss" scoped>
.records-panel {
  display: flex;
  flex: 1;
  min-height: 0;          /* 允许 flex 子项按容器收缩（thumb-column 滚动条生效关键） */
  overflow: hidden;
  /* 浮动窗 (.floating-prompt-bar) 绝对定位覆盖底部 ~80px，
     这里 padding-bottom 让 thumb-column 高度扣除浮动窗占位，滚动条按时出现 */
  padding-bottom: 100px;
  box-sizing: border-box;
}

/* 左列：缩略图（保留滚动能力但隐藏滚动条 UI） */
.thumb-column {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 4px;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  /* 高度约束：min-height:0 让 flex row 不撑大父容器；
     flex-grow:0 + flex-basis:auto 让高度完全受父容器约束 → 溢出触发滚动 */
  min-height: 0;
  align-self: stretch;
  border-right: 1px solid var(--uxp-host-border-color, #454545);
  /* 隐藏滚动条 UI（但保留滚动能力：鼠标滚轮 / 触控板 / 拖动均可） */
  scrollbar-width: none;             /* Firefox */
  -ms-overflow-style: none;          /* IE / 旧 Edge */
}

.thumb-item {
  position: relative;
  /* width 100% + box-sizing 让缩略图严格按 80px 容器宽度计算，
     不被 thumb-column padding 干扰 */
  width: 100%;
  box-sizing: border-box;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.15s;
  flex-shrink: 0;          /* 不压缩；溢出时让父容器出滚动条 */

  &:hover {
    border-color: var(--uxp-host-border-color, #666);
  }

  &.active {
    border-color: var(--uxp-host-link-text-color, #4b9cf5);
  }
}
.thumb-column::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;                     /* Chromium / WebKit / Bolt UXP webview */
}

.thumb-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* UXP 端抽帧 JPG（首帧缓存），与 .thumb-video 共用 16:9 容器布局 */
.thumb-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* 防止图片未加载完成时容器塌缩到 0（与 .thumb-item 的 aspect-ratio:16/9 配合即可） */
  background: #000;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--uxp-host-border-color, #383838);
}
.thumb-placeholder-icon {
  font-size: 18px;
  opacity: 0.6;
}

.thumb-status {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}

/* 右列：详情 */
.detail-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 6px 8px 4px; // 底部只留少量间距：让 .preview-area 自身贴近下方的 .floating-prompt-bar
  overflow: hidden;
  min-width: 0;
}

.detail-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 0 4px;
  flex-shrink: 0;
  container-type: inline-size;
  container-name: detail-header;
}

.meta-line {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.meta-model {
  font-weight: 600;
  color: var(--uxp-host-text-color, #fff);
}
.meta-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
  flex-shrink: 0;
  line-height: 1.3;
}
.upgrade-badge {
  background: rgba(255, 165, 0, 0.18);
  color: #ffa500;
  border: 1px solid rgba(255, 165, 0, 0.4);
}
.meta-sep {
  opacity: 0.4;
}
.meta-param {
  opacity: 0.8;
}
.meta-spacer {
  flex: 1;
  min-width: 4px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-label {
  font-size: 11px;
  opacity: 0.85;
}
.header-btn {
  background: var(--uxp-host-border-color, #383838);
  color: inherit;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
}

/* 提示词（meta-line 内联，自动收缩省略号） */
.prompt-inline {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
  font-size: 11px;
}

/* 容器查询：detail-header 太窄时隐藏提示词
   （参数 + 状态 + 操作固定占空间，提示词按比例收缩后仍可能挤不下时整段隐藏） */
@container detail-header (max-width: 360px) {
  .prompt-inline {
    display: none;
  }
}

/* 主预览 */
.preview-area {
  flex: 1;
  min-height: 120px;
  margin-top: 4px;
  overflow: hidden;
}

.main-video-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.main-video {
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  object-fit: contain;
  background: #000;
  border-radius: 4px;
  display: block;
  cursor: pointer;
}

.play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  z-index: 5;
}

.preview-loading {
  font-size: 12px;
  opacity: 0.6;
  padding: 20px;
}

.failed-card {
  padding: 12px;
  background: rgba(217, 83, 79, 0.1);
  border: 1px solid rgba(217, 83, 79, 0.4);
  border-radius: 4px;
  font-size: 11px;
  width: 100%;
  text-align: left;
}
.failed-title {
  font-weight: 600;
  color: #d9534f;
  margin-bottom: 4px;
  font-size: 13px;
}
.failed-msg {
  margin-bottom: 2px;
  word-break: break-word;
  /* 提示词过长时最多显示 4 行并省略，避免撑高失败卡片挤掉视频预览 */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  line-clamp: 4;
}
.failed-req {
  opacity: 0.7;
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
  margin-bottom: 2px;
}
.failed-type {
  opacity: 0.6;
  font-size: 10px;
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  margin-bottom: 2px;
}
.failed-status {
  opacity: 0.6;
  font-size: 10px;
  margin-bottom: 6px;
}

/* 余额不足：更醒目的橙色 */
.failed-card-balance {
  background: rgba(255, 165, 0, 0.12);
  border-color: rgba(255, 165, 0, 0.5);
  .failed-title {
    color: #ffa500;
  }
}
.failed-card-auth {
  background: rgba(220, 53, 69, 0.15);
  border-color: rgba(220, 53, 69, 0.5);
}

/* 生成中卡片（继承 failed-card 样式 + 蓝色主题 + 顶部动态条） */
.generating-card {
  background: rgba(75, 156, 245, 0.08);
  border-color: rgba(75, 156, 245, 0.4);
  overflow: hidden;
  position: relative;
  .failed-title {
    color: var(--uxp-host-link-text-color, #4b9cf5);
    margin-top: 4px;
  }
}
.generating-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(75, 156, 245, 0.1);
  overflow: hidden;
}
.generating-bar-fill {
  height: 100%;
  width: 30%;
  background: linear-gradient(
    90deg,
    transparent,
    var(--uxp-host-link-text-color, #4b9cf5),
    transparent
  );
  animation: generating-indeterminate 1.4s infinite linear;
}
@keyframes generating-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.retry-btn {
  padding: 3px 10px;
  font-size: 11px;
  background: #d9534f;
  color: #fff;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  &:hover { opacity: 0.85; }
}

.empty-card {
  font-size: 12px;
  opacity: 0.5;
  padding: 30px;
}

.detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  opacity: 0.5;
}

/* 操作按钮行 */
.action-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-shrink: 0;
}
.action-spacer {
  flex: 1;
}
.action-btn {
  padding: 4px 10px;
  font-size: 11px;
  background: var(--uxp-host-border-color, #383838);
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  &.primary {
    background: var(--uxp-host-link-text-color, #4b9cf5);
    color: #fff;
  }
  &.upgrade-btn {
    background: rgba(255, 165, 0, 0.18);
    color: #ffa500;
    &:hover:not(:disabled) {
      background: rgba(255, 165, 0, 0.32);
    }
  }
  &.danger {
    background: rgba(217, 83, 79, 0.2);
    color: #d9534f;
    &:hover {
      background: rgba(217, 83, 79, 0.35);
    }
  }
}
</style>