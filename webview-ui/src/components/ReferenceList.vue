<script setup lang="ts">
import { computed } from "vue";
import type { ReferenceItem, FileKind } from "@shared/messages";

const props = defineProps<{
  references: ReferenceItem[];
}>();
const emit = defineEmits<{
  "update:references": [ReferenceItem[]];
  add: [FileKind];
  captureFrame: [];
  captureVideo: [];
  remove: [number];
}>();

function kindOf(ref: ReferenceItem): FileKind {
  if (ref.type === "reference_video") return "video";
  return "image";
}

function iconOf(ref: ReferenceItem): string {
  return kindOf(ref) === "video" ? "🎬" : "🖼";
}

function statusOf(ref: ReferenceItem): string {
  // 阶段 2：webview 标记的上传中（明确不会持久化到磁盘）
  if (ref.uploading) return "上传中…";
  // 阶段 3：上传完成（fileId 已设置）
  if (ref.fileId && ref.uploadedAt) {
    const age = Date.now() - new Date(ref.uploadedAt).getTime();
    if (age > 6 * 24 * 3600 * 1000) return "即将过期";
    return "已就绪";
  }
  // 阶段 1：导出完成（本地文件已生成，fileId 还没回填）
  return "已就绪";
}
</script>

<template>
  <section class="reference-section">
    <div class="ref-header">
      <span class="title">参考素材 ({{ references.length }})</span>
      <div class="add-buttons">
        <button @click="emit('captureVideo')" type="button" class="add-btn">🎬 抓视频</button>
        <button @click="emit('captureFrame')" type="button" class="add-btn">🖼 抓帧</button>
      </div>
    </div>
    <div v-if="references.length > 0" class="ref-list">
      <div
        v-for="(ref, idx) in references"
        :key="idx"
        class="ref-item"
      >
        <div class="ref-thumb">
          <img
            v-if="ref.type === 'reference_image' && ref.thumbDataUrl"
            :src="ref.thumbDataUrl"
            :alt="ref.fileName"
            class="thumb-img"
          />
          <span v-else class="ref-icon">{{ iconOf(ref) }}</span>
        </div>
        <span class="ref-name" :title="ref.localPath">{{ ref.fileName }}</span>
        <span class="ref-status">{{ statusOf(ref) }}</span>
        <button class="remove-btn" @click="emit('remove', idx)" type="button">×</button>
      </div>
      <div class="ref-tips">视频≤3 总时长≤15s · 图片≤9</div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.reference-section {
  padding: 2px 0 4px;
  flex-shrink: 0;
}

.ref-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  .title {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.8;
  }
}

.add-buttons {
  display: flex;
  gap: 2px;
}

.add-btn {
  padding: 2px 6px;
  font-size: 10px;
  background: var(--uxp-host-border-color, #383838);
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
}

.ref-list {
  margin-top: 4px;
}

.ref-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  font-size: 11px;
  background: var(--uxp-host-border-color, #383838);
  border-radius: 3px;
  margin-bottom: 2px;
}

.ref-thumb {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 2px;
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ref-icon {
  font-size: 12px;
}

.ref-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-status {
  font-size: 10px;
  opacity: 0.7;
}

.remove-btn {
  flex: 0 0 auto;
  padding: 0 4px;
  font-size: 12px;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  border-radius: 3px;
  &:hover {
    background: rgba(255, 0, 0, 0.3);
  }
}

.ref-tips {
  font-size: 10px;
  opacity: 0.6;
  margin-top: 2px;
}
</style>