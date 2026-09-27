/**
 * VideoGenProvider 接口：每个后端实现自包含 URL / wire format / 鉴权 / 错误映射
 */
import type {
  ModelDescriptor,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenCapability,
  VideoGenErrorParsed,
} from "./types";
import type { ReferenceItem } from "@shared/messages";

export interface VideoGenProvider {
  /** provider 唯一 id，如 "minimax" / "kling" */
  readonly providerId: string;

  /** provider 展示名 */
  readonly displayName: string;

  /** 此 provider 提供的模型列表（含 capability） */
  readonly models: ModelDescriptor[];

  /** 生成鉴权头（webview 端只用于直接 fetch 时） */
  buildAuthHeaders(apiKey: string): Record<string, string>;

  /** 提交生成任务，返回 taskId */
  createVideo(req: VideoGenCreateRequest, apiKey: string): Promise<VideoGenCreateResponse>;

  /** 查询任务状态 */
  queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse>;

  /** 解析错误响应（fetch 返回 !ok 时调用） */
  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed;

  /** 错误码 → UI 友好消息（含 provider 私有错误码） */
  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string;

  /** 可选：分辨率升级（如 MiniMax video_regeneration 768P → 2K） */
  regenerateVideo?(args: {
    sourceTaskId: string;
    resolution: string;
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse>;

  /** 可选：提示词优化（如 MiniMax h3_context_ir） */
  submitOptimizePrompt?(args: {
    prompt: string;
    duration: number;
    ratio: string;
    references: ReferenceItem[] | undefined;
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse>;
}

/** Provider 自身支持的 capability 集合（聚合自 models） */
export function providerCapabilities(p: VideoGenProvider): Set<VideoGenCapability> {
  const set = new Set<VideoGenCapability>();
  for (const m of p.models) for (const c of m.capabilities) set.add(c);
  return set;
}