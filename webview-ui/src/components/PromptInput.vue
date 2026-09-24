<script setup lang="ts">
import { ref, computed } from "vue";
import type {
  MiniMaxModel,
  MiniMaxRatio,
  MiniMaxResolution,
  MiniMaxParamConstraints,
} from "../services/messages";

const props = defineProps<{
  prompt: string;
  model: MiniMaxModel;
  ratio: MiniMaxRatio;
  duration: number;
  resolution: MiniMaxResolution;
  constraints: MiniMaxParamConstraints;
  hasReferences: boolean;
  canSubmit: boolean;
  polling: boolean;
  hasApiKey: boolean;
  hasProject: boolean;
  /** 提示词优化（h3_context_ir）正在请求中（用于按钮 loading 态） */
  optimizing?: boolean;
}>();

const emit = defineEmits<{
  "update:prompt": [string];
  "update:model": [MiniMaxModel];
  "update:ratio": [MiniMaxRatio];
  "update:duration": [number];
  "update:resolution": [MiniMaxResolution];
  submit: [];
  /** 用户点击了右上角 ✨ 按钮，请求调用 h3_context_ir 优化 prompt */
  optimize: [];
}>();

const modelPopoverOpen = ref(false);
const paramsPopoverOpen = ref(false);

const ratios: MiniMaxRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];

const models: { value: MiniMaxModel; label: string }[] = [
  { value: "MiniMax-H3", label: "H3 标准" },
  { value: "MiniMax-H3-Max", label: "H3-Max 极速" },
];

const modelLabel = computed(() => {
  const m = models.find((x) => x.value === props.model);
  return m ? m.label : props.model;
});

const paramsSummary = computed(() => {
  return `${props.ratio}·${props.duration}s·${props.resolution}`;
});

function toggleModelPopover() {
  modelPopoverOpen.value = !modelPopoverOpen.value;
  paramsPopoverOpen.value = false;
}
function toggleParamsPopover() {
  paramsPopoverOpen.value = !paramsPopoverOpen.value;
  modelPopoverOpen.value = false;
}

const submitLabel = computed(() => {
  if (!props.hasApiKey) return "请配置 API Key";
  if (!props.hasProject) return "请打开 PR 项目";
  if (props.polling) return "生成中...";
  return "生成";
});

function onSubmitClick() {
  if (props.canSubmit) emit("submit");
}

/** ✨ 优化按钮可用条件：已配 Key + 当前模型是 H3 + prompt 非空 + 当前未在优化中 */
const canOptimize = computed(() => {
  if (props.optimizing) return false;
  if (!props.hasApiKey) return false;
  if (props.model !== "MiniMax-H3") return false;
  return !!props.prompt.trim();
});

const optimizeTitle = computed(() => {
  if (props.optimizing) return "优化中…";
  if (!props.hasApiKey) return "请先在设置里配置 API Key";
  if (props.model !== "MiniMax-H3") return "仅 H3 模型支持提示词优化";
  if (!props.prompt.trim()) return "请先填写提示词";
  return "用 MiniMax-H3 优化提示词（h3_context_ir）";
});

function onOptimizeClick() {
  if (canOptimize.value) emit("optimize");
}
</script>

