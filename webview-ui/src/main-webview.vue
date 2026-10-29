<script setup lang="ts">
// ---- 轻量 toast：UXP webview 不可依赖原生 alert ----
import { ref, computed, onMounted, provide, getCurrentInstance, watch } from "vue";
import * as webviewAPI from "./webview-api";
import { initWebview } from "./webview-setup";
import { setBridge, bridge } from "./services/bridge";
import { ratioToSize, clampToApiMax } from "./providers/runninghub/wireFormat";
import {
  coerceImageRatio,
  coerceImageSize,
  defaultImageRatio,
  defaultImageSize,
  imageRatioOptions,
  imageSizeOptions,
} from "./providers/core/imageOptions";

import { useGenerationState } from "./composables/useGenerationState";
import { SharedRefsKey } from "./providers/state";
import { useReferences } from "./composables/useReferences";
import { useInflight } from "./composables/useInflight";
import { useFeishuReport } from "./composables/useFeishuReport";
import { useSubmit } from "./composables/useSubmit";
import { useImageSubmit } from "./composables/useImageSubmit";
import { useImport } from "./composables/useImport";
import { useRecordEdit } from "./composables/useRecordEdit";

// ---- provider 抽象层（Task 1-2） ----
import {
  registerProvider,
  getProvider,
  getProviderSync,
  listProviders,
  registerImageProvider,
  listImageProviders,
  DEFAULT_PROVIDER_ID,
  DEFAULT_IMAGE_PROVIDER_ID,
} from "./providers/core/registry";
import { minimaxProvider } from "./providers/minimax";
import { runningHubProvider } from "./providers/runninghub";
import { arkProvider } from "./providers/ark";
import {
  klingProvider,
  klingImageProvider,
  loadKlingModels,
  klingEnv,
  bootstrapKlingEnv,
  getKlingDefaultModel,
  getKlingImageDefaultModel,
  klingImageModels,
} from "./providers/kling";
import { KLING_PROVIDER_ID } from "@shared/messages";
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
import ModeTabs from "./components/ModeTabs.vue";
import type { GenerationMode } from "./components/ModeTabs.vue";
import ImagePromptInput from "./components/ImagePromptInput.vue";

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
/**
 * 当前激活的 provider id。
 *
 * 默认仍是 minimax（老用户无感）；用户可在模型弹层里切到可灵。
 * 切换后：模型下拉换成新 provider 的清单、默认 model 重置为新 provider 的首个模型、
 * ratio / duration / resolution 按新模型的 paramConstraints 归一化（constraints 是派生的）。
 */
const currentProviderId = ref<string>(DEFAULT_PROVIDER_ID);

/** 当前 provider 实例（异步获取） */
const currentProvider = ref<VideoGenProvider | null>(null);

/** 已注册的视频 provider 列表（注册后更新，供切换 UI 渲染） */
const videoProviderList = ref<VideoGenProvider[]>([]);

/**
 * MiniMax 是否已配 API Key。
 *
 * 没配 key 时默认走可灵（走 CLI 登录态，不需要 API Key），
 * 所以平台栏里可灵要排在前面 —— 用户一进来看到的就是能直接用的那个。
 */
const minimaxKeyPresent = ref(false);

/** provider 切换 UI 的选项（id + 显示名） */
const videoProviderOptions = computed(() => {
  const opts = videoProviderList.value.map((p) => ({
    id: p.providerId,
    label: p.displayName,
  }));
  // MiniMax 没 key → 可灵排前面（可直接用的平台优先）
  if (!minimaxKeyPresent.value) {
    opts.sort((a, b) =>
      a.id === KLING_PROVIDER_ID ? -1 : b.id === KLING_PROVIDER_ID ? 1 : 0,
    );
  }
  return opts;
});

/**
 * 参考素材区的限制提示。
 *
 * 可灵走全能参考（omni_ref_video）时**按秒计费**，且**输入视频的时长会计入总时长** ——
 * 这是服务端 model declaration 里明确写着「You MUST inform the user」的要求，
 * 必须在界面上告知，不能只藏在文档里。
 */
