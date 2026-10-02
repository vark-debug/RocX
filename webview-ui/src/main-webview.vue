<script setup lang="ts">
// ---- 轻量 toast：UXP webview 不可依赖原生 alert ----
import { ref, computed, onMounted, provide, getCurrentInstance } from "vue";
import * as webviewAPI from "./webview-api";
import { initWebview } from "./webview-setup";
import { setBridge, bridge } from "./services/bridge";

import { useGenerationState } from "./composables/useGenerationState";
import { SharedRefsKey } from "./providers/state";
import { useReferences } from "./composables/useReferences";
import { useInflight } from "./composables/useInflight";
import { useFeishuReport } from "./composables/useFeishuReport";
import { useSubmit } from "./composables/useSubmit";
import { useImport } from "./composables/useImport";
import { useRecordEdit } from "./composables/useRecordEdit";

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
  VideoModel,
  VideoRatio,
  VideoResolution,
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
const model = ref<VideoModel>("MiniMax-H3");
const ratio = ref<VideoRatio>("16:9");
const duration = ref<number>(5);
const resolution = ref<VideoResolution>("768P");
const references = ref<ReferenceItem[]>([]);
const settingsOpen = ref(false);
const selectedRecordId = ref<string | null>(null);

// ---------- provide: 共享 refs 给 composables(V5.2) ----------
// 10 个高频 ref 集中暴露给 useGenerationState / useSubmit / useImport 等
// composable,避免 props 透传噪音。composable 内部通过 inject(SharedRefsKey) 拿。
//
// ⚠ Vue 3 根组件 setup 内的 provide / inject 失配:
//    setup() 调用顺序是 provide → ... → 同 setup 内 inject(...),
//    但 Vue 3 inject 在 instance.parent == null 时找 appContext.provides,
//    而 provide 写到 instance.provides(Object.create(appContext.provides)),
//    两者不是同一对象 → throw "injection \"...\" not found"。
//    修复:同时直接写到 appContext.provides,这样两种 lookup path 都能命中。
provide(SharedRefsKey, {
  apiKey,
  projectInfo,
  records,
  prompt,
  model,
  ratio,
  duration,
  resolution,
  references,
  selectedRecordId,
});
getCurrentInstance()!.appContext.provides[
  SharedRefsKey as unknown as symbol
] = {
  apiKey,
  projectInfo,
  records,
  prompt,
  model,
  ratio,
  duration,
  resolution,
  references,
  selectedRecordId,
};

// ---------- 在飞任务登记表 + 飞书上报(顶层单例) ----------
// 多个 composable 需要共享同一个 inflight / polling_ / newTaskUi,以支持
// 多任务并行 + 切工程时保留非当前工程的在飞任务。因此先创建 useInflight 一次,
// 然后把它的 API 传给 useSubmit / useGenerationState 等消费方。
const feishuApi = useFeishuReport({ showToast });

// useInflight 内部通过 inject 拿 apiKey/projectInfo/records;
// 只暴露 onTerminalSuccess(顶层需要指定飞书上报回调)
const inflightApi = useInflight({
  onTerminalSuccess: feishuApi.reportToFeishu,
});

// ---------- 全局状态（依赖 inflightApi.resumePolling 做故障恢复） ----------
// useGenerationState 内部通过 inject 拿 10 个高频 ref;
// 只暴露 storageMode(不入 SharedRefs) + resumePolling/getInflightRecords +
// recordPromptOptimization(optimizePrompt 落盘写入)
// ⚠ 必须在 useSubmit 之前声明 —— useSubmit 入参里要引用 state.recordPromptOptimization,
// const 没 hoisting,提前访问会 TDZ。
const state = useGenerationState({
  storageMode,
  resumePolling: inflightApi.resumePolling,
  getInflightRecords: inflightApi.getInflightRecords,
});

// ---------- 提交 / 升级 / 优化提示词(消费 inflightApi / state) ----------
// useSubmit 内部通过 inject 拿 9 个高频 ref;只暴露
// currentProviderId(plan V5 决定不入 SharedRefs) +
// findModelDescriptor / showToast / inflightApi / reportToFeishu +
// recordPromptOptimization(提示词优化结果落盘回调)
const submitApi = useSubmit({
  currentProviderId,
  findModelDescriptor,
  showToast,
  inflightApi: {
    inflight: inflightApi.inflight as any,
    polling_: inflightApi.polling_,
    commitInflight: inflightApi.commitInflight,
    resumePolling: inflightApi.resumePolling,
    pollingActive: inflightApi.pollingActive as any,
  },
  reportToFeishu: feishuApi.reportToFeishu,
  recordPromptOptimization: state.recordPromptOptimization,
});

// ---------- 导入到工程 ----------
// useImport 内部通过 inject 拿 records;只暴露 showToast
const importApi = useImport({
  showToast,
});

// ---------- 重试 / 删除记录 ----------
// useRecordEdit 无入参,所有状态通过 inject 拿
const recordEditApi = useRecordEdit();

// ---------- 参考素材（依赖 state.constraints 做智能填写） ----------
// useReferences 暂时保持 props 透传(规划 v3 下一期处理;
// 本期 plan V5 不涵盖 useReferences)
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
  if (references.value.length === 0 && ratio.value === "adaptive") return false;
  return true;
});

// ---------- 实时探针:storageMode 不存盘提示,改为 mount + 切工程时跑 probePrimary ----------
// 之前用盘上 JSON 的 storageMode 字段,一旦历史上写失败一次就永久误报。
// 现在每次显示前(启动 + 切工程)实际试写一次 primary 路径。
async function refreshStorageProbe(target?: { projectPath?: string }) {
  try {
    const r = await bridge.probePrimary(target);
    if (r.ok) storageMode.value = r.primaryAvailable ? "primary" : "fallback";
  } catch {
    // 探针失败不更新;上一次结果仍然显示。避免单次网络抖动导致 ⚠ 闪烁消失。
  }
}

// 切工程事件订阅:onProjectChanged 信号一来就 probe(用上一次 projectInfo,
// 因为 loadRecords 才拿到最新值前事件可能先到)
webviewAPI.onProjectChanged((p) => {
  void refreshStorageProbe(p ? { projectPath: p.path } : undefined);
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
    await state.reloadRecords();
    // mount 完成 + 项目信息就位时,刷新 ▷ 补的状态
    await refreshStorageProbe({ projectPath: pi.project.path });
  } else {
    // 无活动工程,探针意义不大,但仍跑一次以避免切工程之前看起来 stale
    await refreshStorageProbe();
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
      await state.reloadRecords();
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
      :generating="inflightApi.generating.value"
      :current-project="projectInfo"
      @select="(rec: GenerationRecord) => (selectedRecordId = rec.id)"
      @import-to-project="importApi.importToProject"
      @retry="recordEditApi.retryRecord"
      @use-as-reference="refsApi.useAsReference"
      @upgrade="submitApi.upgradeTo2K"
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
        :ps-locked="refsApi.psLocked.value"
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
        :polling="inflightApi.pollingActive.value"
        :has-api-key="!!apiKey"
        :has-project="!!projectInfo"
        :optimizing="submitApi.optimizingPrompt.value"
        @submit="submitApi.submitGenerate"
        @optimize="submitApi.optimizePrompt"
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
