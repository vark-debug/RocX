<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import type { GenerationRecord } from "@shared/messages";
import { bridge } from "../services/bridge";

const props = defineProps<{
  records: GenerationRecord[];
}>();
const emit = defineEmits<{
  "use-as-reference": [GenerationRecord];
}>();

const urlCache = ref<Record<string, string>>({});
const loadingIds = ref<Set<string>>(new Set());

async function resolveUrls() {
  for (const rec of props.records) {
    if (!rec.workFile) continue;
    if (urlCache.value[rec.id]) continue;
    if (loadingIds.value.has(rec.id)) continue;
    loadingIds.value.add(rec.id);
    try {
      const r = await bridge.readAsDataUrl(rec.workFile);
      if (r.ok && r.dataUrl) {
        urlCache.value = { ...urlCache.value, [rec.id]: r.dataUrl };
      } else {
        console.warn("[PreviewGrid] readAsDataUrl failed", rec.id, r.error);
      }
    } catch (e) {
      console.warn("[PreviewGrid] readAsDataUrl exception", e);
    } finally {
      loadingIds.value.delete(rec.id);
    }
  }
}

watch(() => props.records, resolveUrls, { immediate: true, deep: true });
onMounted(resolveUrls);

const sortedRecords = computed(() => {
  return [...props.records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
});

function urlOf(rec: GenerationRecord) {
  return urlCache.value[rec.id] || "";
}
</script>

<template>
  <section v-if="sortedRecords.length > 0" class="preview-section">
    <div class="preview-header">已生成 ({{ sortedRecords.length }})</div>
    <div class="preview-grid">
      <div
        v-for="rec in sortedRecords"
        :key="rec.id"
        class="preview-item"
        @click="emit('use-as-reference', rec)"
        :title="rec.prompt.slice(0, 60)"
      >
        <video
          v-if="rec.workFile && urlOf(rec)"
          :src="urlOf(rec)"
          class="preview-video"
          muted
          loop
          preload="metadata"
          @mouseenter="($event.target as HTMLVideoElement).play().catch(() => {})"
          @mouseleave="($event.target as HTMLVideoElement).pause()"
        />
        <div v-else-if="rec.workFile" class="preview-loading">⏳</div>
        <div class="preview-overlay">
          <span class="status-tag" v-if="rec.status === 'imported'">已导入</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.preview-section {
  padding: 4px 8px;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  flex-shrink: 0;
}

.preview-header {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.8;
  margin-bottom: 4px;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
  gap: 4px;
}

.preview-item {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--uxp-host-border-color, #383838);
  border-radius: 3px;
  overflow: hidden;
  cursor: pointer;
  &:hover {
    outline: 1px solid var(--uxp-host-link-text-color, #4b9cf5);
  }
}

.preview-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-loading {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  opacity: 0.5;
}

.preview-overlay {
  position: absolute;
  top: 2px;
  right: 2px;
}

.status-tag {
  font-size: 9px;
  padding: 1px 3px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 2px;
}
</style>