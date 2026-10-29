<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import type { ModelDescriptor } from "../providers/core/types";
import { describeRatio } from "../providers/runninghub/wireFormat";
import {
  imageRatioOptions,
  imageSizeOptions,
  type ImageParamConstraints,
} from "../providers/core/imageOptions";
import { useTemplateTrigger } from "../composables/usePromptTemplates";
import { usePopoverDismiss } from "../composables/usePopoverDismiss";
import TemplatePopover from "./TemplatePopover.vue";

const props = defineProps<{
  prompt: string;
  /** 当前图片 model id */
  model: string;
  /** 当前平台的模型列表（用于展示当前模型名） */
  models: ModelDescriptor[];
  /**
   * 宽高比（按平台的值域取值）。
   * 其余平台是固定 5 个比例；可灵是服务端声明的 aspect_ratio 值域（含 "auto"）。
   */
  ratio: string;
  /**
   * 尺寸档位（按平台的值域取值）。
   * 其余平台是 "智能"/"1K"/"2K"；可灵是服务端声明的 img_resolution 值域（"1k"/"2k"/"4k"）。
   */
  size: string;
  /** 活动序列分辨率（智能档展示用；null = 未能获取） */
  seqSize: { width: number; height: number } | null;
  /** 可切换的图片平台（模型弹层顶部一排平台） */
  providers?: { id: string; label: string }[];
  /** 当前激活的平台 id */
  providerId?: string;
  /** 当前平台的环境异常提示（如可灵未登录 / 清单拉取失败） */
  providerNotice?: string;
  /**
   * 当前模型的参数约束（按平台下发的服务端声明）。
   * 存在时，尺寸档位与宽高比选项由它决定 —— 可灵用 img_resolution("1k"/"2k"/"4k")
   * 与 aspect_ratio（含 "auto"）的值域，与其余平台的像素语义不同。
   */
  constraints?: ImageParamConstraints | null;
  /** 当前平台是否需要 API Key（可灵走 CLI 登录态，不需要） */
  needsApiKey?: boolean;
  /** 当前平台是否已配置 API Key */
  hasApiKey?: boolean;
  /** 当前平台是否支持"智能"档（跟随序列分辨率）—— 可灵不支持（只有档位 + 比例） */
  supportsSmartSize?: boolean;
  /** 提交请求在途（用于按钮 loading 态） */
  submitting?: boolean;
}>();

const emit = defineEmits<{
  "update:prompt": [string];
  "update:model": [string];
  "update:ratio": [string];
  "update:size": [string];
  /** 切换图片平台 */
  "update:providerId": [string];
  generate: [];
}>();

/**
 * 宽高比选项。
 *
 * 有 constraints 时取服务端声明的 aspect_ratio 值域（含 "auto"）；
 * 否则回落到本地默认集（RunningHub / 火山方舟的既有行为，不变）。
 */
const ratios = computed<string[]>(() => imageRatioOptions(props.constraints));

/**
 * 尺寸档位选项。
 *
 * 有 constraints 时取服务端声明的 img_resolution 值域（可灵："1k"/"2k"/"4k"）；
 * 否则回落到本地默认集（"智能"/"1K"/"2K"）。
 */
const sizes = computed<string[]>(() =>
  imageSizeOptions(props.constraints, props.supportsSmartSize !== false),
);

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

/**
 * 点提示词输入框 → 收起模型/参数浮层。
 *
 * 浮层是向上展开的，正好压在提示词框上方；不收起来的话用户想点输入框
 * 还得先点空白处把浮层关掉。
 */
function closeParamPopovers() {
  modelPopoverOpen.value = false;
  paramsPopoverOpen.value = false;
}

/** 宽高比展示文案（"auto" → "自动"，其余原样） */
function ratioLabel(r: string): string {
  return r === "auto" ? "自动" : r;
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
  // 服务端没声明分辨率参数（模型自己决定）→ 只展示比例
  if (!props.size) return ratioLabel(props.ratio);
  return `${ratioLabel(props.ratio)}·${props.size}`;
});

const canSubmit = computed(() => !!props.prompt.trim());

