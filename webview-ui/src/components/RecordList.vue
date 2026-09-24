<script setup lang="ts">
import { ref, computed } from "vue";
import type { GenerationRecord } from "../services/messages";

const props = defineProps<{
  records: GenerationRecord[];
}>();
const emit = defineEmits<{
  import: [string[]];
  delete: [string];
  retry: [GenerationRecord];
  "use-as-reference": [GenerationRecord];
}>();

const search = ref("");
const selectedIds = ref<Set<string>>(new Set());
const expandedId = ref<string | null>(null);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.records;
  return props.records.filter((r) => r.prompt.toLowerCase().includes(q));
});

function statusLabel(s: string): string {
  return {
    pending: "排队",
    generating: "生成中",
    generated: "已生成",
    imported: "已导入",
    failed: "失败",
  }[s] || s;
}

function statusColor(s: string): string {
  return {
    pending: "#888",
    generating: "#4b9cf5",
    generated: "#5cb85c",
    imported: "#5cb85c",
    failed: "#d9534f",
  }[s] || "#888";
}

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
  selectedIds.value = new Set(selectedIds.value);
}

function importSelected() {
  const ids = Array.from(selectedIds.value);
  if (ids.length === 0) return;
  emit("import", ids);
  selectedIds.value = new Set();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
</script>

<template>
  <section class="record-section">
    <div class="record-header">
      <input
        v-model="search"
        placeholder="搜索提示词..."
        class="search-input"
      />
      <button
        v-if="selectedIds.size > 0"
        class="import-btn"
        @click="importSelected"
      >
        导入 ({{ selectedIds.size }})
      </button>
    </div>
    <div class="record-list">
      <div
        v-for="rec in filtered"
        :key="rec.id"
        class="record-item"
        :class="{ selected: selectedIds.has(rec.id) }"
        @click="toggleSelect(rec.id)"
      >
        <div class="record-top">
          <input
            type="checkbox"
            :checked="selectedIds.has(rec.id)"
            @click.stop="toggleSelect(rec.id)"
          />
          <span class="status-dot" :style="{ background: statusColor(rec.status) }"></span>
          <span class="status-text">{{ statusLabel(rec.status) }}</span>
          <span class="record-time">{{ formatTime(rec.createdAt) }}</span>
          <button class="more-btn" @click.stop="expandedId = expandedId === rec.id ? null : rec.id">⋯</button>
        </div>
        <div class="record-prompt">{{ rec.prompt.slice(0, 60) }}{{ rec.prompt.length > 60 ? '...' : '' }}</div>
        <div v-if="expandedId === rec.id" class="record-actions">
          <button
            v-if="rec.status === 'generated'"
            @click.stop="emit('use-as-reference', rec)"
          >用作参考</button>
          <button
            v-if="rec.status === 'failed' && rec.taskId"
            @click.stop="emit('retry', rec)"
          >重试</button>
          <button @click.stop="emit('delete', rec.id)">删除</button>
        </div>
        <div v-if="rec.error" class="record-error">
          {{ rec.error.message }}<span v-if="rec.error.requestId"> ({{ rec.error.requestId }})</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.record-section {
  flex: 1;
  min-height: 80px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.record-header {
  display: flex;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  padding: 3px 6px;
  font-size: 11px;
  background: var(--uxp-host-border-color, #383838);
  color: inherit;
  border: 1px solid transparent;
  border-radius: 3px;
  font-family: inherit;
  &:focus {
    outline: none;
    border-color: var(--uxp-host-link-text-color, #4b9cf5);
  }
}

.import-btn {
  padding: 3px 8px;
  font-size: 11px;
  background: var(--uxp-host-link-text-color, #4b9cf5);
  color: #fff;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}

.record-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 160px; // bottom padding 让出浮动 prompt 栏（参考素材 + 输入 + 按钮）
}

.record-item {
  padding: 4px 6px;
  border-radius: 3px;
  background: var(--uxp-host-border-color, #383838);
  margin-bottom: 4px;
  cursor: pointer;
  &.selected {
    outline: 1px solid var(--uxp-host-link-text-color, #4b9cf5);
  }
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
}

.record-top {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.status-text {
  flex: 0 0 auto;
}

.record-time {
  margin-left: auto;
  opacity: 0.6;
  font-size: 10px;
}

.more-btn {
  padding: 0 4px;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  border-radius: 3px;
  &:hover {
    background: rgba(255, 255, 255, 0.1);
  }
}

.record-prompt {
  font-size: 11px;
  margin-top: 2px;
  opacity: 0.9;
}

.record-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  button {
    padding: 2px 6px;
    font-size: 10px;
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: inherit;
    border-radius: 3px;
    cursor: pointer;
    &:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  }
}

.record-error {
  font-size: 10px;
  margin-top: 2px;
  color: #d9534f;
  opacity: 0.8;
}
</style>