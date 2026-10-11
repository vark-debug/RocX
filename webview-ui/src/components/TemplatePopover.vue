<script setup lang="ts">
/**
 * 提示词模板浮层（输入 "/" 唤起）
 * 键盘导航（↑↓/Enter/Esc）由宿主输入框的 keydown 处理并调用 expose 的方法
 */
import { ref, computed, watch, nextTick } from "vue";
import type { PromptTemplate } from "@shared/messages";

const props = defineProps<{
  /** 已过滤的模板列表 */
  templates: PromptTemplate[];
  /** 当前高亮索引（键盘导航） */
  activeIndex: number;
}>();
const emit = defineEmits<{
  select: [PromptTemplate];
  hover: [number];
}>();

const listEl = ref<HTMLElement | null>(null);

const hasTemplates = computed(() => props.templates.length > 0);

watch(
  () => props.activeIndex,
  async () => {
    // 键盘导航时把高亮项滚动进可视区
    await nextTick();
    const el = listEl.value?.querySelector(".tpl-item.active");
    el?.scrollIntoView({ block: "nearest" });
  },
);

/** 列表项展示用：模板正文预览（保留锚定符原样，帮助用户理解将插入什么） */
function preview(t: PromptTemplate): string {
  return t.template.length > 40 ? t.template.slice(0, 40) + "…" : t.template;
}
</script>

<template>
  <div class="tpl-popover" @mousedown.prevent>
    <div class="tpl-header">提示词模板 <span class="tpl-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</span></div>
    <div v-if="hasTemplates" ref="listEl" class="tpl-list">
      <div
        v-for="(t, i) in templates"
        :key="t.id"
        class="tpl-item"
        :class="{ active: i === activeIndex }"
        @mouseenter="emit('hover', i)"
        @click="emit('select', t)"
      >
        <span class="tpl-label">{{ t.label }}</span>
        <span class="tpl-preview">{{ preview(t) }}</span>
      </div>
    </div>
    <div v-else class="tpl-empty">无匹配模板</div>
  </div>
</template>

<style lang="scss" scoped>
.tpl-popover {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 2px);
  z-index: 120;
  background: var(--uxp-host-background-color, #2b2b2b);
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 6px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.35);
  font-size: 11px;
  overflow: hidden;
}

.tpl-header {
  padding: 4px 8px;
  font-weight: 500;
  opacity: 0.85;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
}

.tpl-hint {
  font-weight: 400;
  font-size: 10px;
  opacity: 0.6;
  margin-left: 4px;
}

.tpl-list {
  max-height: 150px;
  overflow-y: auto;
}

.tpl-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;

  &.active {
    background: rgba(75, 156, 245, 0.14);
  }
}

.tpl-label {
  flex: 0 0 auto;
  color: var(--uxp-host-link-text-color, #4b9cf5);
  font-weight: 500;
}

.tpl-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--uxp-host-text-color-secondary, #b0b0b0);
}

.tpl-empty {
  padding: 8px;
  opacity: 0.6;
}
</style>
