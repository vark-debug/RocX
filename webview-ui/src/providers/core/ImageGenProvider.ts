/**
 * ImageGenProvider 接口：图片生成后端实现自包含 URL / wire format / 鉴权 / 错误映射。
 *
 * 「智能路由」约定：是否走 image-to-image 由 provider 实现内部依据
 * createImage(req) 中 req.references 是否为空决定（部分 API 如 RunningHub
 * 没有服务端智能路由，文生图/图生图是不同 endpoint）。
 */
import type {
  ImageGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenErrorParsed,
} from "./types";
import type { ModelDescriptor } from "./types";

export interface ImageGenProvider {
  /** provider 唯一 id，如 "runninghub" */
  readonly providerId: string;

  /** provider 展示名 */
  readonly displayName: string;

  /** 此 provider 提供的图片模型列表（capabilities 需含 "imageGeneration"） */
  readonly models: ModelDescriptor[];

  /**
   * 同步生成型 provider（如 Ark：createImage 内部直接等待出图，无 taskId/轮询）。
   * 为 true 时提交记录直接进入 generating 状态（展示伪计时），跳过 pending(排队) 阶段。
   */
  readonly syncGeneration?: boolean;

  /** 生成鉴权头 */
  buildAuthHeaders(apiKey: string): Record<string, string>;

  /**
   * 提交图片生成任务，返回 taskId。
   * 实现内部按 references 有无路由到 text-to-image / image-to-image。
   */
  createImage(req: ImageGenCreateRequest, apiKey: string): Promise<VideoGenCreateResponse>;

  /** 查询任务状态（复用 VideoGenQueryResponse：succeeded 时 content.url 为产物地址） */
  queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse>;

  /** 解析错误响应（fetch 返回 !ok 时调用） */
  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed;

  /** 错误码 → UI 友好消息（含 provider 私有错误码） */
  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string;
}
