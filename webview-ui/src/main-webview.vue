<script setup lang="ts">
// ---- 轻量 toast：UXP webview 不可依赖原生 alert ----
import { ref, computed, onMounted } from "vue";
import * as webviewAPI from "./webview-api";
import { initWebview } from "./webview-setup";
import { setBridge, bridge } from "./services/bridge";

import { useGenerationState } from "./composables/useGenerationState";
import { useReferences } from "./composables/useReferences";
import { useGenerationTasks } from "./composables/useGenerationTasks";

// ---- provider 抽象层（Task 1-2） ----
import {
  registerProvider,
  getProvider,
  getProviderSync,
  listProviders,
  DEFAULT_PROVIDER_ID,
} from "./providers/core/registry";
import { minimaxProvider } from "./providers/minimax";
import type { ModelDescriptor } from "./providers/core/types";
import type { VideoGenProvider } from "./providers/core/VideoGenProvider";

import type {
  GenerationRecord,
  MiniMaxModel,
  MiniMaxRatio,
  MiniMaxResolution,
  ReferenceItem,
} from "@shared/messages";

import PromptInput from "./components/PromptInput.vue";
import ReferenceList from "./components/ReferenceList.vue";
import RecordsPanel from "./components/RecordsPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";

const { api } = initWebview(webviewAPI);
setBridge(api);

// ---------- 轻量 toast ----------
const toastMsg = ref("");
let _toastTimer: any = null;
function showToast(msg: string | unknown) {
  const text = typeof msg === "string" ? msg : String(msg);
  console.log("[toast]", text);
  toastMsg.value = text;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (toastMsg.value = ""), 6000);
}

// ---------- provider 状态 ----------
/** 当前激活的 provider id（首版本写死 minimax；后续可让用户在设置里切换） */
const currentProviderId = ref<string>(DEFAULT_PROVIDER_ID);

/** 当前 provider 实例（异步获取） */
const currentProvider = ref<VideoGenProvider | null>(null);

/** 当前 provider 的模型列表（computed） */
const providerModels = computed<ModelDescriptor[]>(() => {
  return currentProvider.value?.models ?? [];
});

/** 查找当前 provider + modelId 对应的 ModelDescriptor */
function findModelDescriptor(
  modelId: string,
  providerId?: string,
): ModelDescriptor | null {
  const pid = providerId || currentProviderId.value;
  const provider = getProviderSync(pid) || currentProvider.value;
  if (!provider) return null;
  return provider.models.find((m) => m.modelId === modelId) ?? null;
}

// ---------- 全局状态 ref（顶层持有，被 composable 共享） ----------
const apiKey = ref<string | null>(null);
const projectInfo = ref<{ path: string; guid: string; name: string } | null>(null);
const records = ref<GenerationRecord[]>([]);
const storageMode = ref<"primary" | "fallback">("primary");
const prompt = ref("");
const model = ref<MiniMaxModel>("MiniMax-H3");
const ratio = ref<MiniMaxRatio>("16:9");
const duration = ref<number>(5);
const resolution = ref<MiniMaxResolution>("768P");
const references = ref<ReferenceItem[]>([]);
const settingsOpen = ref(false);
const selectedRecordId = ref<string | null>(null);

// ---------- 任务生命周期（持有 generating / pollingActive / optimizingPrompt） ----------
const tasks = useGenerationTasks({
  apiKey,
  records,
  prompt,
  model,
  ratio,
  duration,
  resolution,
  references,
  projectInfo,
  currentProviderId,
  selectedRecordId,
  findModelDescriptor,
  showToast,
});

// ---------- 全局状态（依赖 tasks.resumePolling 做故障恢复） ----------
const state = useGenerationState({
  apiKey,
  projectInfo,
  records,
  storageMode,
  prompt,
  model,
  ratio,
  duration,
  resolution,
  references,
  settingsOpen,
  resumePolling: tasks.resumePolling,
});

// ---------- 参考素材（依赖 state.constraints 做智能填写） ----------
const refsApi = useReferences({
  references,
  constraints: state.constraints,
  duration,
  ratio,
  getModelId: () => model.value,
  currentProviderId,
  findModelDescriptor,
  showToast,
});

// ---------- 提交前置守卫 ----------
const canSubmit = computed(() => {
  if (!apiKey.value) return false;
  if (!prompt.value.trim()) return false;
  if (tasks.generating.value && tasks.pollingActive.value) return false;
  if (references.value.length === 0 && ratio.value === "adaptive") return false;
  return true;
});

// ---------- 初始化 ----------
onMounted(async () => {
  // 默认注册 MiniMax（dynamic import 走 registry）
  if (!listProviders().find((p) => p.providerId === DEFAULT_PROVIDER_ID)) {
    registerProvider(minimaxProvider);
  }
  // 异步获取当前 provider 实例
  currentProvider.value = await getProvider(currentProviderId.value);
  apiKey.value = await bridge.getApiKey();
  // 获取项目信息
  const pi = await bridge.queryProjectState();
  if (pi.project) {
    projectInfo.value = pi.project;
    await state.loadRecords();
  }
});