const videoReferenceTips = computed(() => {
  const base = "视频≤3 总时长≤15s · 图片≤9";
  if (currentProviderId.value !== KLING_PROVIDER_ID) return base;
  const videos = references.value.filter((r) => r.type === "reference_video");
  if (!videos.length) return base;
  const total = videos
    .map((r) => r.durationSec)
    .filter((d): d is number => typeof d === "number")
    .reduce((a, b) => a + b, 0);
  const dur = total ? ` ${Math.round(total * 10) / 10}s` : "";
  return `可灵按秒计费，输入视频${dur}会计入总时长`;
});

/**
 * 当前 provider 的环境异常提示。
 * 可灵的环境问题（未装 CLI / 未登录 / 清单拉不到）要在模型弹层里直接可见，
 * 否则用户只看到「没有模型」，不知道为什么。
 */
const providerNotice = computed(() => {
  if (currentProviderId.value !== KLING_PROVIDER_ID) return "";
  if (klingEnv.value.ready) return "";
  return klingEnv.value.message || "可灵环境未就绪，请到设置里查看自检结果";
});

/** 当前 provider 的模型列表（computed） */
const providerModels = computed<ModelDescriptor[]>(() => {
  return currentProvider.value?.models ?? [];
});

/**
 * 切换视频 provider。
 *
 * 可灵的模型清单要现拉（`who_am_i`），所以先加载清单再取 provider —— 否则
 * models 还是空的，model 下拉会空着。
 */
async function switchVideoProvider(id: string): Promise<void> {
  if (id === currentProviderId.value) return;
  currentProviderId.value = id;
  if (id === KLING_PROVIDER_ID) {
    // 拉不到清单时不清空回退硬编码（见 providers/kling）：模型下拉会空，
    // 设置面板里有环境自检可看具体原因
    await loadKlingModels();
  }
  currentProvider.value = await getProvider(id);
  const models = currentProvider.value?.models ?? [];
  // 默认 model：仍能命中就保留（用户可能只是切回来），否则重置为新 provider 的默认模型
  if (models.length && !models.some((m) => m.modelId === model.value)) {
    model.value = pickDefaultModelFor(id, models);
  }
  // key 按 provider 分槽读取（可灵没有 key，读回来是空串）
  apiKey.value = (await bridge.getApiKey(id)) || "";
}

/**
 * 取某个 provider 的默认模型 id。
 *
 * 可灵用服务端下发的 defaultModel（实测 kling-video-v4_0）——
 * **不能取清单首项**：服务端返回的顺序是
 * `v2_5, v2_6, o1, v3_0_omni, v3_0, v3_0_turbo, v4_0`，
 * 首项是旧版 v2_5。
 */
function pickDefaultModelFor(
  providerId: string,
  models: ModelDescriptor[],
): string {
  if (providerId === KLING_PROVIDER_ID) {
    const klingDefault = getKlingDefaultModel();
    if (klingDefault && models.some((m) => m.modelId === klingDefault)) {
      return klingDefault;
    }
  }
  // 清单为空（provider 未加载 / 拉取失败）时返回空串，调用方有 length 守卫
  return models[0]?.modelId ?? "";
}

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
/** 生成模式（视频/图片）书签切换；首版仅前端 UI，图片模式为占位 */
const generationMode = ref<GenerationMode>("video");
// ---- 图片生成模式状态（阶段 2A：RunningHub 文生图） ----
const imagePrompt = ref("");
const imageModel = ref("seedream-v5-pro");
// 宽高比 / 尺寸档位按平台的值域取值（可灵是 "1k"/"2k"/"4k" + "auto"，
// 其余平台是 "智能"/"1K"/"2K" + 固定 5 个比例）→ 用 string 而非字面量联合
const imageRatio = ref<string>("1:1");
const imageSize = ref<string>("智能");
/**
 * 用户是否手动选过宽高比 / 尺寸档位。
 *
 * false → 取当前平台的**声明默认值**：可灵是服务端声明的
 *   aspect_ratio="auto" + img_resolution="2k"（平台默认值，各模型一致），
 *   其余平台是 "1:1" + "智能"。
 * true  → 用户自己选的值，切平台/切模型时保留（只做值域收敛）。
 */
