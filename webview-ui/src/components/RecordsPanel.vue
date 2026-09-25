<script setup lang="ts">
import type { GenerationRecord } from "@shared/messages";
import { useRecordPreview } from "../composables/useRecordPreview";
import { useRecordActions } from "../composables/useRecordActions";

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

// 操作（选中 / 状态展示 / 升级判定 / 拖拽 / 操作发射）
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

// 预览（canvas 抽帧 / URL 缓存）
const preview = useRecordPreview(
  () => props.records,
  () => actions.selectedId.value,
);

// 解构到顶层 — 让模板自动解包嵌套 ref/computed
const dragHandlers = actions.bindDragHandlers();
const {
  selectedId,
  selected,
  isPlaying,
  togglePlay,
  pick,
  statusOf,
  failedCardClass,
  failedTitle,
  errorTypeLabel,
  canRetrySelected,
  canUpgradeTo2K,
  generatingElapsed,
  sortedRecords,
  emitImportSelected,
  emitRetrySelected,
  emitUpgradeSelected,
  emitUseAsReference,
} = actions;
const {
  thumbModeOf,
  thumbUrlOf,
  videoUrlOf,
  onVideoError,
  onThumbError,
  mainFrameBlob,
  canvasThumbCache,
} = preview;
const mainVideoRef = actions.mainVideoRef;
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
            @click="emitRetrySelected"
            title="重试"
          >↻ 重试</button>
        </div>
      </header>

      <!-- 主预览 / 失败信息 -->
      <div class="preview-area">
        <div class="main-video-wrap">
          <!-- 大视频预览首帧遮罩：canvas 抽帧结果叠在 video 上方，避免 loadeddata 黑屏 -->
          <img
            v-if="mainFrameBlob && !isPlaying"
            :src="mainFrameBlob"
            class="main-frame-img"
            draggable="false"
            @click="togglePlay"
          />
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
            @click="togglePlay"
            @dragstart="dragHandlers.onDragStart"
            @dragover="dragHandlers.onDragOver"
            @dragend="dragHandlers.onDragEnd"
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
              @click="emitRetrySelected"
            >↻ 填入生成器</button>
          </div>
        </div>
      </div>

      <!-- 底部操作按钮行 -->
      <div class="action-row">
        <button
          v-if="selected.workFile && (selected.status === 'generated' || selected.status === 'imported' || selected.status === 'failed')"
          class="action-btn primary"
          @click="emitImportSelected"
          title="仅导入到 PR Project 面板，不插入时间线"
        >导入到工程</button>
        <button
          v-if="canUpgradeTo2K"
          class="action-btn upgrade-btn"
          @click="emitUpgradeSelected"
          title="调用 video_regeneration 把这条 768P 视频提升到 2K（H3 专用）"
        >⬆ 升级到 2K</button>
        <button
          class="action-btn"
          @click="emitRetrySelected"
          title="把这条记录的 prompt / 参数 / 参考素材填回生成器（不自动提交）"
        >↻ 填入生成器</button>
        <span class="action-spacer"></span>
        <button
          v-if="selected.status === 'generated' || selected.status === 'imported'"
          class="action-btn reference-btn"
          @click="emitUseAsReference(selected)"
          title="把这条记录的视频作为参考素材添加到生成器"
        >用作参考</button>
      </div>
    </div>

    <div v-else class="detail-empty">选择左侧缩略图查看详情</div>
  </section>
</template>

<style lang="scss" src="./RecordsPanel.scss"></style>
