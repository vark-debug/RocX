/**
 * 可灵 provider：实现 VideoGenProvider（经 C++ Hybrid addon 调本机 kling CLI）
 *
 * 与 MiniMax / RunningHub / Ark 三个 HTTP provider 的根本差异：
 * 1. 鉴权走 CLI 的浏览器 OAuth（`~/.kling/.credentials`），**没有 API Key 槽位**
 *    → buildAuthHeaders 返回空；createVideo / queryTask 的 apiKey 参数忽略
 * 2. 成本是**提交即扣**的实扣灵感值（creditsConsumed），不是本地价格表估算
 * 3. 模型清单由服务端动态下发（`who_am_i` → availableModels），本仓库不写死
 */
import { ref } from "vue";
import { bridge } from "../../services/bridge";
import type {
  VideoGenProvider,
} from "../core/VideoGenProvider";
import type {
  ModelDescriptor,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenErrorParsed,
} from "../core/types";
import { VideoGenError } from "../core/errors";
import type { ReferenceItem } from "@shared/messages";
import type { KlingCliExecResult } from "@shared/messages";
import {
  KLING_PROVIDER_ID,
  KLING_TOOL_IMAGE_TO_VIDEO,
  KLING_TOOL_OMNI_REF_VIDEO,
  KLING_TOOL_TEXT_TO_VIDEO,
  buildKlingGenArgs,
  buildKlingModelDescriptors,
  buildKlingQueryArgs,
  countKlingSlots,
  extractKlingCredits,
  extractKlingErrorMessage,
  extractKlingGenerationId,
  extractKlingResultUrl,
  findKlingModelSpec,
  mapKlingStatus,
  newKlingTraceId,
  parseKlingCatalog,
  pickKlingDefaultModel,
} from "./wireFormat";
import type { KlingModelCatalog } from "./wireFormat";
import { parseKlingError, friendlyKlingError, extractKlingRechargeUrl } from "./errorMap";
import { ensureKlingUrls, isKlingUrlExpired } from "./klingPreUpload";

// ---------- 模块级响应式状态 ----------
//
// 放在模块作用域而不是 class 实例上：provider 实例会被 Vue 的 reactive 代理包裹，
// 而 reactive 会自动解包实例上的 ref（this.modelsRef.value 会被读成 undefined）。
// 模块级 ref 不受该行为影响。

/** 可灵模型清单（who_am_i 拉取后填充；失败时保持空数组，不回退硬编码清单） */
export const klingModels = ref<ModelDescriptor[]>([]);

/** 可灵环境自检结果（供设置面板与提交前检查使用） */
export interface KlingEnvState {
  /** 环境是否可用（CLI 已装 + 已登录 + 模型清单拉到） */
  ready: boolean;
  /** 未就绪的原因 */
  reason?: "cli_not_installed" | "not_logged_in" | "error";
  /** 人话提示 */
  message?: string;
  /** 余额（灵感值），来自 `kling account` */
  credits?: number;
  /** 会员等级（如 SVIP） */
  membershipType?: string;
  /** 会员等级描述（如「铂金会员」） */
  membershipDescription?: string;
  /** 可用模型数量 */
  modelCount?: number;
  /**
   * 充值链接（由服务端在「灵感值不足」错误里下发，**不硬编码**）。
   * 可灵各区域 / 各活动的充值入口可能不同，写死链接会指错地方。
   */
  rechargeUrl?: string;
  /** 上次自检时间 */
  checkedAt?: string;
}

export const klingEnv = ref<KlingEnvState>({ ready: false });

/**
 * 余额告警阈值（灵感值）。
 *
 * 实测最低档任务（10s / 720p / kling-video-v2_5）扣 30 灵感值，更高分辨率 / 更长时长更贵。
 * 余额低于 100 意味着连几次最便宜的生成都撑不住 —— 提前提示好过提交失败才报错。
 */
export const KLING_LOW_CREDITS_THRESHOLD = 100;

// ---------- 模型清单缓存 ----------

let catalogCache: KlingModelCatalog | null = null;
let catalogPromise: Promise<boolean> | null = null;

/** 清空缓存（设置面板「重新检测」用） */
export function resetKlingCatalogCache(): void {
  catalogCache = null;
  catalogPromise = null;
}

// ---------- 环境快照持久化 ----------

