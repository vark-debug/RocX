<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { GenerationRecord } from "@shared/messages";
import type { RecordActionsApi, ProjectInfo } from "../composables/useRecordActions";
import {
  isForeignRecord,
  foreignProjectName,
} from "../composables/useRecordActions";
import type { RecordPreviewApi } from "../composables/useRecordPreview";

/**
 * 信息流单条记录块：
 *   行1  meta 摘要（模型 · 比例/像素 · 时长 · 分辨率 · 提示词 · 状态）
 *   行2  强制 16:9 预览容器（竖屏视频 letterbox；块高度由容器宽度决定）
 *   行3  操作行（导入到工程 / 升级2K / 填入生成器 / 用作参考）
 */
const props = defineProps<{
  rec: GenerationRecord;
  /** 当前活动工程（判定多工程归属提示） */
  currentProject?: ProjectInfo | null;
  actions: RecordActionsApi;
  preview: RecordPreviewApi;
  /** <video> 是否已挂载（父层 IntersectionObserver 惰性控制） */
  videoMounted: boolean;
  /** 正在播放的记录 id（播放互斥） */
  playingId: string | null;
}>();

const emit = defineEmits<{
  play: [string];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const localPlaying = ref(false);

const isImage = computed(() => props.rec.kind === "image");
const st = computed(() => props.actions.statusOf(props.rec));
const isForeign = computed(() => isForeignRecord(props.rec, props.currentProject));
const foreignName = computed(() => foreignProjectName(props.rec));

const videoUrl = computed(() => props.preview.videoUrlOf(props.rec));
/** 视频 <video> 元素：仅本地文件 URL 就绪 + 父层挂载许可时才渲染（惰性挂载） */
const showVideo = computed(
  () =>
    !isImage.value &&
    !!props.rec.workFile &&
    props.videoMounted &&
    !!videoUrl.value,
);
const showImage = computed(
  () => isImage.value && !!(props.rec.resultUrl || props.rec.workFile),
);
const imageUrl = computed(() => videoUrl.value || props.rec.resultUrl || "");

/** 未挂载 <video> 时的大图占位：优先 canvas 抽帧首帧（后台批量生成） */
const lazyThumb = computed(() => {
  if (isImage.value) return "";
  if (props.rec.status !== "generated" && props.rec.status !== "imported")
    return "";
  return props.preview.canvasThumbCache.value[props.rec.id] || "";
});

const kindIcon = computed(() =>
  props.rec.status === "failed" ? "⚠" : isImage.value ? "🖼" : "🎬",
);

const canImport = computed(
  () =>
    !!(props.rec.workFile || (isImage.value && props.rec.resultUrl)) &&
    ["generated", "imported", "failed"].includes(props.rec.status),
);

const drag = computed(() => props.actions.bindDragHandlers(props.rec));

function togglePlay() {
  const v = videoRef.value;
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function onLocalPlay() {
  localPlaying.value = true;
  emit("play", props.rec.id);
}

// 播放互斥：其它块开始播放时暂停自己
watch(
  () => props.playingId,
  (id) => {
    if (id === props.rec.id) return;
    const v = videoRef.value;
    if (v && !v.paused) v.pause();
    localPlaying.value = false;
  },
);

// 视频元素被惰性卸载时重置播放态
watch(
  () => props.videoMounted,
  (m) => {
    if (!m) localPlaying.value = false;
  },
);
</script>

<template>
  <article class="record-block">
    <!-- 行1：参数摘要 + 提示词 + 状态 -->
    <header class="meta-line">
      <span
        v-if="rec.upgradedFromResolution"
        class="meta-badge upgrade-badge"
        :title="`由 ${rec.upgradedFromResolution} 升级而来`"
      >⬆ 升级</span>
      <span class="meta-model">{{ rec.params.model }}</span>
      <span class="meta-sep">·</span>
      <!-- 图片记录展示实际输出像素（智能档时 ratio 与输出无关）；视频仍显示比例 -->
      <span v-if="isImage && rec.imageParams" class="meta-param">
        {{ rec.imageParams.width }}×{{ rec.imageParams.height }}
      </span>
      <span v-else class="meta-param">{{ rec.params.ratio }}</span>
      <template v-if="!isImage">
        <span class="meta-sep">·</span>
        <span class="meta-param">{{ rec.params.duration }}s</span>
      </template>
      <span class="meta-sep">·</span>
      <span class="meta-param">{{ rec.params.resolution }}</span>
      <span class="meta-sep">·</span>
      <span class="prompt-inline" :title="rec.prompt">{{ rec.prompt }}</span>
      <span class="meta-spacer"></span>
      <span class="status-dot" :style="{ background: st.color }"></span>
      <span class="status-label">{{ st.label }}</span>
      <button
        v-if="rec.status === 'failed' && rec.taskId"
        class="header-btn"
        title="重试"
        @click="actions.emitRetry(rec)"
      >↻ 重试</button>
    </header>

    <!-- 行2：强制 16:9 预览容器（竖屏视频 letterbox，操作行以此容器定位） -->
    <div class="preview-frame">
      <video
        v-if="showVideo"
        ref="videoRef"
        :src="videoUrl"
        class="frame-video"
        preload="metadata"
        muted
        playsinline
        draggable="true"
        @error="preview.onVideoError(rec)"
        @click="togglePlay"
        @dragstart="drag.onDragStart"
        @dragover="drag.onDragOver"
        @dragend="drag.onDragEnd"
        @play="onLocalPlay"
        @pause="localPlaying = false"
      />
      <!-- 图片记录大图预览：优先本地 workFile（永不过期），回退 resultUrl -->
      <img
        v-else-if="showImage"
        :src="imageUrl"
        class="frame-image"
        draggable="false"
      />
      <!-- 视频未挂载 <video> 时：显示 canvas 抽帧首帧 -->
      <img
        v-else-if="lazyThumb"
        :src="lazyThumb"
        class="frame-image"
        draggable="false"
      />
      <div
        v-else-if="rec.status !== 'generating' && rec.status !== 'failed'"
        class="frame-placeholder"
      >
        <span class="frame-placeholder-icon">{{ kindIcon }}</span>
      </div>

      <!-- 中心播放按钮 SVG（仅视频） -->
      <div
        v-if="showVideo && !localPlaying"
        class="play-overlay"
        @click.stop="togglePlay"
      >
        <svg viewBox="0 0 80 80" width="80" height="80">
          <circle cx="40" cy="40" r="36" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.6)" stroke-width="2"/>
          <polygon points="32,24 32,56 60,40" fill="#fff"/>
        </svg>
      </div>

      <!-- 生成中 / 失败卡片（无视频可显示时占据预览容器） -->
      <div
        v-if="!showVideo && rec.status === 'generating'"
        class="failed-card generating-card"
      >
        <div class="generating-bar">
          <div class="generating-bar-fill" />
        </div>
        <div class="failed-title">⏳ 生成中 · {{ actions.generatingElapsedOf(rec) }}</div>
        <div class="failed-msg">{{ rec.prompt }}</div>
        <div v-if="rec.taskId" class="failed-req">
          task_id: {{ rec.taskId }}
        </div>
        <!-- 多工程：在飞任务属于其它工程（切回该工程后才会看到它的产物） -->
        <div v-if="isForeign" class="foreign-task-hint">
          ⏳ 该任务属于其它工程「{{ foreignName }}」，完成后切回该工程查看
        </div>
      </div>
      <div
        v-else-if="!showVideo && rec.status === 'failed'"
        class="failed-card"
        :class="actions.failedCardClassOf(rec)"
      >
        <div class="failed-title">{{ actions.failedTitleOf(rec) }}</div>
        <div class="failed-msg">{{ rec.error?.message || '未知错误' }}</div>
        <div v-if="rec.error?.requestId" class="failed-req">
          request_id: {{ rec.error.requestId }}
        </div>
        <div v-if="rec.error?.errorType" class="failed-type">
          {{ actions.errorTypeLabelOf(rec) }}
        </div>
        <div v-if="rec.error?.httpStatus" class="failed-status">
          HTTP {{ rec.error.httpStatus }}
        </div>
        <button
          v-if="actions.canRetryOf(rec)"
          class="retry-btn"
          @click="actions.emitRetry(rec)"
        >↻ 填入生成器</button>
      </div>
    </div>

    <!-- 行3：操作按钮行（贴 16:9 容器下方） -->
    <div class="action-row">
      <button
        v-if="canImport"
        class="action-btn primary"
        title="仅导入到 PR Project 面板，不插入时间线"
        @click="actions.emitImport(rec)"
      >导入到工程</button>
      <button
        v-if="actions.canUpgradeTo2KOf(rec)"
        class="action-btn upgrade-btn"
        title="调用 video_regeneration 把这条 768P 视频提升到 2K（H3 专用）"
        @click="actions.emitUpgrade(rec)"
      >⬆ 升级到 2K</button>
      <button
        class="action-btn"
        title="把这条记录的 prompt / 参数 / 参考素材填回生成器（不自动提交）"
        @click="actions.emitRetry(rec)"
      >↻ 填入生成器</button>
      <span class="action-spacer"></span>
      <button
        v-if="rec.status === 'generated' || rec.status === 'imported'"
        class="action-btn reference-btn"
        :title="isImage ? '把这张图片作为参考素材添加到生成器' : '把这条记录的视频作为参考素材添加到生成器'"
        @click="actions.emitUseAsReference(rec)"
      >用作参考</button>
    </div>
  </article>
</template>

<style lang="scss" src="./RecordFeedBlock.scss"></style>