const imageRatioTouched = ref(false);
const imageSizeTouched = ref(false);
/** 活动序列分辨率（智能档展示 / 提交兜底用；切到图片生成模式时刷新；超 API 上限的已等比钳制） */
const imageSeqSize = ref<{ width: number; height: number } | null>(null);
async function refreshImageSeqSize() {
  try {
    const seq = await bridge.getActiveSequenceSize();
    // 展示层即钳制：标签显示的就是实际会提交的像素（所见即所得）
    imageSeqSize.value = seq ? clampToApiMax(seq.width, seq.height) : null;
  } catch {
    imageSeqSize.value = null;
  }
}
// 点击「图片生成」书签（含重试回填切模式）时刷新一次，而非等展开尺寸 popover
watch(generationMode, (mode) => {
  if (mode === "image") void refreshImageSeqSize();
});

/**
 * 模型变了 → 参数值域可能跟着变（可灵不同模型的 img_resolution / aspect_ratio 值域不同），
 * 立刻把当前档位/比例收敛到新模型的合法值域。
 */
watch(imageModel, () => {
  normalizeImageParams();
});
/** 已注册图片 provider 列表（响应式：mount 注册后更新；模型下拉聚合所有 provider 的模型） */
const imageProviderList = ref<import("./providers/core/ImageGenProvider").ImageGenProvider[]>([]);

/**
 * 当前激活的图片平台 id。
 *
 * 之前是「按选中的 modelId 反查 provider」（resolveImageProviderId），
 * 现在有平台栏了，平台是**显式状态**，模型是平台的子集 —— 反查方式在新交互下
 * 会有歧义（两个平台可能存在同名模型），改成显式持有。
 */
const currentImageProviderId = ref<string>(DEFAULT_IMAGE_PROVIDER_ID);

/** 当前图片平台的模型列表 */
const imageModels = computed<ModelDescriptor[]>(() => {
  if (currentImageProviderId.value === KLING_PROVIDER_ID) {
    // 可灵图片模型来自服务端动态下发（who_am_i），单独取（provider 实例的 models
    // 是 getter，但这里直接读 ref 更直观，也避免依赖 provider 实例的注册时机）
    return klingImageModels.value;
  }
  return (
    imageProviderList.value.find(
      (p) => p.providerId === currentImageProviderId.value,
    )?.models ?? []
  );
});

/**
 * 按当前选中的图片 modelId 推导所属图片 provider id。
 *
 * 用于「素材上传目标」的分流（抓素材时要知道给谁传）——
 * 优先用显式的平台状态，平台没定才按模型反查。
 */
function resolveImageProviderId(): string {
  return currentImageProviderId.value;
}

/** RunningHub / 火山方舟 是否已配 API Key（决定图片模式的默认平台） */
const runningHubKeyPresent = ref(false);
const arkKeyPresent = ref(false);

/** 图片平台的切换选项（id + 显示名） */
const imageProviderOptions = computed(() => {
  const opts = imageProviderList.value.map((p) => ({
    id: p.providerId,
    label: p.displayName,
  }));
  // 两个 HTTP 平台都没 key → 可灵排前面（可直接用的平台优先），与视频侧同策略
  if (!runningHubKeyPresent.value && !arkKeyPresent.value) {
    opts.sort((a, b) =>
      a.id === KLING_PROVIDER_ID ? -1 : b.id === KLING_PROVIDER_ID ? 1 : 0,
    );
  }
  return opts;
});

/** 当前图片平台的环境异常提示（可灵未登录 / 清单拉取失败等） */
const imageProviderNotice = computed(() => {
  if (currentImageProviderId.value !== KLING_PROVIDER_ID) return "";
  if (klingEnv.value.ready) return "";
  return klingEnv.value.message || "可灵环境未就绪，请到设置里查看自检结果";
});

/**
 * 当前图片模型的参数约束（按平台下发的服务端声明）。
 *
 * 可灵走服务端声明（img_resolution / aspect_ratio 值域 + 默认值），
 * 其余平台没有 constraints（沿用本地默认的宽高比与尺寸档位）。
 */
const imageConstraints = computed(() => {
  if (currentImageProviderId.value !== KLING_PROVIDER_ID) return undefined;
  const m = imageModels.value.find((x) => x.modelId === imageModel.value);
  if (!m) return undefined;
  return {
    resolutions: m.paramConstraints.resolutions,
    ratios: m.paramConstraints.ratios,
    defaultResolution: m.paramConstraints.defaultResolution,
    defaultRatio: m.paramConstraints.defaultRatio,
  };
});

