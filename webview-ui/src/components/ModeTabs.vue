<script lang="ts">
/** 生成模式：视频 / 图片（书签式 tab 切换） */
export type GenerationMode = "video" | "image";
</script>

<script setup lang="ts">
const props = defineProps<{
  mode: GenerationMode;
}>();

const emit = defineEmits<{
  "update:mode": [GenerationMode];
}>();

const tabs: { id: GenerationMode; icon: string; label: string }[] = [
  { id: "video", icon: "🎬", label: "视频生成" },
  { id: "image", icon: "🖼", label: "图片生成" },
];

function onClick(id: GenerationMode) {
  if (id !== props.mode) emit("update:mode", id);
}
</script>

<template>
  <div class="mode-tabs">
    <button
      v-for="t in tabs"
      :key="t.id"
      type="button"
      class="mode-tab"
      :class="{ active: mode === t.id }"
      @click="onClick(t.id)"
    >
      <span class="tab-icon">{{ t.icon }}</span>
      <span class="tab-label">{{ t.label }}</span>
    </button>
  </div>
</template>

<style lang="scss" scoped>
.mode-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.mode-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  color: var(--uxp-host-text-color-secondary, #b0b0b0);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;

  &:hover {
    color: var(--uxp-host-text-color, #fff);
  }

  &.active {
    background: var(--uxp-host-link-text-color, #4b9cf5);
    color: #fff;
  }
}

.tab-icon {
  font-size: 12px;
  line-height: 1;
}

.tab-label {
  line-height: 1;
  white-space: nowrap;
}
</style>