<template>
  <section class="prompt-section">
    <div class="prompt-textarea-wrap">
      <textarea
        :value="prompt"
        @input="emit('update:prompt', ($event.target as HTMLTextAreaElement).value)"
        placeholder="描述你想生成的视频..."
        rows="2"
      ></textarea>
      <!-- 右上角：✨ 调用 h3_context_ir 优化提示词 -->
      <button
        class="optimize-btn"
        :class="{ disabled: !canOptimize, loading: optimizing }"
        :disabled="!canOptimize"
        :title="optimizeTitle"
        type="button"
        @click="onOptimizeClick"
      >
        <span v-if="!optimizing" class="optimize-icon">✨</span>
        <span v-else class="optimize-spinner"></span>
      </button>
    </div>
    <div class="param-row">
      <!-- 模型选择按钮（独立 popover） -->
      <button
        class="param-toggle model-btn"
        @click="toggleModelPopover"
        type="button"
        :title="'当前模型: ' + modelLabel"
      >
        {{ modelLabel }}
      </button>
      <!-- 参数设置按钮（独立 popover） -->
      <button
        class="param-toggle params-btn"
        @click="toggleParamsPopover"
        type="button"
      >
        {{ paramsSummary }}
      </button>
      <button
        class="primary submit-btn"
        :class="{ disabled: !canSubmit }"
        @click="onSubmitClick"
        type="button"
      >
        {{ submitLabel }}
      </button>

      <!-- 模型选择 popover（向上展开，按钮等宽对齐） -->
      <div v-if="modelPopoverOpen" class="param-popover model-popover" @click.stop>
        <div class="popover-group">
          <div class="group-label">模型</div>
          <div class="radio-row radio-row--aligned">
            <label
              v-for="m in models"
              :key="m.value"
              class="radio-item"
              :class="{ active: model === m.value }"
            >
              <input
                type="radio"
                :value="m.value"
                :checked="model === m.value"
                @change="emit('update:model', m.value)"
              />
              <span>{{ m.label }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- 参数设置 popover（向上展开，多列平铺） -->
      <div v-if="paramsPopoverOpen" class="param-popover params-popover" @click.stop>
        <div class="popover-group">
          <div class="group-label">宽高比</div>
          <div class="radio-row">
            <label
              v-for="r in ratios.filter((rr) => hasReferences || rr !== 'adaptive')"
              :key="r"
              class="radio-item"
              :class="{ active: ratio === r, disabled: !hasReferences && r === 'adaptive' }"
            >
              <input
                type="radio"
                :value="r"
                :checked="ratio === r"
                :disabled="!hasReferences && r === 'adaptive'"
                @change="emit('update:ratio', r)"
              />
              <span>{{ r }}</span>
            </label>
          </div>
        </div>
        <div class="popover-group">
          <div class="group-label">时长 (秒)</div>
          <div class="radio-row">
            <label
              v-for="d in constraints.durations"
              :key="d"
              class="radio-item"
              :class="{ active: duration === d }"
            >
              <input
                type="radio"
                :value="d"
                :checked="duration === d"
                @change="emit('update:duration', d)"
              />
              <span>{{ d }}s</span>
            </label>
          </div>
        </div>
        <div class="popover-group">
          <div class="group-label">分辨率</div>
          <div class="radio-row">
            <label
              v-for="r in constraints.resolutions"
              :key="r"
              class="radio-item"
              :class="{ active: resolution === r }"
            >
              <input
                type="radio"
                :value="r"
                :checked="resolution === r"
                @change="emit('update:resolution', r)"
              />
              <span>{{ r }}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.prompt-section {
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

/* 提示词输入框 + 右上角优化按钮 */
.prompt-textarea-wrap {
  position: relative;
  textarea {
    /* 给右上角按钮让出空间，避免文字盖到 ✨ */
    padding-right: 28px;
  }
}
.optimize-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0.85;
  transition: opacity 0.15s, background 0.15s, transform 0.15s;
  &:hover:not(.disabled):not(:disabled) {
    opacity: 1;
    background: rgba(255, 255, 255, 0.08);
    transform: scale(1.05);
  }
  &.disabled,
  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  &.loading {
    opacity: 1;
    cursor: progress;
  }
}
.optimize-icon {
  display: inline-block;
}
.optimize-spinner {
  width: 12px;
  height: 12px;
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--uxp-host-link-text-color, #4b9cf5);
  border-radius: 50%;
  animation: optimize-spin 0.8s linear infinite;
}
@keyframes optimize-spin {
  to {
    transform: rotate(360deg);
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
  max-height: 220px;
  overflow-y: auto;
}

.model-popover {
  /* 模型 popover 自适应宽度，按钮等宽对齐 */
  left: 0;
}

/* radio 行：默认 flex wrap 平铺（参数选项） */
.radio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* 模型等"对齐"型：inline-grid + max-content 让所有按钮按最宽 item 等宽 */
.radio-row--aligned {
  display: inline-grid;
  grid-template-columns: max-content;
  gap: 4px;
}

.popover-group {
  margin-bottom: 6px;
  &:last-child {
    margin-bottom: 0;
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
  white-space: nowrap; // 防止文字换行，确保按内容宽度对齐

  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
    color: var(--uxp-host-text-color, #fff);
  }

  &.active {
    color: var(--uxp-host-link-text-color, #4b9cf5);
    background: rgba(75, 156, 245, 0.12);
    border-color: var(--uxp-host-link-text-color, #4b9cf5);
  }

  &.disabled {
    opacity: 0.4;
    cursor: not-allowed;
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