/** 当前图片平台是否支持"智能"档（跟随序列分辨率）—— 可灵只有档位 + 比例，不支持 */
const imageSupportsSmartSize = computed(
  () => currentImageProviderId.value !== KLING_PROVIDER_ID,
);

/** 当前图片平台是否需要 API Key（可灵走 CLI 登录态，不需要） */
const imageNeedsApiKey = computed(
  () => currentImageProviderId.value !== KLING_PROVIDER_ID,
);

/** 当前图片平台是否已配置 API Key（用于提交按钮文案） */
const imageHasApiKey = ref(false);

/**
 * 把当前尺寸档位 / 宽高比收敛到当前平台的合法值域。
 *
 * 值域随**平台**和**模型**而变（可灵 "1k"/"2k"/"4k" + "auto"，
 * 其余平台 "智能"/"1K"/"2K" + 固定 5 比例），所以任何时候改了平台或模型
 * 都要重新收敛一次，否则提交时会下发非法参数。
 *
 * 用户没手动选过 → 直接取**当前平台的声明默认值**：
 * 可灵是服务端声明的 aspect_ratio="auto" + img_resolution="2k"
 * （平台默认值 —— 切模型也一致，不会从「自动」跳成固定比例），
 * 其余平台是 "1:1" + "智能"。
 * 用户手动选过 → 保留用户的选择，只在值域非法时收敛。
 */
function normalizeImageParams(): void {
  const c = imageConstraints.value;
  imageSize.value = imageSizeTouched.value
    ? coerceImageSize(
        imageSize.value,
        imageSizeOptions(c, imageSupportsSmartSize.value),
        c?.defaultResolution,
      )
    : defaultImageSize(c, imageSupportsSmartSize.value);
  imageRatio.value = imageRatioTouched.value
    ? coerceImageRatio(imageRatio.value, imageRatioOptions(c), c?.defaultRatio)
    : defaultImageRatio(c);
}

/** 用户手动选了宽高比 → 后续切平台/切模型时保留这个选择 */
function onImageRatioPick(v: string): void {
  imageRatio.value = v;
  imageRatioTouched.value = true;
}

/** 用户手动选了尺寸档位 → 后续切平台/切模型时保留这个选择 */
function onImageSizePick(v: string): void {
  imageSize.value = v;
  imageSizeTouched.value = true;
}

/**
 * 切换图片平台。
 *
 * 与视频侧 switchVideoProvider 同构，但有两处图片特有的处理：
 * 1. 可灵的模型清单要现拉（who_am_i），切过去先加载再取默认模型
 * 2. 尺寸档位 / 宽高比的值域**随平台而变**（可灵 "1k"/"2k"/"4k" + "auto"，
 *    其余平台 "智能"/"1K"/"2K" + 固定 5 比例）→ 切完必须把当前值收敛到新值域，
 *    否则提交时会下发非法参数
 */
async function switchImageProvider(id: string): Promise<void> {
  if (id === currentImageProviderId.value) return;
  currentImageProviderId.value = id;
  if (id === KLING_PROVIDER_ID) {
    await loadKlingModels();
  }
  const models = imageModels.value;
  // 默认模型：仍能命中就保留（用户可能只是切回来），否则重置为新平台的默认模型
  if (models.length && !models.some((m) => m.modelId === imageModel.value)) {
    imageModel.value =
      id === KLING_PROVIDER_ID
        ? getKlingImageDefaultModel() || models[0]?.modelId || ""
        : models[0]?.modelId ?? "";
  }
  // 值域收敛（constraints 随模型重算后才有意义 → 必须在 model 定下来之后）
  normalizeImageParams();
  // key 状态（可灵没有 key 槽位，读回来是空串）
  imageHasApiKey.value =
    id === KLING_PROVIDER_ID ? true : !!(await bridge.getApiKey(id));
}

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
// 并发提交上限。
//
// 为什么限：可灵走 CLI，每个在飞任务都会每 5s 拉起一个 node 进程轮询
// （单进程峰值 RSS 实测 312MB）。任务一多，内存和进程数会同时膨胀。
// UXP 侧已有「同时最多 3 个 CLI 进程」的技术层限流，
// 这里再加一层产品层限制：不让用户无限制地堆任务。
const MAX_INFLIGHT_TASKS = 3;

