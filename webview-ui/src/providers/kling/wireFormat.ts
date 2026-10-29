/**
 * 可灵 CLI wire format：模型清单解析 + 参数组装 + 响应字段提取
 *
 * 事实来源（可灵 CLI 实测输出 / `who_am_i` 实时声明，非编造）：
 * - 模型清单：`kling who_am_i` → body.availableModels.<tool>.models[]
 *   每项含 model / alias / description / arguments[] / inputs[]
 * - arguments[]：`{ name, required?, default?, allowedValues? }`
 *   duration（值域为字符串数组 "5" / "10" …）、aspect_ratio（"16:9" / "9:16" / "1:1" …）、
 *   resolution（"720p" / "1080p" / "4k"）、imageCount（"1" ~ "4"）
 * - inputs[]：参考图槽位声明（首帧 / 尾帧 / keyframe），required 标记必填
 * - 提交响应：generationId（任务 id）、creditsConsumed（本次实扣灵感值）
 * - 查询响应：status + works[].url（带水印）/ urlWithoutWatermark（无水印）/ coverUrl
 *
 * ⚠ 参数下发原则：CLI 的 matchDeclaredArguments 对**未在模型声明中**的参数直接抛
 *   ValidationError（"未知参数 --X"），因此这里一律按
 *   「目标工具（text_to_video / image_to_video）下该模型的实际声明」过滤，
 *   只下发被声明的参数。同一模型在两个工具下的声明并不相同 ——
 *   例如 image_to_video 下 v2_5 / v2_6 / v3_0 / v3_0_turbo **不声明 aspect_ratio**。
 */
import type {
  ModelDescriptor,
  VideoGenCapability,
  VideoGenQueryResponse,
} from "../core/types";
import { KLING_PROVIDER_ID } from "@shared/messages";

export { KLING_PROVIDER_ID };

/** 可灵视频工具名（`who_am_i` → availableModels 的键） */
export const KLING_TOOL_TEXT_TO_VIDEO = "text_to_video";
export const KLING_TOOL_IMAGE_TO_VIDEO = "image_to_video";
/**
 * 全能参考混排视频（视频 → 视频）。
 *
 * 服务端在 model declaration 里明确写了：
 * "This is the v2v input — use omni_ref_video, not image_to_video."
 * 即**参考视频只能走这个工具**，image_to_video 不接受视频槽位。
 */
export const KLING_TOOL_OMNI_REF_VIDEO = "omni_ref_video";

/**
 * 可灵图片工具名（`who_am_i` → availableModels 的键）。
 *
 * 实测（2026-10）服务端下发的图片工具：
 * - text_to_image：defaultModel = kling-image-v3_0_omni，无 inputs 槽位
 * - image_to_image：**无 defaultModel**（服务端没给），inputs 为 image_1..image_10
 *
 * ⚠ image_to_image 的 defaultModel 是 undefined —— 取默认模型时**不能**依赖它，
 *   得走 text_to_image 的 defaultModel（同一个模型在两个工具下都存在）。
 */
export const KLING_TOOL_TEXT_TO_IMAGE = "text_to_image";
export const KLING_TOOL_IMAGE_TO_IMAGE = "image_to_image";

// ---------- 模型清单结构 ----------

/** 单个生成参数的声明 */
export interface KlingArgSpec {
  name: string;
  required?: boolean;
  default?: unknown;
  allowedValues?: unknown[];
  description?: string;
}

/** 单个参考图槽位的声明 */
export interface KlingInputSpec {
  name: string;
  required?: boolean;
  description?: string;
}

/**
 * 素材合计上限声明（服务端下发）。
 * 例：{ maxItems: 15, inputPrefixes: ["image_", "video_", "audio_"] }
 */
export interface KlingCombinedCap {
  maxItems?: number;
  inputPrefixes?: string[];
}

/** 单个模型的声明 */
export interface KlingModelSpec {
  model: string;
  alias?: string;
  description?: string;
  arguments?: KlingArgSpec[];
  inputs?: KlingInputSpec[];
  /** 素材合计上限（图片 + 视频 + 音频等） */
  combinedItemCap?: KlingCombinedCap;
}

/** 单个工具（如 text_to_video）的声明 */
export interface KlingToolSpec {
  defaultModel?: string;
  models?: KlingModelSpec[];
}