function onSettingsSave(key: string) {
  apiKey.value = key;
  settingsOpen.value = false;
}

const refreshing = ref(false);
async function refreshProject() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const pi = await bridge.queryProjectState();
    if (pi.project) {
      projectInfo.value = pi.project;
      await state.loadRecords();
    } else {
      projectInfo.value = null;
      records.value = [];
    }
  } catch (e) {
    console.warn("[main-webview] refreshProject failed", e);
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="ai-panel-root">
    <!-- Header: 项目名 + 刷新 + 设置按钮 -->
    <header class="panel-header">
      <div class="project-info">
        <div class="project-name" v-if="projectInfo">
          {{ projectInfo.name || projectInfo.path.split(/[\\/]/).pop() }}
        </div>
        <div class="project-name muted" v-else>无活动项目</div>
        <button
          class="icon-btn"
          :class="{ spinning: refreshing }"
          :disabled="refreshing"
          @click="refreshProject"
          title="刷新当前 PR 工程（重新读取项目信息与记录）"
        >
          🔄
        </button>
      </div>
      <button class="icon-btn" @click="settingsOpen = !settingsOpen" title="设置">
        ⚙
      </button>
    </header>

    <!-- Settings 折叠区 -->
    <SettingsPanel
      v-if="settingsOpen"
      :initial-key="apiKey || ''"
      @save="onSettingsSave"
    />

    <!-- 生成记录区：左列缩略图（可滚动）+ 右列详情（生成中/失败/已生成） -->
    <RecordsPanel
      :records="records"
      :generating="tasks.generating.value"
      @select="(rec: GenerationRecord) => (selectedRecordId = rec.id)"
      @import-to-project="tasks.importToProject"
      @retry="tasks.retryRecord"
      @use-as-reference="refsApi.useAsReference"
      @upgrade="tasks.upgradeTo2K"
    />

    <!-- 底部状态条 -->
    <footer class="panel-footer">
      <span class="muted">{{ records.length }} 条记录 · {{ state.generatedCount.value }} 条已生成</span>
      <span class="muted" v-if="storageMode === 'fallback'">⚠ 降级存储</span>
    </footer>

    <!-- 浮动窗口：参考素材 + 提示词 + 模型 + 参数按钮 + 生成按钮（贴底覆盖） -->
    <div class="floating-prompt-bar">
      <ReferenceList
        v-model:references="references"
        @add="refsApi.addReference"
        @captureFrame="refsApi.captureFrameAsReference"
        @captureFrameAndOpenPs="refsApi.captureFrameAndOpenInPs"
        @captureVideo="refsApi.captureVideoAsReference"
        @remove="refsApi.removeReference"
        @confirmPending="refsApi.confirmPendingUpload"
      />
      <div class="prompt-divider"></div>
      <PromptInput
        v-model:prompt="prompt"
        v-model:model="model"
        v-model:ratio="ratio"
        v-model:duration="duration"
        v-model:resolution="resolution"
        :models="providerModels"
        :constraints="state.constraints.value"
        :has-references="references.length > 0"
        :can-submit="canSubmit"
        :polling="tasks.pollingActive.value"
        :has-api-key="!!apiKey"
        :has-project="!!projectInfo"
        :optimizing="tasks.optimizingPrompt.value"
        @submit="tasks.submitGenerate"
        @optimize="tasks.optimizePrompt"
      />
    </div>
    <div v-if="toastMsg" class="uxp-toast">{{ toastMsg }}</div>
  </div>
</template>

<style lang="scss">
@use "./index.scss" as *;

.ai-panel-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  font-size: 12px;
  background-color: var(--uxp-host-background-color, #2b2b2b);
  color: var(--uxp-host-text-color, #fff);
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  flex-shrink: 0;
  .project-info {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .project-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &.muted {
      opacity: 0.6;
    }
  }
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
  &.spinning {
    animation: rocx-spin 1s linear infinite;
    display: inline-block;
  }
}

@keyframes rocx-spin {
  to {
    transform: rotate(360deg);
  }
}

.floating-prompt-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  padding: 6px 8px 8px;
  background: var(--uxp-host-background-color, #2b2b2b);
  border-top: 1px solid var(--uxp-host-border-color, #454545);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.25);
}

.prompt-divider {
  height: 1px;
  margin: 4px 0 4px;
  background: var(--uxp-host-border-color, #454545);
  opacity: 0.4;
}

.panel-footer {
  padding: 4px 8px;
  border-top: 1px solid var(--uxp-host-border-color, #454545);
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  flex-shrink: 0;
  .muted {
    opacity: 0.6;
  }
}

:root[data-theme="lightest"] {
  --bg-fallback: #f0f0f0;
  --text-fallback: #4b4b4b;
}
:root[data-theme="light"] {
  --bg-fallback: #b8b8b8;
  --text-fallback: #424242;
}
:root[data-theme="dark"] {
  --bg-fallback: #535353;
  --text-fallback: #fff;
}
:root[data-theme="darkest"] {
  --bg-fallback: #292929;
  --text-fallback: #fff;
}

button {
  font-family: inherit;
}
</style>