// 多个 composable 需要共享同一个 inflight / polling_ / newTaskUi,以支持
// 多任务并行 + 切工程时保留非当前工程的在飞任务。因此先创建 useInflight 一次,
// 然后把它的 API 传给 useSubmit / useGenerationState 等消费方。
const feishuApi = useFeishuReport({ showToast });

// useInflight 内部通过 inject 拿 apiKey/projectInfo/records;
// 只暴露 onTerminalSuccess(顶层需要指定飞书上报回调)
const inflightApi = useInflight({
  onTerminalSuccess: feishuApi.reportToFeishu,
  // 终态直通落盘:闭包延迟解引用,调用时 state 必已初始化
  onTerminalCommit: () => state.persistNow(),
});

// ---------- 全局状态（依赖 inflightApi.resumePolling 做故障恢复） ----------
// useGenerationState 内部通过 inject 拿 10 个高频 ref;
// 只暴露 storageMode(不入 SharedRefs) + resumePolling/getPersistableInflightRecords +
// recordPromptOptimization(optimizePrompt 落盘写入)
// ⚠ 必须在 useSubmit 之前声明 —— useSubmit 入参里要引用 state.recordPromptOptimization,
// const 没 hoisting,提前访问会 TDZ。
const state = useGenerationState({
  storageMode,
  // 参数约束按当前 provider 的 model descriptor 派生（可灵的规格由服务端下发）
  currentProviderId,
  findModelDescriptor,
  resumePolling: inflightApi.resumePolling,
  getPersistableInflightRecords: inflightApi.getPersistableInflightRecords,
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
    polling_: inflightApi.polling_,
    commitInflight: inflightApi.commitInflight,
    resumePolling: inflightApi.resumePolling,
    pollingActive: inflightApi.pollingActive as any,
    registerTransient: inflightApi.registerTransient,
    removeTransient: inflightApi.removeTransient,
    generatingTaskCount: inflightApi.generatingTaskCount as any,
  },
  reportToFeishu: feishuApi.reportToFeishu,
  // 可灵「提交即上报」:提交成功拿到实扣灵感值即入账,不等终态
  reportKlingSubmitted: feishuApi.reportKlingSubmitted,
  recordPromptOptimization: state.recordPromptOptimization,
  // 同时在飞任务上限(每个在飞任务都要起 CLI 轮询进程)
  maxInflightTasks: MAX_INFLIGHT_TASKS,
});

// ---------- 图片生成提交（阶段 2A：RunningHub 文生图） ----------
// 复用 useSubmit 的归属解析与 inflight/polling 单例;key 按图片平台现读
// （可灵没有 key 槽位 —— 走 CLI 登录态）
const imageSubmitApi = useImageSubmit({
  imageModel,
  imageProviderId: currentImageProviderId,
  imagePrompt,
  imageRatio,
  imageSize,
  showToast,
  resolveSubmitOwner: submitApi.resolveSubmitOwner,
  inflightApi: {
    resumePolling: inflightApi.resumePolling,
  },
  // 可灵图片「提交即上报」：提交成功拿到实扣灵感值即入账，不等终态
  reportKlingSubmitted: feishuApi.reportKlingImageSubmitted,
});

// ---------- 导入到工程 ----------
// useImport 内部通过 inject 拿 records;只暴露 showToast
const importApi = useImport({
  showToast,
});