/** availableModels：工具名 → 工具规格 */
export type KlingModelCatalog = Record<string, KlingToolSpec | undefined>;

// ---------- 模型清单解析 ----------

function normalizeArg(raw: any): KlingArgSpec | null {
  if (!raw || typeof raw.name !== "string") return null;
  return {
    name: raw.name,
    required: !!raw.required,
    default: raw.default,
    allowedValues: Array.isArray(raw.allowedValues) ? raw.allowedValues : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function normalizeInput(raw: any): KlingInputSpec | null {
  if (!raw || typeof raw.name !== "string") return null;
  return {
    name: raw.name,
    required: !!raw.required,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function normalizeModel(raw: any): KlingModelSpec | null {
  if (!raw || typeof raw.model !== "string") return null;
  const args = Array.isArray(raw.arguments)
    ? raw.arguments
        .map((a: any) => normalizeArg(a))
        .filter((a: KlingArgSpec | null): a is KlingArgSpec => !!a)
    : [];
  const inputs = Array.isArray(raw.inputs)
    ? raw.inputs
        .map((i: any) => normalizeInput(i))
        .filter((i: KlingInputSpec | null): i is KlingInputSpec => !!i)
    : [];
  return {
    model: raw.model,
    alias: typeof raw.alias === "string" ? raw.alias : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    arguments: args,
    inputs: inputs,
    combinedItemCap:
      raw.combinedItemCap && typeof raw.combinedItemCap === "object"
        ? {
            maxItems:
              typeof raw.combinedItemCap.maxItems === "number"
                ? raw.combinedItemCap.maxItems
                : undefined,
            inputPrefixes: Array.isArray(raw.combinedItemCap.inputPrefixes)
              ? raw.combinedItemCap.inputPrefixes.filter(
                  (p: unknown): p is string => typeof p === "string",
                )
              : undefined,
          }
        : undefined,
  };
}

/**
 * 从 `who_am_i` 的 body 中取出 availableModels。
 * 结构不符时返回空表（**不回退到硬编码清单**，硬编码会与真实服务端不一致）。
 */
export function parseKlingCatalog(body: unknown): KlingModelCatalog {
  const raw = (body as any)?.availableModels;
  if (!raw || typeof raw !== "object") return {};
  const out: KlingModelCatalog = {};
  for (const [tool, spec] of Object.entries(raw as Record<string, any>)) {
    if (!spec || typeof spec !== "object") continue;
    const models = Array.isArray(spec.models)
      ? spec.models
          .map((m: any) => normalizeModel(m))
          .filter((m: KlingModelSpec | null): m is KlingModelSpec => !!m)
      : [];
    out[tool] = {
      defaultModel:
        typeof spec.defaultModel === "string" ? spec.defaultModel : undefined,
      models,
    };
  }
  return out;
}

/** 取某工具下的模型声明；找不到返回 null */
export function findKlingModelSpec(
  catalog: KlingModelCatalog,
  tool: string,
  modelId: string,
): KlingModelSpec | null {
  const models = catalog[tool]?.models ?? [];
  return models.find((m) => m.model === modelId) ?? null;
}

/**
 * 取可灵的默认模型 id。
 *
 * 用服务端 `who_am_i` 下发的 `defaultModel`（实测三个工具都是 `kling-video-v4_0`），
 * **不能取清单首项** —— 服务端返回的顺序是
 * `v2_5, v2_6, o1, v3_0_omni, v3_0, v3_0_turbo, v4_0`，
 * 首项是旧版 v2_5，不是服务端认为的默认款。
 *
 * 服务端没给 defaultModel 时兜底取首项。
 */
export function pickKlingDefaultModel(catalog: KlingModelCatalog): string {
  // text_to_video 是主入口（文生视频），优先取它的 defaultModel
  for (const tool of [
    KLING_TOOL_TEXT_TO_VIDEO,
    KLING_TOOL_IMAGE_TO_VIDEO,
    KLING_TOOL_OMNI_REF_VIDEO,
  ]) {
    const def = catalog[tool]?.defaultModel;
    if (def) return def;
  }
  // 兜底：任一工具的首个模型
  for (const spec of Object.values(catalog)) {
    const first = spec?.models?.[0]?.model;
    if (first) return first;
  }
  return "";
}

/**
 * 模型展示名：alias 里的首个中文项优先，否则取首项，都没有则用 model id。
 * 例："kling3.0, 可灵3.0, 视频3.0" → "可灵3.0"
 */
function klingDisplayName(modelId: string, alias?: string): string {
  const parts = (alias ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.find((p) => /[\u4e00-\u9fa5]/.test(p)) ?? parts[0] ?? modelId;
}

/**
 * 把模型清单拍平成 UI 下拉直接可用的 ModelDescriptor[]。
 *
 * 同一模型在两个工具下的声明合并：参数值域取并集、能力位取并集。
 * 只声明 CLI 实际支持的能力位 —— **不声明** resolutionUpscale / promptOptimization
 * （可灵 CLI 无此能力）。
 */
export function buildKlingModelDescriptors(
  catalog: KlingModelCatalog,
): ModelDescriptor[] {
  const merged = new Map<
    string,
    {
      alias?: string;
      description?: string;
      durations: Set<number>;
      ratios: Set<string>;
      resolutions: Set<string>;
      imageInput: boolean;
      videoInput: boolean;
    }
  >();

  for (const tool of [KLING_TOOL_TEXT_TO_VIDEO, KLING_TOOL_IMAGE_TO_VIDEO]) {
    for (const spec of catalog[tool]?.models ?? []) {
      const cur = merged.get(spec.model) ?? {
        durations: new Set<number>(),
        ratios: new Set<string>(),
        resolutions: new Set<string>(),
        imageInput: false,
        videoInput: false,
      };
      cur.alias = cur.alias ?? spec.alias;
      cur.description = cur.description ?? spec.description;
      for (const arg of spec.arguments ?? []) {
        const values = (arg.allowedValues ?? []).map((v) => String(v));
        if (arg.name === "duration") {
          for (const v of values) {
            const n = Number(v);
            if (Number.isFinite(n)) cur.durations.add(n);
          }
        } else if (arg.name === "aspect_ratio") {
          for (const v of values) cur.ratios.add(v);
        } else if (arg.name === "resolution") {
          for (const v of values) cur.resolutions.add(v);
        }
      }
      if ((spec.inputs ?? []).length > 0) cur.imageInput = true;
      merged.set(spec.model, cur);
    }
  }

  // omni_ref_video（全能参考 / 视频→视频）：
  // 声明了 video_N 槽位的模型才具备「视频参考」能力。
  //
  // ⚠ 这里**只记能力位，不把 omni 的参数值域并进 UI 约束**：
  // omni 的 aspect_ratio 多一个 "auto"（仅在提供素材时合法），
  // 并进去会让用户在文生视频场景选到非法值 → CLI 报参数错误。
  // 实测三个 omni 模型的 text/image_to_video 值域都是 omni 值域的**子集**，
  // 所以不并入也能保证下发到 omni 的参数合法。
  for (const spec of catalog[KLING_TOOL_OMNI_REF_VIDEO]?.models ?? []) {
    const cur = merged.get(spec.model);
    if (!cur) continue;
    if ((spec.inputs ?? []).some((i) => i.name.startsWith("video_"))) {
      cur.videoInput = true;
    }
  }

  return Array.from(merged.entries()).map(([modelId, m]) => {
    const capabilities: VideoGenCapability[] = ["videoGeneration"];
    if (m.imageInput) capabilities.push("imageReference");
    if (m.videoInput) capabilities.push("videoReference");
    return {
      providerId: KLING_PROVIDER_ID,
      modelId,
      displayName: klingDisplayName(modelId, m.alias),
      description: m.description,
      paramConstraints: {
        resolutions: Array.from(m.resolutions),
        durations: Array.from(m.durations).sort((a, b) => a - b),
        ratios: Array.from(m.ratios),
        ratioAdaptiveAllowed: false,
      },
      capabilities,
    };
  });
}

// ---------- 图片模型 ----------

/**
 * 可灵图片模型的参数值域。
 *
 * 与视频模型的关键差异（实测 2026-10 的 who_am_i 声明）：
 * - **分辨率档位参数叫 `img_resolution`**（不是视频的 `resolution`），值域 "1k"/"2k"/"4k"
 *   —— 全部小写，视频侧是 "720p"/"1080p" 那种写法，别混。
 * - **比例参数仍叫 `aspect_ratio`**，但值域多了 "auto"（让模型自己从提示词/参考图推断）
 * - 有 `imageCount` 参数（1~9），视频侧没有
 * - 无 `duration`（图片没有时长）
 *
 * 比例值域里带 "auto" 的模型只有部分：v3_0_omni（两个工具都有）、
 * o1 / v3_0（仅 image_to_image 有）。text_to_image 下 o1/v3_0/v2_1 **没有** "auto"。
 */
export interface KlingImageParamSpec {
  model: string;
  alias?: string;
  description?: string;
  /** img_resolution 值域（"1k" / "2k" / "4k"）；模型没声明该参数则为空 */
  resolutions: string[];
  /** aspect_ratio 值域（含 "auto"） */
  ratios: string[];
  /** imageCount 值域（"1" ~ "9"） */
  counts: string[];
  /** 该模型是否支持参考图（图生图） */
  supportsReference: boolean;
  /** 参考图槽位声明（image_1..image_10 或 v2_1 的 subject_image_N/scene_image/style_image） */
  inputs: KlingInputSpec[];
  /**
   * 默认 img_resolution（"2k"）。
   *
   * 取**平台默认值**（服务端默认模型的声明）—— 该模型不支持时退回自己的声明默认。
   */
  defaultResolution?: string;
  /**
   * 默认 aspect_ratio（"auto"）。
   *
   * 取**平台默认值**（服务端默认模型的声明）—— 该模型不支持时退回自己的声明默认。
   */
  defaultRatio?: string;
}

/**
 * 把图片工具下的模型声明拍平成统一的参数值域。
 *
 * 同一模型在 text_to_image / image_to_image 两个工具下的声明**合并**：
 * - resolutions / ratios / counts 取并集
 * - supportsReference：只要在 image_to_image 下声明了图片槽位即为 true
 *
 * ⚠ ratios 取并集会让 text_to_image 场景选到 "auto"（只有 image_to_image 声明了它），
 *   但服务端对 text_to_image 也接受 auto（v3_0_omni 在两个工具下都声明了），
 *   且 auto 只在部分模型有效 —— 提交时由 pickDeclaredValue 按**目标工具**的实际声明
 *   复核，不在值域内的值会被换掉，不会下发非法参数。
 */
export function buildKlingImageParamSpecs(
  catalog: KlingModelCatalog,
): KlingImageParamSpec[] {
  const merged = new Map<
    string,
    {
      alias?: string;
      description?: string;
      resolutions: Set<string>;
      ratios: Set<string>;
      counts: Set<string>;
      supportsReference: boolean;
      inputs: KlingInputSpec[];
      defaultResolution?: string;
      defaultRatio?: string;
    }
  >();

  for (const tool of [KLING_TOOL_TEXT_TO_IMAGE, KLING_TOOL_IMAGE_TO_IMAGE]) {
    for (const spec of catalog[tool]?.models ?? []) {
      const cur = merged.get(spec.model) ?? {
        resolutions: new Set<string>(),
        ratios: new Set<string>(),
        counts: new Set<string>(),
        supportsReference: false,
        inputs: [],
      };
      cur.alias = cur.alias ?? spec.alias;
      cur.description = cur.description ?? spec.description;
      for (const arg of spec.arguments ?? []) {
        const values = (arg.allowedValues ?? []).map((v) => String(v));
        if (arg.name === "img_resolution") {
          for (const v of values) cur.resolutions.add(v);
          // 首个声明的默认值即该模型自己的声明默认（text_to_image 优先，它是主入口）
          if (cur.defaultResolution === undefined && arg.default != null) {
            cur.defaultResolution = String(arg.default);
          }
        } else if (arg.name === "aspect_ratio") {
          for (const v of values) cur.ratios.add(v);
          if (cur.defaultRatio === undefined && arg.default != null) {
            cur.defaultRatio = String(arg.default);
          }
        } else if (arg.name === "imageCount") {
          for (const v of values) cur.counts.add(v);
        }
      }
      if (tool === KLING_TOOL_IMAGE_TO_IMAGE && (spec.inputs ?? []).length > 0) {
        cur.supportsReference = true;
        cur.inputs = spec.inputs ?? [];
      }
      merged.set(spec.model, cur);
    }
  }

  /**
   * 平台默认值 = **服务端默认模型**（text_to_image.defaultModel）的声明。
   *
   * ⚠ 为什么不用「每个模型各自的声明默认」：
   *   服务端给各模型声明的 aspect_ratio 默认值并不一致（实测 text_to_image 下
   *   o3 声明 "auto"、o1 / v3_0 声明 "1:1"、v2_1 声明 "3:4"）。
   *   按各自声明取默认值 → 切模型时宽高比会跳变（auto → 1:1 → 3:4），
   *   用户看到的「平台默认值」随模型漂移。
   *   默认模型才是服务端口径里的「默认」，它的声明就是平台默认值。
   *
   * 模型不支持平台默认值时（如 v2_1 两个工具都不声明 "auto"）
   * → 退回该模型自己的声明默认。
   */
  const platformDefaults = merged.get(pickKlingImageDefaultModel(catalog));

  return Array.from(merged.entries()).map(([model, m]) => ({
    model,
    alias: m.alias,
    description: m.description,
    resolutions: Array.from(m.resolutions),
    ratios: orderRatiosAutoFirst(Array.from(m.ratios)),
    counts: Array.from(m.counts),
    supportsReference: m.supportsReference,
    inputs: m.inputs,
    defaultResolution:
      platformDefaults?.defaultResolution &&
      m.resolutions.has(platformDefaults.defaultResolution)
        ? platformDefaults.defaultResolution
        : m.defaultResolution,
    defaultRatio:
      platformDefaults?.defaultRatio && m.ratios.has(platformDefaults.defaultRatio)
        ? platformDefaults.defaultRatio
        : m.defaultRatio,
  }));
}

/**
 * 把 "auto" 排到宽高比值域首位。
 *
 * 并集里 "auto" 只出现在 image_to_image 的声明里 → 直接展开会排在末尾，
 * 而默认模型（o3）的 "auto" 恰好在首位。切模型时同一个选项在列表里的
 * 位置会来回跳，把它固定到首位，列表顺序就与模型无关了。
 */
function orderRatiosAutoFirst(ratios: string[]): string[] {
  if (!ratios.includes("auto")) return ratios;
  return ["auto", ...ratios.filter((r) => r !== "auto")];
}

/** 图片工具的参考图槽位上限（取声明里的槽位数） */
export function countKlingImageSlots(spec: KlingModelSpec): number {
  return (spec.inputs ?? []).length;
}

/**
 * 把图片参数值域拍平成 UI 下拉直接可用的 ModelDescriptor[]。
 *
 * paramConstraints 的复用约定（与视频侧一致）：
 * - resolutions → img_resolution 的值域（"1k"/"2k"/"4k"）
 * - ratios → aspect_ratio 的值域
 * - durations → 空（图片无时长）
 */
export function buildKlingImageModelDescriptors(
  catalog: KlingModelCatalog,
): ModelDescriptor[] {
  return buildKlingImageParamSpecs(catalog).map((spec) => ({
    providerId: KLING_PROVIDER_ID,
    modelId: spec.model,
    displayName: klingDisplayName(spec.model, spec.alias),
    description: spec.description,
    paramConstraints: {
      resolutions: spec.resolutions,
      durations: [],
      ratios: spec.ratios,
      ratioAdaptiveAllowed: false,
      defaultResolution: spec.defaultResolution,
      defaultRatio: spec.defaultRatio,
    },
    capabilities: ["imageGeneration"],
  }));
}

/**
 * 取可灵图片的默认模型 id。
 *
 * 服务端给 text_to_image 的 defaultModel 是 `kling-image-v3_0_omni`，
 * 但 image_to_image **没有** defaultModel —— 所以取默认模型时
 * 必须先看 text_to_image（它覆盖了全部图片模型）。
 *
 * ⚠ 不能取清单首项：服务端返回顺序是
 * `v3_0_omni, o1, v3_0, v2_1`，首项恰好是默认款，
 * 但这是巧合 —— 依赖服务端顺序迟早失效。
 */
export function pickKlingImageDefaultModel(catalog: KlingModelCatalog): string {
  const def = catalog[KLING_TOOL_TEXT_TO_IMAGE]?.defaultModel;
  if (def) return def;
  const first = catalog[KLING_TOOL_TEXT_TO_IMAGE]?.models?.[0]?.model;
  if (first) return first;
  return "";
}

/** 图片参数组装计划 */
export interface KlingImagePlan {
  /** 目标工具：text_to_image / image_to_image */
  tool: string;
  /** 目标工具下该模型的声明 */
  spec: KlingModelSpec;
  prompt: string;
  /** img_resolution（"1k" / "2k" / "4k"）；模型没声明则不下发 */
  resolution: string;
  /** aspect_ratio（含 "auto"） */
  ratio: string;
  /** imageCount（张数） */
  count: number;
  /** 参考图来源（CDN 直链或本地绝对路径） */
  images: string[];
  /** 本次任务的 trace id */
  traceId: string;
}

/**
 * 组装图片生成的 CLI 参数数组。
 *
 * 参考图用 `--image`（按序填入声明的槽位），**不用** `--input name=value`：
 * - `--input` 与 `--image` 不能混用（CLI 会直接报 ValidationError）
 * - `--input` 要求逐个写明全部槽位名，v2_1 的语义槽位（scene/style）无法表达
 * - `--image` 由 CLI 按 spec.inputs 顺序自动填（cli.js:19448 `images.map((value, i) => ({ name: spec.inputs?.[i]?.name ?? "input", value }))`）
 *
 * ⚠ 参数一律按**目标工具下的实际声明**过滤 —— CLI 的 matchDeclaredArguments
 *   对未声明参数直接抛 "未知参数 --X"。
 */
export function buildKlingImageArgs(plan: KlingImagePlan): string[] {
  const args: string[] = [plan.tool];
  pushFlag(args, "model", plan.spec.model);

  const declared = new Map<string, KlingArgSpec>();
  for (const a of plan.spec.arguments ?? []) declared.set(a.name, a);

  const resolution = pickDeclaredValue(declared.get("img_resolution"), plan.resolution);
  if (resolution !== undefined) pushFlag(args, "img_resolution", resolution);

  const ratio = pickDeclaredValue(declared.get("aspect_ratio"), plan.ratio);
  if (ratio !== undefined) pushFlag(args, "aspect_ratio", ratio);

  const count = pickDeclaredValue(declared.get("imageCount"), String(plan.count));
  if (count !== undefined) pushFlag(args, "imageCount", count);

  for (const img of plan.images) pushFlag(args, "image", img);

  // prompt 始终显式下发：CLI 对 text_to_image 要求 prompt 非空
  pushFlag(args, "prompt", plan.prompt);

  args.push("--task-trace-id", plan.traceId);
  args.push("--quiet");
  return args;
}

// ---------- 参数组装 ----------

/**
 * 在模型声明的值域内挑一个可用值。
 * - 模型没声明该参数 → 返回 undefined（调用方据此不下发）
 * - 声明了但当前选择不在值域 → 退回声明的 default；没有 default 时取值域首项
 */
export function pickDeclaredValue(
  arg: KlingArgSpec | undefined,
  wanted: string,
): string | undefined {
  if (!arg) return undefined;
  const allowed = (arg.allowedValues ?? []).map((v) => String(v));
  if (allowed.length === 0) return wanted;
  if (allowed.includes(wanted)) return wanted;
  const def = arg.default === undefined || arg.default === null ? "" : String(arg.default);
  if (def && allowed.includes(def)) return def;
  return allowed[0];
}

/**
 * 统计模型声明里某类素材槽位的数量。
 *
 * omni_ref_video 用的是显式编号槽位（image_1..image_10 / video_1..video_5）；
 * image_to_video 用的是语义槽位（first_image / tail_image / keyframe_1..10），
 * 所以按前缀统计只适用于 omni —— image_to_video 一律按 inputs 总数算。
 */
export function countKlingSlots(
  spec: KlingModelSpec,
  kind: "image" | "video",
): number {
  const inputs = spec.inputs ?? [];
  if (kind === "video") {
    return inputs.filter((i) => i.name.startsWith("video_")).length;
  }
  const numbered = inputs.filter((i) => i.name.startsWith("image_")).length;
  if (numbered > 0) return numbered;
  // image_to_video 形态：非尾帧的图片槽位（tail_image 由 --tailImage 单独指定）
  return inputs.filter((i) => i.name !== "tail_image" && i.name !== "tailImage")
    .length;
}

export interface KlingGenPlan {
  /** 目标工具：text_to_video / image_to_video / omni_ref_video */
  tool: string;
  /** 目标工具下该模型的声明（决定哪些参数可下发） */
  spec: KlingModelSpec;
  prompt: string;
  ratio: string;
  duration: number;
  resolution: string;
  /** 参考图来源：公网 URL 或本地绝对路径（CLI 会自动上传本地文件） */
  images: string[];
  /** 参考视频来源（omni_ref_video 的 video_N 槽位） */
  videos: string[];
  /**
   * 额外要下发的声明参数。
   * 只有**模型声明里存在**的参数才会下发（否则 CLI 报「未知参数」）。
   */
  extraArgs?: Record<string, string>;
  /** 本次任务的 trace id（32 位十六进制），同一次任务的多次 CLI 调用复用同一值 */
  traceId: string;
}

/**
 * 往 argv 里追加一个 `--flag 值`。
 *
 * ⚠ 为什么不能一律用 `--flag=value`：
 *   CLI 的 parseFlags 用正则 `/^--([A-Za-z][A-Za-z0-9_-]*)=(.*)$/` 匹配等号形式，
 *   而 JS 正则的 `.` **默认不匹配换行** —— 所以 `--prompt=第一行\n第二行`
 *   整个匹配失败，该参数被丢弃，CLI 认为「没给 prompt」，
 *   于是把整段 usage 打到 stderr 并 exit 1（表现为「可灵拒绝了当前参数：Usage: ...」）。
 *
 * ⚠ 为什么也不能一律用分离形式（`--flag` + 值）：
 *   分离形式要求「下一个 argv 元素不以 `--` 开头」，否则该值会被当成新 flag 吞掉，
 *   于是 `--prompt --hello` 里的值丢失，prompt 同样变空 → 又是 usage 报错。
 *
 * 所以按值的内容二选一（两者都由 CLI 源码 parseFlags 与真实 CLI 实测确认）：
 *   - 值以 `--` 开头 → 等号形式（值不会被当成 flag）
 *   - 其余（含换行）→ 分离形式（换行不会被正则吞掉）
 */
function pushFlag(args: string[], name: string, value: string): void {
  if (value.startsWith("--")) {
    // 等号形式的正则同样不匹配换行 —— 「以 -- 开头 + 含换行」是唯一无法无损表达的场景。
    // 此时把换行折成空格：对视频生成模型而言空白折叠是无损的，好过整条命令失败。
    args.push(`--${name}=${value.replace(/\r?\n/g, " ")}`);
    return;
  }
  args.push(`--${name}`, value);
}

/**
 * 组装 CLI 参数数组。
 *
 * flag 名用**声明里的原名**（如 aspect_ratio）；CLI 同时接受 camelCase 形式，
 * 但原名一定命中 matchDeclaredArguments 的第一个匹配分支。
 */
export function buildKlingGenArgs(plan: KlingGenPlan): string[] {
  const args: string[] = [plan.tool];
  pushFlag(args, "model", plan.spec.model);

  const declared = new Map<string, KlingArgSpec>();
  for (const a of plan.spec.arguments ?? []) declared.set(a.name, a);

  const duration = pickDeclaredValue(declared.get("duration"), String(plan.duration));
  if (duration !== undefined) pushFlag(args, "duration", duration);

  // 部分模型在 image_to_video 下不声明 aspect_ratio → 不下发（否则 CLI 报"未知参数"）
  const ratio = pickDeclaredValue(declared.get("aspect_ratio"), plan.ratio);
  if (ratio !== undefined) pushFlag(args, "aspect_ratio", ratio);

  const resolution = pickDeclaredValue(declared.get("resolution"), plan.resolution);
  if (resolution !== undefined) pushFlag(args, "resolution", resolution);

  // 参考图：CLI 按模型声明的输入槽位顺序填充（非尾帧槽位）
  for (const img of plan.images) pushFlag(args, "image", img);

  // 参考视频：omni_ref_video 的 video_N 槽位（CLI 单独按 --video 顺序填）
  for (const vid of plan.videos) pushFlag(args, "video", vid);

  // 额外参数：只有模型声明里有的才下发
  for (const [name, value] of Object.entries(plan.extraArgs ?? {})) {
    const arg = declared.get(name);
    if (!arg) continue;
    const allowed = (arg.allowedValues ?? []).map((v) => String(v));
    if (allowed.length && !allowed.includes(value)) continue;
    pushFlag(args, name, value);
  }

  // prompt 始终显式下发：CLI 对 text_to_video 要求 prompt 非空
  pushFlag(args, "prompt", plan.prompt);

  // 全局 flag：同一次任务的提交与轮询复用同一 trace id
  args.push("--task-trace-id", plan.traceId);
  args.push("--quiet");
  return args;
}

/** 轮询参数 */
export function buildKlingQueryArgs(taskId: string, traceId: string): string[] {
  return ["query_tasks", taskId, "--task-trace-id", traceId, "--quiet"];
}

/** 生成 32 位十六进制 trace id（CLI 侧的 task-trace-id 格式） */
export function newKlingTraceId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch {
    // 落到下面的兜底
  }
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// ---------- 响应字段提取 ----------

/**
 * 状态映射（大小写不敏感）。
 * CLI 内部判定：PENDING = submitted/pending/queuing/queueing/processing/running，
 * SUCCESS = succeed/succeeded/success/completed/partial_completed，其余为终态。
 */
export function mapKlingStatus(status?: string): VideoGenQueryResponse["status"] {
  const s = (status ?? "").trim().toLowerCase();
  switch (s) {
    case "submitted":
    case "pending":
    case "queuing":
    case "queueing":
    case "queued":
      return "queued";
    case "running":
    case "processing":
      return "running";
    case "succeed":
    case "succeeded":
    case "success":
    case "completed":
    case "partial_completed":
      return "succeeded";
    case "failed":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      // 未知状态按失败处理，避免无限轮询
      return "failed";
  }
}

/** 取任务 id（CLI 侧 extractGenerationId 取 generationId ?? generation_id） */
export function extractKlingGenerationId(body: unknown): string {
  const b = body as any;
  const id =
    b?.generationId ?? b?.generation_id ?? b?.data?.generationId ?? b?.data?.generation_id;
  return typeof id === "string" ? id : "";
}

/** 取本次实扣灵感值（提交 / 查询响应都可能带） */
export function extractKlingCredits(body: unknown): number | undefined {
  const b = body as any;
  const v =
    b?.creditsConsumed ??
    b?.credits_consumed ??
    b?.data?.creditsConsumed ??
    b?.data?.credits_consumed;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 取结果视频地址。
 * works[].url 优先（服务端声明的带水印地址），其次 urlWithoutWatermark / coverUrl。
 */
export function extractKlingResultUrl(body: unknown): string | undefined {
  const b = body as any;
  const works = Array.isArray(b?.works)
    ? b.works
    : Array.isArray(b?.data?.works)
      ? b.data.works
      : [];
  for (const w of works) {
    const url = w?.url ?? w?.urlWithoutWatermark ?? w?.coverUrl;
    if (typeof url === "string" && url) return url;
  }
  const direct = b?.url ?? b?.videoUrl ?? b?.data?.url ?? b?.data?.videoUrl;
  return typeof direct === "string" && direct ? direct : undefined;
}

/**
 * 取结果**图片**地址。
 *
 * 与视频侧 extractKlingResultUrl 的优先级相反：图片优先取 `urlWithoutWatermark`。
 *
 * 实测（2026-10，image_to_image）：works[] 同时给两个地址 ——
 * - url                 → p4-fdl，**带水印**（2048×2048 PNG 6.70 MB）
 * - urlWithoutWatermark → p4-fdl，无水印（同尺寸 5.90 MB）
 *
 * 图片是素材（要落到 PR 序列里再导出的），带水印等于把水印烙进成片，
 * 所以图片侧必须取无水印那个。视频侧维持原样（url 优先），不动既有行为。
 */
export function extractKlingImageResultUrl(body: unknown): string | undefined {
  const b = body as any;
  const works = Array.isArray(b?.works)
    ? b.works
    : Array.isArray(b?.data?.works)
      ? b.data.works
      : [];
  for (const w of works) {
    const url = w?.urlWithoutWatermark ?? w?.url ?? w?.coverUrl;
    if (typeof url === "string" && url) return url;
  }
  const direct = b?.url ?? b?.imageUrl ?? b?.data?.url ?? b?.data?.imageUrl;
  return typeof direct === "string" && direct ? direct : undefined;
}

/** 从失败响应体里取人话错误信息 */
export function extractKlingErrorMessage(body: unknown): string {
  if (typeof body === "string") return body;
  const b = body as any;
  const msg =
    b?.message ?? b?.error?.message ?? b?.error ?? b?.reason ?? b?.msg ?? b?.detail;
  if (typeof msg === "string" && msg) return msg;
  if (msg && typeof msg === "object") return JSON.stringify(msg);
  return "";
}
