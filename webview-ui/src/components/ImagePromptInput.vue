<script setup lang="ts">
import { ref, computed } from "vue";
import type { ModelDescriptor } from "../providers/core/types";
import { describeRatio } from "../providers/runninghub/wireFormat";

/** 图片生成尺寸档位；"智能" = 跟随活动序列分辨率（提交时由 UXP 实时获取） */
export type ImageSize = "1K" | "2K" | "智能";
/** 图片宽高比 */
export type ImageRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const props = defineProps<{
  prompt: string;
  /** 当前图片 model id */
  model: string;
  /** 图片 provider 提供的模型列表（用于展示当前模型名） */
  models: ModelDescriptor[];
  ratio: ImageRatio;
  size: ImageSize;
  /** 活动序列分辨率（智能档展示用；null = 未能获取） */
  seqSize: { width: number; height: number } | null;
}>();

const emit = defineEmits<{
  "update:prompt": [string];
  "update:model": [string];
  "update:ratio": [ImageRatio];
  "update:size": [ImageSize];
  generate: [];
}>();

const ratios: ImageRatio[] = ["1:1", "4:3", "3:4", "16:9", "9:16"];
const sizes: ImageSize[] = ["智能", "1K", "2K"];

const paramsPopoverOpen = ref(false);
const modelPopoverOpen = ref(false);

function toggleModelPopover() {
  modelPopoverOpen.value = !modelPopoverOpen.value;
  if (modelPopoverOpen.value) paramsPopoverOpen.value = false;
}

function toggleParamsPopover() {
  paramsPopoverOpen.value = !paramsPopoverOpen.value;
  if (paramsPopoverOpen.value) modelPopoverOpen.value = false;
}

function pickModel(modelId: string) {
  emit("update:model", modelId);
  modelPopoverOpen.value = false;
}

const currentModelLabel = computed(() => {
  const m = props.models.find((x) => x.modelId === props.model);
  return m ? m.displayName : props.model;
});

/** 智能档展示文本：带已获取的序列分辨率 */
const smartLabel = computed(() =>
  props.seqSize ? `智能 ${props.seqSize.width}×${props.seqSize.height}` : "智能",
);

const paramsSummary = computed(() => {
  if (props.size === "智能") {
    // 智能档：宽高比跟随实际像素推导（选择器里的 ratio 不生效，不展示）
    if (!props.seqSize) return "智能";
    return `${describeRatio(props.seqSize.width, props.seqSize.height)}·智能 ${props.seqSize.width}×${props.seqSize.height}`;
  }
  return `${props.ratio}·${props.size}`;
});

const canSubmit = computed(() => !!props.prompt.trim());

const submitLabel = computed(() => (canSubmit.value ? "生成" : "生成"));

function onSubmitClick() {
  if (canSubmit.value) emit("generate");
}
</script>