// ---------- 重试 / 删除记录 ----------
// useRecordEdit 的视频分支走 inject 状态;图片分支经 retryImage 回填顶层图片态
const recordEditApi = useRecordEdit({
  retryImage: async (rec) => {
    generationMode.value = "image";
    imagePrompt.value = rec.prompt;
    // 平台回填：记录里的 provider 才是当初提交用的平台
    // （可灵记录必须在可灵平台重试 —— 模型清单与参数值域都不同）
    const recProvider = rec.params.provider || DEFAULT_IMAGE_PROVIDER_ID;
    if (recProvider !== currentImageProviderId.value) {
      await switchImageProvider(recProvider);
    }
    if (rec.params.model) imageModel.value = rec.params.model;
    if (rec.params.ratio) {
      imageRatio.value = rec.params.ratio as string;
      // 回填的是记录里的原值 → 视为用户选定，后续切平台不再被默认值覆盖
      imageRatioTouched.value = true;
    }
    // params.resolution 现在存的是计价档位（按像素总数算出），不一定等于 UI 档位：
    // width/height 与某个预设映射吻合 → 回填该档位；否则视为智能档（序列分辨率）
    const w = rec.imageParams?.width;
    const h = rec.imageParams?.height;
    if (w && h) {
      const matched = (["1K", "2K"] as const).find(
        (tier) => {
          const s = ratioToSize(rec.params.ratio, tier);
          return s.width === w && s.height === h;
        },
      );
      imageSize.value = matched ?? "智能";
    } else if (recProvider === KLING_PROVIDER_ID) {
      // 可灵记录没有 imageParams（实际像素由服务端决定），
      // 但 params.resolution 存的就是服务端档位（"1k"/"2k"/"4k"）→ 直接回填
      imageSize.value = rec.params.resolution;
    }
    // 尺寸同样是回填原值 → 视为用户选定
    imageSizeTouched.value = true;
    // 图生图参考回填（本地 localPath 仍在，重新提交时按 Base64 直传重读）
    references.value = rec.references;
  },
});

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
  // 素材上传目标按当前生成模式分流：图片模式 → 当前选中图片模型所属 provider，视频模式 → 视频侧 provider
  resolveUploadProviderId: () =>
    generationMode.value === "image"
      ? resolveImageProviderId()
      : currentProviderId.value,
  findModelDescriptor,
  // 抓帧只在视频模式下智能填写比例（写 opts.ratio 是视频表单，图片模式不可误写）
  isVideoMode: () => generationMode.value === "video",
  showToast,
});

// ---------- 提交前置守卫 ----------
/**
 * 当前在飞的真实生成任务数。
 *
 * inflightApi 在下方才创建，所以这里用 computed 惰性求值
 * （首次访问一定在 inflightApi 初始化之后）。
 */
const inflightCount = computed(() => inflightApi.generatingTaskCount.value);

/** 在飞任务已达上限 → 不能再提交 */
const inflightLimitReached = computed(
  () => inflightCount.value >= MAX_INFLIGHT_TASKS,
);

/** 在飞任务已达上限时的提示文案 */
const inflightLimitHint = computed(
  () =>
    `同时在飞任务已达上限（${MAX_INFLIGHT_TASKS} 个），请等待任务完成后再提交`,
);

/**
 * 提交被阻断的原因（给按钮显示用）。
 *
 * 只在「没有别的阻断原因」时给出 —— key 缺失 / 没项目等信息量更大，优先显示。
 */
const submitBlockedReason = computed(() => {
  if (!inflightLimitReached.value) return "";
  // 有更优先的阻断原因时不显示这条
  if (!apiKey.value && currentProviderId.value !== KLING_PROVIDER_ID) return "";
  if (!projectInfo.value) return "";
  return inflightLimitHint.value;
});