const submitLabel = computed(() => {
  // 可灵不需要 key（needsApiKey=false），别拿「请配置 API Key」误导用户
  if (props.needsApiKey !== false && !props.hasApiKey) {
    return "请配置 API Key";
  }
  if (props.submitting) return "提交中...";
  return "生成";
});

function onSubmitClick() {
  if (canSubmit.value && !props.submitting) emit("generate");
}

// ---------- 提示词模板（"/" 触发） ----------
const promptTextarea = ref<HTMLTextAreaElement | null>(null);
const tpl = useTemplateTrigger({
  textareaRef: promptTextarea,
  mode: "image",
  onReplace: (next, selStart, selEnd) => {
    emit("update:prompt", next);
    // 等 :value 绑定回流后再定位光标（锚点处预填文本全选，打字即覆盖）
    void nextTick(() => {
      promptTextarea.value?.focus();
      promptTextarea.value?.setSelectionRange(selStart, selEnd);
    });
  },
});
function onPromptInput(e: Event) {
  emit("update:prompt", (e.target as HTMLTextAreaElement).value);
  tpl.onInput(e);
}

// 点提示词输入框 / 浮层外部 → 收起模型与参数浮层
usePopoverDismiss({
  isOpen: () => modelPopoverOpen.value || paramsPopoverOpen.value,
  close: closeParamPopovers,
  textareaRef: promptTextarea,
});
</script>

<template>
  <section class="image-prompt-section">
    <div class="prompt-textarea-wrap">
      <textarea
        ref="promptTextarea"
        :value="prompt"
        @input="onPromptInput"
        @keydown="tpl.onKeydown"
        @blur="tpl.close"
        @click="closeParamPopovers"
        placeholder="描述你想生成的图片... 或按 / 选择提示词模板"
        rows="2"
      ></textarea>
      <!-- 提示词模板浮层（"/" 触发，向上展开） -->
      <TemplatePopover
        v-if="tpl.open.value"
        :templates="tpl.filtered.value"
        :active-index="tpl.activeIndex.value"
        @select="tpl.insertTemplate"
        @hover="tpl.activeIndex.value = $event"
      />
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
        :class="{ disabled: !canSubmit || submitting, loading: submitting }"
        :disabled="!canSubmit || submitting"
        type="button"
        @click="onSubmitClick"
      >
        {{ submitLabel }}
      </button>

      <!-- 模型切换 popover（向上展开：先选平台再看模型） -->
      <div v-if="modelPopoverOpen" class="param-popover models-popover" @click.stop>
        <!-- 平台切换：模型清单按 provider 下发，先选平台再看模型 -->
        <div v-if="providers && providers.length > 1" class="popover-group">
          <div class="group-label">平台</div>
          <div class="radio-row radio-row--aligned">
            <label
              v-for="p in providers"
              :key="p.id"
              class="radio-item"
              :class="{ active: providerId === p.id }"
            >
              <input
                type="radio"
                :value="p.id"
                :checked="providerId === p.id"
                @change="emit('update:providerId', p.id)"
              />
              <span>{{ p.label }}</span>
            </label>
          </div>
        </div>
        <div class="popover-group">
          <div class="group-label">模型</div>
          <div v-if="providerNotice" class="provider-notice">{{ providerNotice }}</div>
          <div v-else-if="!models.length" class="provider-notice">该平台暂无可用模型</div>
          <div class="radio-row radio-row--aligned">
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
      </div>

      <!-- 图片参数 popover（向上展开：宽高比 / 尺寸） -->
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
                @change="emit('update:ratio', r)"
              />
              <span>{{ ratioLabel(r) }}</span>
            </label>
          </div>
        </div>
        <div v-if="sizes.length" class="popover-group">
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
                @change="emit('update:size', s)"
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

/* 平台/模型列表：每行一项（名称长短不一时不该被 flex 拉伸变形） */
.radio-row--aligned {
  display: inline-grid;
  grid-template-columns: max-content;
  gap: 4px;
}

.provider-notice {
  font-size: 10px;
  line-height: 1.4;
  color: #ff9f6b;
  margin-bottom: 4px;
  max-width: 240px;
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