<template>
  <section class="image-prompt-section">
    <div class="prompt-textarea-wrap">
      <textarea
        :value="prompt"
        @input="emit('update:prompt', ($event.target as HTMLTextAreaElement).value)"
        placeholder="描述你想生成的图片..."
        rows="2"
      ></textarea>
    </div>
    <div class="param-row">
      <button
        class="param-toggle model-btn"
        type="button"
        :title="'当前模型: ' + currentModelLabel"
        @click="toggleModelPopover"
      >
        {{ currentModelLabel }}
      </button>
      <button class="param-toggle params-btn" type="button" @click="toggleParamsPopover">
        {{ paramsSummary }}
      </button>
      <button
        class="primary submit-btn"
        :class="{ disabled: !canSubmit }"
        type="button"
        @click="onSubmitClick"
      >
        {{ submitLabel }}
      </button>

      <!-- 模型切换 popover（向上展开：聚合所有图片 provider 的模型） -->
      <div v-if="modelPopoverOpen" class="param-popover models-popover" @click.stop>
        <div class="group-label">模型</div>
        <div class="radio-row">
          <label
            v-for="m in models"
            :key="m.modelId"
            class="radio-item"
            :class="{ active: model === m.modelId }"
            :title="m.description || m.displayName"
          >
            <input
              type="radio"
              :value="m.modelId"
              :checked="model === m.modelId"
              @change="pickModel(m.modelId)"
            />
            <span>{{ m.displayName }}</span>
          </label>
        </div>
      </div>

      <!-- 图片参数 popover（向上展开：宽高比 / 尺寸 / 张数） -->
      <div v-if="paramsPopoverOpen" class="param-popover params-popover" @click.stop>
        <div class="popover-group" :class="{ disabled: size === '智能' }">
          <div class="group-label">宽高比{{ size === "智能" ? "（智能档跟随序列分辨率，不生效）" : "" }}</div>
          <div class="radio-row">
            <label
              v-for="r in ratios"
              :key="r"
              class="radio-item"
              :class="{ active: ratio === r }"
            >
              <input
                type="radio"
                :value="r"
                :checked="ratio === r"
                :disabled="size === '智能'"
                @change="emit('update:ratio', r as ImageRatio)"
              />
              <span>{{ r }}</span>
            </label>
          </div>
        </div>
        <div class="popover-group">
          <div class="group-label">尺寸</div>
          <div class="radio-row">
            <label
              v-for="s in sizes"
              :key="s"
              class="radio-item"
              :class="{ active: size === s }"
              :title="s === '智能' ? '跟随当前 PR 序列分辨率' : ''"
            >
              <input
                type="radio"
                :value="s"
                :checked="size === s"
                @change="emit('update:size', s as ImageSize)"
              />
              <span>{{ s === "智能" ? smartLabel : s }}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.image-prompt-section {
  position: relative;

  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    font-size: 12px;
    background: var(--uxp-host-border-color, #383838);
    color: inherit;
    border: 1px solid transparent;
    border-radius: 4px;
    resize: vertical;
    min-height: 36px;
    max-height: 60px;
    font-family: inherit;
    &:focus {
      outline: none;
      border-color: var(--uxp-host-link-text-color, #4b9cf5);
    }
  }
}

.param-row {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  align-items: stretch;
  position: relative;
}

.param-toggle,
.submit-btn {
  padding: 4px 8px;
  font-size: 11px;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}

.param-toggle {
  flex: 0 0 auto;
  text-align: left;
  background: var(--uxp-host-border-color, #383838);
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
}

.submit-btn {
  flex: 1;
  background: var(--uxp-host-link-text-color, #4b9cf5);
  color: #fff;
  font-weight: 500;
  &.disabled,
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

/* 参数浮层：紧贴按钮上方展开 */
.param-popover {
  position: absolute;
  bottom: calc(100% + 2px);
  z-index: 100;
  padding: 8px;
  background: var(--uxp-host-background-color, #2b2b2b);
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 6px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.35);
  font-size: 11px;
}

.params-popover {
  left: 0;
  right: 0;
}

.models-popover {
  left: 0;
  min-width: 180px;
}

.radio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.popover-group {
  margin-bottom: 6px;
  &:last-child {
    margin-bottom: 0;
  }

  &.disabled {
    opacity: 0.45;
    pointer-events: none;
  }
}

.group-label {
  font-weight: 500;
  margin-bottom: 2px;
  opacity: 0.8;
}

.radio-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 8px;
  background: var(--uxp-host-border-color, #383838);
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  color: var(--uxp-host-text-color-secondary, #b0b0b0);
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  user-select: none;
  white-space: nowrap;

  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
    color: var(--uxp-host-text-color, #fff);
  }

  &.active {
    color: var(--uxp-host-link-text-color, #4b9cf5);
    background: rgba(75, 156, 245, 0.12);
    border-color: var(--uxp-host-link-text-color, #4b9cf5);
  }

  input[type="radio"] {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0;
    height: 0;
    margin: 0;
  }

  span {
    line-height: 1;
  }
}
</style>