const canSubmit = computed(() => {
  // 可灵走 CLI 的 OAuth 登录态，没有 API Key 槽位 —— 不能拿 key 缺失当阻断条件
  if (!apiKey.value && currentProviderId.value !== KLING_PROVIDER_ID) {
    return false;
  }
  if (!prompt.value.trim()) return false;
  if (references.value.length === 0 && ratio.value === "adaptive") return false;
  // 在飞任务数达上限 → 阻断（避免无限制堆任务，每个任务都要起 CLI 轮询进程）
  if (inflightLimitReached.value) return false;
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
  // 注册可灵（经 C++ Hybrid addon 调本机 kling CLI）。
  // 模型清单由服务端动态下发（who_am_i），不在 mount 时拉取 —— 切到可灵时再按需加载，
  // 避免每次启动 PR 都白跑一次 CLI。清单加载失败时不清空回退硬编码（见 providers/kling）。
  if (!listProviders().find((p) => p.providerId === klingProvider.providerId)) {
    registerProvider(klingProvider);
  }
  videoProviderList.value = listProviders();
  // 注册图片 provider（RunningHub + 火山方舟 + 可灵），刷新聚合模型列表
  registerImageProvider(runningHubProvider);
  registerImageProvider(arkProvider);
  // 可灵图片 provider（文生图 / 图生图）：走 CLI 登录态，无需 API Key。
  // 模型清单与视频侧共用同一份 who_am_i 响应（切到可灵时才加载）。
  registerImageProvider(klingImageProvider);
  imageProviderList.value = listImageProviders();

  // 默认 provider：MiniMax 没配 key 时改用可灵（走 CLI 登录态，不需要 API Key）。
  // minimax 是老用户的默认路径 —— key 在就保持 minimax（无感），
  // 没 key 就切可灵，否则用户一进来看到的就是「请配置 API Key」。
  const minimaxKey = (await bridge.getApiKey(DEFAULT_PROVIDER_ID)) || "";
  minimaxKeyPresent.value = !!minimaxKey;
  if (!minimaxKey) {
    const klingReady = listProviders().some(
      (p) => p.providerId === KLING_PROVIDER_ID,
    );
    if (klingReady) {
      currentProviderId.value = KLING_PROVIDER_ID;
      // 可灵的模型清单要现拉（who_am_i）；拿不到就保持空列表，
      // 由设置面板的环境自检说明原因
      await loadKlingModels();
    }
  }

  // 异步获取当前 provider 实例
  currentProvider.value = await getProvider(currentProviderId.value);
  // 按当前视频 provider 读分槽 key(存储层对默认 provider 回落旧单 key);
  // 不传 providerId 只读旧单 key 槽位,而设置面板保存时只写分槽 → 初始永远读到空
  apiKey.value = (await bridge.getApiKey(currentProviderId.value)) || "";
  // 默认模型：当前 model 不属于新 provider 时,换成该 provider 的默认模型
  //（可灵是服务端 defaultModel = kling-video-v4_0,不是清单首项 v2_5）
  {
    const models = currentProvider.value?.models ?? [];
    if (models.length && !models.some((m) => m.modelId === model.value)) {
      model.value = pickDefaultModelFor(currentProviderId.value, models);
    }
  }
  // 图片平台默认（平台是显式状态，不再按 modelId 反查），与视频侧同策略：
  // - 有 key 的平台优先（RunningHub / 火山方舟 谁有 key 用谁）
  // - 两个都没 key → 默认可灵（走 CLI 登录态，不需要 key）
  try {
    const [rhKey, arkKey] = await Promise.all([
      bridge.getApiKey("runninghub"),
      bridge.getApiKey("ark"),
    ]);
    runningHubKeyPresent.value = !!rhKey;
    arkKeyPresent.value = !!arkKey;
    if (!rhKey && !arkKey) {
      // 没 key → 默认可灵。清单要现拉（who_am_i），切过去先加载再取默认模型
      await switchImageProvider(KLING_PROVIDER_ID);
    } else if (!rhKey && arkKey) {
      await switchImageProvider("ark");
    }
    // key 状态（切换过平台的由 switchImageProvider 负责，这里兜底当前平台）
    if (currentImageProviderId.value === KLING_PROVIDER_ID) {
      imageHasApiKey.value = true;
    } else {
      imageHasApiKey.value = !!(await bridge.getApiKey(currentImageProviderId.value));
    }
  } catch (e) {
    console.warn("[main-webview] 图片平台默认失败", e);
  }
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

  // 可灵环境自检：先读持久化快照渲染 UI，再后台跑一次真实检测覆盖它。
  // 不 await —— 启动不等 CLI（首次 >1s，二次有快照兜底）。
  void bootstrapKlingEnv();
});

function onSettingsSave(key: string, providerId: string) {
  // 仅当保存的是当前视频 provider 的 key 时更新顶层状态
  //（图片 provider 的 key 由提交链路按 providerId 现读）
  if (providerId === currentProviderId.value) {
    apiKey.value = key;
  }
  // MiniMax 的 key 状态变化会影响平台栏排序（没 key 时可灵排前面）
  if (providerId === DEFAULT_PROVIDER_ID) {
    minimaxKeyPresent.value = !!key.trim();
  }
  // 图片平台的 key 状态变化会影响平台栏排序（都没 key 时可灵排前面）
  if (providerId === "runninghub") {
    runningHubKeyPresent.value = !!key.trim();
  } else if (providerId === "ark") {
    arkKeyPresent.value = !!key.trim();
  }
  // 当前图片平台的 key 状态变化 → 提交按钮文案（"请配置 API Key"）
  if (providerId === currentImageProviderId.value) {
    imageHasApiKey.value = !!key.trim();
  }
  settingsOpen.value = false;
}

