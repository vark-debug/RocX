<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import type { GenerationRecord } from "@shared/messages";
import { useRecordPreview } from "../composables/useRecordPreview";
import {
  useRecordActions,
  isForeignRecord,
  foreignProjectName,
} from "../composables/useRecordActions";
import RecordFeedBlock from "./RecordFeedBlock.vue";

const props = defineProps<{
  records: GenerationRecord[];
  initialSelectedId?: string;
  /** 正在生成的记录（用于生成中卡片显示耗时） */
  generating?: GenerationRecord | null;
  /** 当前活动工程（PR 同进程可打开多个工程，用于判定记录归属） */
  currentProject?: { path: string; guid: string; name?: string } | null;
}>();
const emit = defineEmits<{
  select: [GenerationRecord];
  "import-to-project": [string[]];
  delete: [string];
  retry: [GenerationRecord];
  "use-as-reference": [GenerationRecord];
  upgrade: [GenerationRecord];
}>();

// 操作（选中 / 播放互斥 / 状态展示 / 升级判定 / 拖拽 / 操作发射）
const actions = useRecordActions(
  () => props.records,
  props.initialSelectedId,
  {
    onSelect: (rec) => emit("select", rec),
    onImportToProject: (ids) => emit("import-to-project", ids),
    onRetry: (rec) => emit("retry", rec),
    onDelete: (id) => emit("delete", id),
    onUpgrade: (rec) => emit("upgrade", rec),
    onUseAsReference: (rec) => emit("use-as-reference", rec),
  },
);
// 模板用 computed 解包（RefAny 宽松类型无法被模板自动解包）
const sortedRecords = computed(() => actions.sortedRecords.value);
const playingId = computed(() => actions.playingId.value);

// 预览（canvas 抽帧 / URL 缓存）
const preview = useRecordPreview(
  () => props.records,
  () => actions.selectedId.value,
);

// ---------- 信息流滚动容器 ----------
const feedEl = ref<HTMLElement | null>(null);

// 左侧缩略图高亮：点击时立即切换；滚动时由 IntersectionObserver 反向同步
const activeThumbId = ref<string | null>(actions.selectedId.value);

// 惰性挂载集合：块进入可视范围（含预载边距）才挂 <video>，离开则卸载回收
const mountedVideoIds = ref<Set<string>>(new Set());

// 块元素注册表（ref 回调维护）+ 可视比例表（高亮反向同步）
const blockEls = new Map<string, HTMLElement>();
const visibleRatios = new Map<string, number>();
let mountObserver: IntersectionObserver | null = null;
let activeObserver: IntersectionObserver | null = null;

function registerBlock(id: string, el: unknown) {
  if (el) {
    const hel = el as HTMLElement;
    blockEls.set(id, hel);
    mountObserver?.observe(hel);
    activeObserver?.observe(hel);
  } else {
    const old = blockEls.get(id);
    if (old) {
      mountObserver?.unobserve(old);
      activeObserver?.unobserve(old);
      blockEls.delete(id);
      visibleRatios.delete(id);
      recomputeActive();
    }
  }
}

/** 高亮反向同步：取当前可视比例最大的块作为 active 缩略图 */
function recomputeActive() {
  let bestId = "";
  let best = 0;
  visibleRatios.forEach((ratio, id) => {
    if (ratio > best) {
      best = ratio;
      bestId = id;
    }
  });
  if (bestId) activeThumbId.value = bestId;
}

/** 惰性挂载观察：进入（含 600px 预载边距）→ 挂 <video> 并解析 URL；离开 → 卸载 */
function onMountIntersect(entries: IntersectionObserverEntry[]) {
  for (const en of entries) {
    const id = (en.target as HTMLElement).dataset.recId || "";
    if (!en.isIntersecting) {
      if (mountedVideoIds.value.has(id)) {
        const next = new Set(mountedVideoIds.value);
        next.delete(id);
        mountedVideoIds.value = next;
      }
      continue;
    }
    if (!mountedVideoIds.value.has(id)) {
      const next = new Set(mountedVideoIds.value);
      next.add(id);
      mountedVideoIds.value = next;
      const rec = props.records.find((r) => r.id === id);
      if (rec) preview.loadVideoUrl(rec);
    }
  }
}

/** 高亮观察：跟踪每块在真实可视区内的比例 */
function onActiveIntersect(entries: IntersectionObserverEntry[]) {
  for (const en of entries) {
    const id = (en.target as HTMLElement).dataset.recId || "";
    if (en.isIntersecting) visibleRatios.set(id, en.intersectionRatio);
    else visibleRatios.delete(id);
  }
  recomputeActive();
}