/**
 * 把当前环境状态 + 模型清单写到持久层。
 *
 * 供下次启动直接读缓存渲染 UI，省掉每次启动的 CLI 定位开销（~1s+）。
 * 写盘失败不影响主流程（只是下次没有缓存可用）。
 */
async function persistKlingEnvSnapshot(): Promise<void> {
  try {
    const r = await bridge.setKlingEnvSnapshot({
      ready: klingEnv.value.ready,
      reason: klingEnv.value.reason,
      message: klingEnv.value.message,
      credits: klingEnv.value.credits,
      membershipType: klingEnv.value.membershipType,
      membershipDescription: klingEnv.value.membershipDescription,
      modelCount: klingEnv.value.modelCount,
      rechargeUrl: klingEnv.value.rechargeUrl,
      checkedAt: klingEnv.value.checkedAt,
      catalog: catalogCache ?? undefined,
    });
    if (!r?.ok) {
      console.warn("[kling] 环境快照写入失败:", r?.error);
    }
  } catch (e) {
    console.warn("[kling] 环境快照写入异常:", e);
  }
}

/**
 * 读持久化的环境快照，填进 klingEnv / 模型清单。
 *
 * 返回是否读到有效快照。失败态快照（未装 CLI / 未登录）**也会**被读进来，
 * 但调用方应据此决定是否立即重试检测（用户很可能刚装好 / 刚登录）。
 */
export async function restoreKlingEnvSnapshot(): Promise<boolean> {
  try {
    const snap = await bridge.getKlingEnvSnapshot();
    if (!snap) return false;

    klingEnv.value = {
      ...klingEnv.value,
      ready: !!snap.ready,
      reason: snap.reason,
      message: snap.message,
      credits: snap.credits,
      membershipType: snap.membershipType,
      membershipDescription: snap.membershipDescription,
      modelCount: snap.modelCount,
      rechargeUrl: snap.rechargeUrl,
      checkedAt: snap.checkedAt,
    };

    // 清单快照：存的是**已解析**的 catalog（{ [tool]: { defaultModel, models } }），
    // 与 parseKlingCatalog 的输入形状（{ availableModels: {...} }）不同，
    // 所以这里直接当 catalog 用，不能再过一遍 parseKlingCatalog。
    if (snap.catalog) {
      const catalog = snap.catalog as KlingModelCatalog;
      const models = buildKlingModelDescriptors(catalog);
      if (models.length) {
        catalogCache = catalog;
        klingModels.value = models;
      }
    }
    return true;
  } catch (e) {
    console.warn("[kling] 读环境快照失败:", e);
    return false;
  }
}

/**
 * 拉取可灵模型清单（`kling who_am_i`）。
 * 成功：填充 klingModels + klingEnv.ready，并缓存清单避免重复执行 CLI。
 * 失败：写入 klingEnv.reason / message，**不**回退到硬编码清单。
 */
export async function loadKlingModels(opts?: {
  force?: boolean;
}): Promise<boolean> {
  if (!opts?.force && catalogCache) {
    return true;
  }
  if (!opts?.force && catalogPromise) {
    // catalogPromise 永不 reject（内部已兜住），这里只需等待即可
    await catalogPromise;
    return catalogCache !== null;
  }

  const run = (async (): Promise<boolean> => {
    const res = await bridge.klingCliExec(["who_am_i", "--quiet"], {
      timeoutMs: 30000,
    });
    if (!res.ok) {
      catalogCache = null;
      klingEnv.value = {
        ...klingEnv.value,
        ready: false,
        reason: reasonOfCliCode(res.code),
        message: res.error || "可灵环境自检失败",
        checkedAt: new Date().toISOString(),
      };
      console.warn("[kling] 模型清单加载失败:", res.error || res.code);
      await persistKlingEnvSnapshot();
      return false;
    }
    const catalog = parseKlingCatalog(res.data);
    const models = buildKlingModelDescriptors(catalog);
    if (models.length === 0) {
      catalogCache = null;
      klingEnv.value = {
        ...klingEnv.value,
        ready: false,
        reason: "error",
        message: "可灵未返回任何可用视频模型",
        checkedAt: new Date().toISOString(),
      };
      console.warn("[kling] 模型清单为空（who_am_i 未返回可用视频模型）");
      await persistKlingEnvSnapshot();
      return false;
    }
    catalogCache = catalog;
    klingModels.value = models;
    klingEnv.value = {
      ...klingEnv.value,
      ready: true,
      reason: undefined,
      message: undefined,
      modelCount: models.length,
      checkedAt: new Date().toISOString(),
    };
    await persistKlingEnvSnapshot();
    return true;
  })();

  catalogPromise = run;
  try {
    return await run;
  } finally {
    catalogPromise = null;
  }
}

