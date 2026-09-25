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
}

// 能力位
export type VideoGenCapability =
  | "videoGeneration"
  | "promptOptimization"
  | "resolutionUpscale"
  | "imageReference"
  | "videoReference"
  | "audioReference";

// provider 操作结果（最小集，provider 内部可扩展）
export interface VideoGenCreateResponse {
  taskId: string;
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