function ensureObservers() {
  // 兜底：无 IntersectionObserver 环境直接挂载全部视频（放弃惰性）
  if (typeof IntersectionObserver === "undefined") {
    mountedVideoIds.value = new Set(props.records.map((r) => r.id));
    return;
  }
  if (!mountObserver) {
    mountObserver = new IntersectionObserver(onMountIntersect, {
      root: feedEl.value || null,
      rootMargin: "600px 0px",
    });
    blockEls.forEach((el) => mountObserver!.observe(el));
  }
  if (!activeObserver) {
    activeObserver = new IntersectionObserver(onActiveIntersect, {
      root: feedEl.value || null,
      threshold: [0, 0.2, 0.5, 0.8],
    });
    blockEls.forEach((el) => activeObserver!.observe(el));
  }
}

onMounted(ensureObservers);

onBeforeUnmount(() => {
  mountObserver?.disconnect();
  activeObserver?.disconnect();
  mountObserver = null;
  activeObserver = null;
});

/** 缩略图点击：设置选中 + 平滑滚动到该块首行 */
function jumpTo(rec: GenerationRecord) {
  actions.pick(rec);
  activeThumbId.value = rec.id;
  const el = blockEls.get(rec.id);
  const scroller = feedEl.value;
  if (el && scroller) {
    scroller.scrollTo({
      top: Math.max(0, el.offsetTop - 4),
      behavior: "smooth",
    });
  }
}

function onBlockPlay(id: string) {
  actions.playingId.value = id;
}

/** 缩略图 URL：图片记录直接用 provider 返回的 resultUrl，视频记录用 canvas 抽帧 blob */
function thumbSrcOf(rec: GenerationRecord): string {
  if (rec.kind === "image") return rec.resultUrl || "";
  return preview.canvasThumbCache.value[rec.id] || "";
}
</script>

<template>
  <section v-if="records.length > 0" class="records-panel">
    <!-- 左列：缩略图导航（点击快速跳转到对应块首行；active 反向同步当前可视块） -->
    <div class="thumb-column">
      <div
        v-for="rec in sortedRecords"
        :key="rec.id"
        :class="['thumb-item', { active: rec.id === activeThumbId }]"
        @click="jumpTo(rec)"
        :title="rec.prompt.slice(0, 60)"
      >
        <!-- 优先用 webview 端 canvas 抽帧得到的 blob URL（轻量、立即显示）；图片记录直接用 resultUrl -->
        <img
          v-if="preview.thumbModeOf(rec) === 'image'"
          :src="thumbSrcOf(rec)"
          class="thumb-image"
          draggable="false"
        />
        <!-- 回退：<video preload="metadata"> 抽帧（canvas 抽帧进行中 / 失败） -->
        <video
          v-else-if="preview.thumbModeOf(rec) === 'video'"
          :src="preview.thumbUrlOf(rec)"
          class="thumb-video"
          muted
          preload="metadata"
          @error="preview.onThumbError(rec)"
        />
        <div v-else class="thumb-placeholder">
          <span class="thumb-placeholder-icon">{{ rec.status === 'failed' ? '⚠' : (rec.kind === 'image' ? '🖼' : '🎬') }}</span>
        </div>
        <div
          class="thumb-status"
          :style="{ background: actions.statusOf(rec).color }"
          :title="actions.statusOf(rec).label"
        ></div>
        <!-- 其它工程的记录：右上角小角标（pointer-events:none，不影响点击/拖拽） -->
        <span
          v-if="isForeignRecord(rec, currentProject)"
          class="foreign-badge"
          :title="`属于其它工程：${foreignProjectName(rec)}`"
        >◈</span>
      </div>
    </div>

    <!-- 右列：信息流（每条记录一个完整块：meta 行 / 16:9 预览 / 操作行） -->
    <div ref="feedEl" class="feed-column">
      <!-- ref 必须挂在原生 div 上：Vue 3 组件 ref 回调拿到的是组件实例而非 DOM，
           会导致 offsetTop undefined / IntersectionObserver.observe 失败 -->
      <div
        v-for="rec in sortedRecords"
        :key="rec.id"
        :ref="(el) => registerBlock(rec.id, el)"
        :data-rec-id="rec.id"
      >
        <RecordFeedBlock
          :rec="rec"
          :current-project="currentProject"
          :actions="actions"
          :preview="preview"
          :video-mounted="mountedVideoIds.has(rec.id)"
          :playing-id="playingId"
          @play="onBlockPlay"
        />
      </div>
    </div>
  </section>
</template>

<style lang="scss" src="./RecordsPanel.scss"></style>