/** 取模型清单；没有缓存时同步加载一次（失败抛错，由调用方转成提示） */
export async function ensureKlingCatalog(): Promise<KlingModelCatalog> {
  if (catalogCache) return catalogCache;
  const ok = await loadKlingModels();
  if (!ok || !catalogCache) {
    throw new VideoGenError(
      klingEnv.value.message || "可灵模型清单不可用，请检查 CLI 安装与登录状态",
      { errorType: "catalog_unavailable", providerId: KLING_PROVIDER_ID },
    );
  }
  return catalogCache;
}

/**
 * 刷新可灵账户信息（`kling account`）：余额（灵感值）+ 会员等级。
 * 余额不足时用户需要知道充值入口 —— 充值链接由服务端在错误文本里下发。
 */
export async function refreshKlingAccount(): Promise<boolean> {
  const res = await bridge.klingCliExec(["account", "--quiet"], {
    timeoutMs: 30000,
  });
  if (!res.ok) {
    klingEnv.value = {
      ...klingEnv.value,
      message: res.error || "可灵账户信息获取失败",
      checkedAt: new Date().toISOString(),
    };
    await persistKlingEnvSnapshot();
    return false;
  }
  const b = res.data as any;
  klingEnv.value = {
    ...klingEnv.value,
    credits: typeof b?.availableRemainCredits === "number" ? b.availableRemainCredits : undefined,
    membershipType: typeof b?.membershipType === "string" ? b.membershipType : undefined,
    membershipDescription:
      typeof b?.membershipTypeDescription === "string"
        ? b.membershipTypeDescription
        : undefined,
    checkedAt: new Date().toISOString(),
  };
  await persistKlingEnvSnapshot();
  return true;
}

/** CLI 错误码 → 环境未就绪的原因 */
function reasonOfCliCode(
  code: string,
): "cli_not_installed" | "not_logged_in" | "error" {
  if (code === "cli_not_installed") return "cli_not_installed";
  if (code === "not_logged_in") return "not_logged_in";
  return "error";
}

/**
 * 取可灵的默认模型 id（服务端 defaultModel，实测是 kling-video-v4_0）。
 * 清单未加载时返回空串。
 */
export function getKlingDefaultModel(): string {
  return catalogCache ? pickKlingDefaultModel(catalogCache) : "";
}

// ---------- 启动时的环境自检（读缓存 → 后台刷新） ----------

/**
 * 插件启动时调用：先读持久化快照渲染 UI，再后台跑一次真实检测覆盖它。
 *
 * 为什么要分两步：
 * - CLI 定位（找 node → npm root → 探测 cli.js）要拉起好几个子进程，
 *   实测 >1s。全新安装时这部分开销是必然的，但二次启动没必要再付一次 ——
 *   快照能让 UI 立即可用。
 * - 但余额会变（每次提交都扣），模型清单也可能上新/下架，
 *   所以快照之后必须再跑一次真实检测（后台，用户无感）。
 *
 * 失败态快照（未装 CLI / 未登录）会**跳过**后台刷新之外的一切等待 ——
 * 用户很可能刚装好 CLI 或刚登录，所以失败态一律立刻重试检测。
 */
export async function bootstrapKlingEnv(): Promise<void> {
  const restored = await restoreKlingEnvSnapshot();

  // 后台刷新：catch 掉异常，避免未处理的 Promise rejection
  //（这个 promise 可能不被 await，异常会逃到全局）
  const refresh = refreshKlingEnvInBackground().catch((e) => {
    console.warn("[kling] 环境刷新失败:", e);
    return false;
  });

  // 成功态的快照直接可用 → 后台刷新即可，UI 不等它
  if (restored && klingEnv.value.ready) {
    void refresh;
    return;
  }
  // 失败态 / 无快照：用户急需知道能不能用，等检测结果
  await refresh;
}

/**
 * 跑一次完整的环境自检（模型清单 + 账户余额）并写回快照。
 * 供启动流程与设置面板「重新检测」共用。
 */