/** 图片生成模式（阶段 2A）：提交文生图任务 */
function onImageGenerate() {
  void imageSubmitApi.submitImageGenerate();
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
      :initial-provider-id="currentProviderId"
      @save="onSettingsSave"
    />

    <!-- 生成记录区：左列缩略图导航（点击跳转）+ 右列信息流（每条：meta 行 / 16:9 预览 / 操作行） -->
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

    <!-- 浮动窗口：模式切换工具行 + 参考素材 + 提示词 + 模型 + 参数按钮 + 生成按钮（贴底覆盖） -->
    <div class="floating-prompt-bar">
      <!-- 工具行：书签式模式切换（左） + 抓素材按钮（右） -->
      <div class="prompt-toolbar">
        <ModeTabs v-model:mode="generationMode" />
        <div class="capture-buttons">
          <button
            v-if="generationMode === 'video'"
            class="capture-btn"
            type="button"
            @click="refsApi.captureVideoAsReference"
          >🎬 抓视频</button>
          <button
            class="capture-btn"
            type="button"
            @click="refsApi.captureFrameAsReference"
          >🖼 抓帧</button>
          <button
            class="capture-btn"
            type="button"
            :class="{ 'capture-btn-locked': refsApi.psLocked.value }"
            :disabled="refsApi.psLocked.value"
            :title="refsApi.psLocked.value ? '已锁定 2 秒,避免重复启动 PS' : '抓帧后在 Photoshop 中打开'"
            @click="refsApi.captureFrameAndOpenInPs"
          >🎨 抓帧→PS</button>
        </div>
      </div>
      <template v-if="generationMode === 'video'">
        <ReferenceList
          :references="references"
          :tips="videoReferenceTips"
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
          :providers="videoProviderOptions"
          :provider-id="currentProviderId"
          :provider-notice="providerNotice"
          :models="providerModels"
          :constraints="state.constraints.value"
          :has-references="references.length > 0"
          :can-submit="canSubmit"
          :polling="inflightApi.pollingActive.value"
          :has-api-key="!!apiKey"
          :needs-api-key="currentProviderId !== KLING_PROVIDER_ID"
          :has-project="!!projectInfo"
          :optimizing="submitApi.optimizingPrompt.value"
          :submit-blocked-reason="submitBlockedReason"
          :submitting="submitApi.submitting.value"
          @update:providerId="switchVideoProvider"
          @submit="submitApi.submitGenerate"
          @optimize="submitApi.optimizePrompt"
        />
      </template>
      <!-- 图片生成模式：参考素材（无抓视频）+ 图片提示词/参数 -->
      <template v-else>
        <ReferenceList
          :references="references"
          tips="图片≤9"
          @remove="refsApi.removeReference"
          @confirmPending="refsApi.confirmPendingUpload"
        />
        <div class="prompt-divider"></div>
        <ImagePromptInput
          v-model:prompt="imagePrompt"
          v-model:model="imageModel"
          :ratio="imageRatio"
          :size="imageSize"
          :models="imageModels"
          :seq-size="imageSeqSize"
          :providers="imageProviderOptions"
          :provider-id="currentImageProviderId"
          :provider-notice="imageProviderNotice"
          :constraints="imageConstraints"
          :needs-api-key="imageNeedsApiKey"
          :has-api-key="imageHasApiKey"
          :supports-smart-size="imageSupportsSmartSize"
          @update:ratio="onImageRatioPick"
          @update:size="onImageSizePick"
          @update:providerId="switchImageProvider"
          @generate="onImageGenerate"
        />
      </template>
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

/* 工具行：模式 tab（左，稍大） + 抓素材按钮（右，稍小） */
.prompt-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.capture-buttons {
  display: flex;
  gap: 2px;
}

.capture-btn {
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
  &:disabled,
  &.capture-btn-locked {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
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
