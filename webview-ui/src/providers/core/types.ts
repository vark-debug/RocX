/**
 * Provider 抽象层共享类型
 */
import type { ReferenceItem } from "@shared/messages";

// 通用创建请求（不同 provider 在内部映射到各自的 wire format）
export interface VideoGenCreateRequest {
  model: string;                 // provider-specific model id
  prompt: string;
  ratio: string;                 // "16:9" | "adaptive" 等通用值
  duration: number;              // 秒
  resolution: string;            // "768P" | "2K" 等
  references: ReferenceItem[];   // 复用 shared/messages.ts 的 ReferenceItem
}

// provider-specific model descriptor
export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  displayName: string;
  description?: string;
  paramConstraints: ModelParamConstraints;
  capabilities: VideoGenCapability[];
}

// 通用参数约束
export interface ModelParamConstraints {
  resolutions: string[];
  durations: number[];
  /** 模型支持的画面比例集（含 "adaptive" 表示文生视频场景也可选） */
  ratios: string[];
  /** 仅参考模式可选 ratio=adaptive（已废弃，留作兼容：等价于 ratios 包含 "adaptive"） */
  ratioAdaptiveAllowed: boolean;
  /**
   * 服务端声明的默认分辨率档位（可选）。
   *
   * 只有可灵图片用得到 —— 它的 img_resolution 默认是 "2k"，
   * 切换平台时按它初始化，比退到值域首项（"1k"）更贴合服务端意图。
   */
  defaultResolution?: string;
  /** 服务端声明的默认宽高比（可选，同上） */
  defaultRatio?: string;
}

// 能力位
export type VideoGenCapability =
  | "videoGeneration"
  | "imageGeneration"
  | "promptOptimization"
  | "resolutionUpscale"
  | "imageReference"
  | "videoReference"
  | "audioReference";

// 图片生成创建请求（provider 内部映射到各自 wire format；含"智能路由"依据 references）
export interface ImageGenCreateRequest {
  model: string;                 // provider-specific model id，如 "seedream-v5-pro"
  prompt: string;
  ratio: string;                 // "1:1" | "16:9" 等（仅展示/记录用；像素由 width/height 决定）
  /** 输出像素宽（Int）；智能档 = 活动序列分辨率，预设档 = ratioToSize 映射 */
  width: number;
  /** 输出像素高（Int） */
  height: number;
  /** 输出格式："jpeg" | "png" */
  outputFormat: string;
  /**
   * provider 原生的分辨率档位（可选）。
   *
   * 可灵图片用服务端声明的 img_resolution（"1k"/"2k"/"4k"），与 width/height
   * 像素语义不同 —— 有了这个字段，provider 不必从像素反推档位。
   * 其余 provider 不需要这个字段（width/height 已是权威）。
   */
  resolutionTier?: string;
  /** 张数（阶段 2A 固定 1；RunningHub 单次仅出 1 张） */
  count: number;
  references: ReferenceItem[];   // 有参考图 → image-to-image 路由；无 → text-to-image
  /**
   * 参考图内容（data:image/...;base64, 完整 data URI），图生图直传用。
   * RunningHub 对外链 / 纯文件名引用校验不稳（1007: 无法识别图片），
   * Base64 data URI 是官方支持的直传形式，优先于 references 的 fileId 引用。
   */
  referencesDataUris?: string[];
}

// provider 操作结果（最小集，provider 内部可扩展）
export interface VideoGenCreateResponse {
  taskId: string;
  /**
   * 本次实扣的灵感值（仅可灵有）。
   * 可灵在**提交时即扣费**，该值随 generationId 一起返回，是真实扣费额，
   * 不是本地价格表推算的估算值 —— 上报时独立成列，绝不折算成人民币。
   */
  creditsConsumed?: number;
  raw?: unknown;  // 透传原始响应，便于 UI 提取额外字段
}

export interface VideoGenQueryResponse {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  content?: { url?: string; prompt?: string };
  error?: { message: string; httpCode?: number };
  usage?: Record<string, unknown>;
  raw?: unknown;
}

export interface VideoGenErrorParsed {
  type?: string;
  message?: string;
  httpCode?: string | number;
  requestId?: string;
}