export async function refreshKlingEnvInBackground(): Promise<boolean> {
  const ok = await loadKlingModels({ force: true });
  if (ok) await refreshKlingAccount();
  return ok;
}

// ---------- trace id ----------
//
// CLI 的 --task-trace-id 是全局 flag，同一次任务的所有调用应带同一个值。
// 提交时生成，拿到 generationId 后登记，轮询时复用。

const traceIds = new Map<string, string>();

function traceIdFor(taskId: string): string {
  let id = traceIds.get(taskId);
  if (!id) {
    id = newKlingTraceId();
    traceIds.set(taskId, id);
  }
  return id;
}

// ---------- 参考图 ----------

/**
 * 参考素材来源：优先用预上传拿到的可灵 CDN 直链（过期则回退本地路径），
 * 其次公网 URL 直传（不下载重传），否则用本地绝对路径
 * （CLI 的 resolveFileUrl 会自动上传本地文件）。
 *
 * ⚠ fileId 可能是 number：MiniMax 上传接口返回的 file_id 是 int64（JSON 数字），
 * 历史记录里也存着 number。对非字符串一律按「没有 fileId」处理，只用本地路径。
 */
function referenceSource(ref: ReferenceItem): string {
  // 预上传直链：新鲜就直接给 CLI（resolveFileUrl 对 http(s) 直通不重传）
  if (ref.klingFileUrl && !isKlingUrlExpired(ref.klingUploadedAt)) {
    return ref.klingFileUrl;
  }
  const id = typeof ref.fileId === "string" ? ref.fileId.trim() : "";
  if (/^https?:\/\//i.test(id)) return id;
  return ref.localPath;
}

/**
 * 带参考视频时的音频参数。
 *
 * 服务端声明（omni_ref_video / kling-video-v3_0_omni）写明：
 * "With this video, images+elements ≤4, and enable_audio must be false."
 * → 带视频时 enable_audio 必须为 false，否则服务端直接拒绝。
 *
 * 官方 CLI 给的 v2v 示例同样是
 * `--enable_audio false --keepOriginalSound true`（保留源视频原声）。
 * 是否真的下发由 buildKlingGenArgs 按模型声明过滤 —— 模型没声明的参数不发，
 * 否则 CLI 会报「未知参数」。
 */
function klingVideoRefAudioArgs(): Record<string, string> {
  return { enable_audio: "false", keepOriginalSound: "true" };
}

// ---------- Provider ----------

export class KlingProvider implements VideoGenProvider {
  readonly providerId = KLING_PROVIDER_ID;
  readonly displayName = "可灵（Kling CLI）";

  /** 模型清单来自服务端动态下发（who_am_i），加载前为空 */
  get models(): ModelDescriptor[] {
    return klingModels.value;
  }

  /** 可灵走 CLI 的 OAuth 登录态，没有 API Key 概念 */
  buildAuthHeaders(_apiKey: string): Record<string, string> {
    return {};
  }

  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed {
    return parseKlingError(rawText, httpStatus);
  }

  friendlyErrorMessage(
    parsed: VideoGenErrorParsed,
    httpStatus: number,
  ): string {
    return friendlyKlingError(parsed, httpStatus);
  }

  /**
   * 提交视频生成。
   *
   * 按素材类型路由到对应工具（服务端声明为准）：
   * - 有视频参考 → `kling omni_ref_video --video …`（全能参考 / 视频→视频）
   * - 有图片参考 → `kling image_to_video --image …`
   * - 无参考     → `kling text_to_video`
   *
   * 服务端在 model declaration 里写明：
   * "This is the v2v input — use omni_ref_video, not image_to_video."
   * 即参考视频**只能**走 omni_ref_video。
   *
   * ⚠ 此处**不**触发飞书上报（可灵是「提交即上报」，由独立路径承担）。
   */
  async createVideo(
    req: VideoGenCreateRequest,
    _apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    // 等抓素材时启动的预上传跑完，把 CDN 直链回填到 ref。
    // 直链就绪 → CLI 的 resolveFileUrl 直通不重传（省掉内部 4-8s 上传）；
    // 没就绪 → 保持本地路径，CLI 自行上传（与改造前一致）。
    await ensureKlingUrls(req.references ?? []);

    const catalog = await ensureKlingCatalog();

    const imageRefs = req.references.filter((r) => r.type === "reference_image");
    const videoRefs = req.references.filter((r) => r.type === "reference_video");
    const audioRefs = req.references.filter((r) => r.type === "reference_audio");

    const tool = videoRefs.length
      ? KLING_TOOL_OMNI_REF_VIDEO
      : imageRefs.length
        ? KLING_TOOL_IMAGE_TO_VIDEO
        : KLING_TOOL_TEXT_TO_VIDEO;

    const spec = findKlingModelSpec(catalog, tool, req.model);
    if (!spec) {
      const hint =
        videoRefs.length
          ? "（该模型不支持参考视频，换用支持全能参考的模型）"
          : imageRefs.length
            ? "（该模型不支持图生视频）"
            : "";
      throw new VideoGenError(`可灵模型不可用：${req.model}${hint}`, {
        errorType: "unknown_model",
        providerId: this.providerId,
      });
    }

    if (audioRefs.length) {
      throw new VideoGenError(
        "可灵暂不支持音频参考素材（仅支持图片 / 视频参考）",
        { errorType: "unsupported_reference", providerId: this.providerId },
      );
    }

    const images: string[] = [];
    for (const ref of imageRefs) {
      const src = referenceSource(ref);
      if (!src) {
        throw new VideoGenError("参考素材缺少本地路径，无法提交", {
          errorType: "invalid_reference",
          providerId: this.providerId,
        });
      }
      images.push(src);
    }

    const videos: string[] = [];
    for (const ref of videoRefs) {
      const src = referenceSource(ref);
      if (!src) {
        throw new VideoGenError("参考视频缺少本地路径，无法提交", {
          errorType: "invalid_reference",
          providerId: this.providerId,
        });
      }
      videos.push(src);
    }

    // 槽位数量预检（CLI 侧同样会校验，这里提前给出更直接的提示）
    const imageCap = countKlingSlots(spec, "image");
    const videoCap = countKlingSlots(spec, "video");
    if (images.length > imageCap) {
      throw new VideoGenError(
        `模型 ${spec.model} 最多支持 ${imageCap} 张参考图，当前 ${images.length} 张`,
        { errorType: "too_many_references", providerId: this.providerId },
      );
    }
    if (videos.length > videoCap) {
      throw new VideoGenError(
        `模型 ${spec.model} 最多支持 ${videoCap} 个参考视频，当前 ${videos.length} 个`,
        { errorType: "too_many_references", providerId: this.providerId },
      );
    }
    // 素材合计上限（服务端 combinedItemCap）
    const cap = spec.combinedItemCap?.maxItems;
    if (typeof cap === "number" && images.length + videos.length > cap) {
      throw new VideoGenError(
        `模型 ${spec.model} 的参考素材合计上限为 ${cap} 个，当前 ${images.length + videos.length} 个`,
        { errorType: "too_many_references", providerId: this.providerId },
      );
    }
    const requiredInputs = (spec.inputs ?? []).filter((i) => i.required).length;
    if (images.length < requiredInputs) {
      throw new VideoGenError(
        `模型 ${spec.model} 需要至少 ${requiredInputs} 张参考图`,
        { errorType: "missing_references", providerId: this.providerId },
      );
    }

    const traceId = newKlingTraceId();
    const args = buildKlingGenArgs({
      tool,
      spec,
      prompt: req.prompt,
      ratio: req.ratio,
      duration: req.duration,
      resolution: req.resolution,
      images,
      videos,
      extraArgs: videos.length ? klingVideoRefAudioArgs() : undefined,
      traceId,
    });

    console.log(
      "%c[Kling createVideo]",
      "color:#e6a23c;font-weight:bold",
      "\nTool:", tool,
      "\nArgs:", JSON.stringify(args),
    );

    const res = await bridge.klingCliExec(args, { timeoutMs: 180000 });
    if (!res.ok) throw cliFailure(res, this.providerId);

    const taskId = extractKlingGenerationId(res.data);
    if (!taskId) {
      throw new VideoGenError("可灵提交响应缺少 generationId", {
        errorType: "missing_task_id",
        providerId: this.providerId,
      });
    }
    traceIds.set(taskId, traceId);

    const creditsConsumed = extractKlingCredits(res.data);
    return { taskId, creditsConsumed, raw: res.data };
  }

  /** 轮询任务状态（`kling query_tasks <generationId>`） */
  async queryTask(
    taskId: string,
    _apiKey: string,
  ): Promise<VideoGenQueryResponse> {
    const traceId = traceIdFor(taskId);
    const res = await bridge.klingCliExec(buildKlingQueryArgs(taskId, traceId), {
      timeoutMs: 60000,
    });
    if (!res.ok) throw cliFailure(res, this.providerId);

    const body = res.data as any;
    const status = mapKlingStatus(body?.status);
    const url = extractKlingResultUrl(body);
    const credits = extractKlingCredits(body);
    return {
      status,
      content: url ? { url } : undefined,
      error:
        status === "failed"
          ? { message: extractKlingErrorMessage(body) || "可灵任务失败" }
          : undefined,
      usage: credits !== undefined ? { credits_consumed: credits } : undefined,
      raw: body,
    };
  }
}

/** UXP 端返回的失败 → VideoGenError */
function cliFailure(res: KlingCliExecResult, providerId: string): VideoGenError {
  const raw = res.error || res.raw || "";
  // 环境类错误（未装 CLI / 未登录）UXP 端已给出可操作提示，直接透传
  if (
    res.code === "cli_not_installed" ||
    res.code === "addon_unavailable" ||
    res.code === "not_logged_in"
  ) {
    return new VideoGenError(raw, { errorType: res.code, providerId });
  }
  const parsed = parseKlingError(raw, 0);
  // 灵感值不足：服务端会在错误文本里带充值入口，把它记进环境状态供 UI 展示
  if (parsed.type === "insufficient_credits") {
    const url = extractKlingRechargeUrl(parsed.message || "");
    if (url) klingEnv.value = { ...klingEnv.value, rechargeUrl: url };
  }
  return new VideoGenError(friendlyKlingError(parsed, 0), {
    errorType: parsed.type || res.code,
    providerId,
  });
}

/**
 * 提交前的环境检查（可灵专有）。
 *
 * 覆盖三种「提交了也白搭」的情况：
 * 1. CLI 未安装 / 未登录 / 模型清单拉不到 → 环境不 ready
 * 2. 余额为 0 → 提交必然被服务端拒绝
 * 3. 其它 provider 不受影响（不调用本函数）
 *
 * ⚠️ **不阻塞提交**：余额检查用**已知的**余额（可能是上次的快照值），
 * 真实刷新放到后台跑。原因是 `kling account` 实测要 1.8s ——
 * 每次提交都同步等它，UI 的乐观更新就被挡在后面（用户体感 3-4s 无响应）。
 *
 * 代价：余额快照过期时可能漏挡「余额已归零」，但那种情况服务端会明确拒绝
 * 并带回充值链接，代价可控。
 *
 * 返回 ok=false 时 message 直接可作为用户提示。
 */
export async function checkKlingReady(): Promise<{ ok: boolean; message: string }> {
  // 1) 模型清单（who_am_i）：未登录 / CLI 未装 / 网络异常都在这一步暴露。
  //    清单有缓存时不发 CLI（loadKlingModels 内部判断），无缓存才拉一次。
  const modelsOk = await loadKlingModels();
  if (!modelsOk) {
    const env = klingEnv.value;
    return {
      ok: false,
      message: env.message || "可灵环境异常，无法提交",
    };
  }
  // 2) 余额：用**已知**余额判断（不等待 CLI）
  const credits = klingEnv.value.credits;
  if (typeof credits === "number" && credits <= 0) {
    // 余额为 0 必然被服务端拒绝。
    // 已经拿到充值链接 → 直接阻断（用户有地方可去）；
    // 还没拿到 → 放行，让服务端的拒绝把链接带回来 —— 充值 / 会员链接**只在服务端的
    // 错误响应里下发**（`account` 不返回、CLI 里也没有硬编码），此时阻断会让用户无路可走。
    if (klingEnv.value.rechargeUrl) {
      return { ok: false, message: rechargeHint() };
    }
  }
  // 3) 后台刷新真实余额（不 await —— 不能挡着提交）
  //    余额会随每次提交扣减，刷新后的值写回 klingEnv + 持久化快照。
  void refreshKlingAccount().catch((e) => {
    console.warn("[kling] 后台刷新余额失败:", e);
  });
  return { ok: true, message: "" };
}

/** 余额不足提示（带服务端下发的充值链接，若有） */
export function rechargeHint(): string {
  const url = klingEnv.value.rechargeUrl;
  return `可灵灵感值不足，请先充值${url ? `：${url}` : ""}`;
}
