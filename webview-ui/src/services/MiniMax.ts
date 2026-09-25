/**
 * Webview 端 → MiniMax API（向后兼容 shim）
 *
 * 实际实现已迁至 `providers/minimax/` 目录下的 `MiniMaxProvider`。
 * 本文件保留 `MiniMaxAPI` 类以兼容现有 import。
 */
import { minimaxProvider } from "../providers/minimax";
import { VideoGenError } from "../providers/core/errors";
import type {
  VideoGenCreateResponse,
  VideoGenQueryResponse,
} from "../providers/core/types";
import type {
  MiniMaxCreateRequest,
  MiniMaxCreateResponse,
  MiniMaxModel,
  MiniMaxQueryResponse,
  MiniMaxRatio,
  MiniMaxResolution,
  ReferenceItem,
} from "@shared/messages";

/** 兼容旧版 MiniMaxError：保留类名以兼容 main-webview 中的 `instanceof MiniMaxError` 检查 */
export class MiniMaxError extends VideoGenError {
  constructor(
    message: string,
    opts: { httpStatus?: number; errorType?: string; requestId?: string } = {},
  ) {
    super(message, opts);
    this.name = "MiniMaxError";
  }
}

/**
 * 向后兼容 MiniMaxAPI：内部委托给 MiniMaxProvider。
 * 公开方法签名必须保持不变。
 */
export class MiniMaxAPI {
  constructor(private apiKey: string) {}

  /**
   * 调试模式：仅打印 payload，不实际发送。
   * 新架构下 MiniMaxProvider 不再暴露 buildCreatePayload，
   * dry-run 退化为"不发请求"，返回 mock task_id（main-webview 中 __ROCX_DRY_RUN__ 默认 false）。
   */
  async createVideoDryRun(_req: MiniMaxCreateRequest): Promise<{
    task_id: string;
    payload: null;
  }> {
    console.log(
      "%c[MiniMax createVideo DRY-RUN]",
      "color:#4b9cf5;font-weight:bold",
      "(shim：dry-run 在新 provider 架构下不再构建真实 payload；返回 mock task_id)",
    );
    return {
      task_id: `dryrun_${Date.now()}`,
      payload: null,
    };
  }

  async createVideo(req: MiniMaxCreateRequest): Promise<MiniMaxCreateResponse> {
    const r: VideoGenCreateResponse = await minimaxProvider.createVideo(
      {
        model: req.model,
        prompt: req.prompt,
        ratio: req.ratio,
        duration: req.duration,
        resolution: req.resolution,
        references: req.references,
      },
      this.apiKey,
    );
    return { task_id: r.taskId };
  }

  async queryTask(taskId: string): Promise<MiniMaxQueryResponse> {
    const r: VideoGenQueryResponse = await minimaxProvider.queryTask(
      taskId,
      this.apiKey,
    );
    return r as MiniMaxQueryResponse;
  }

  async regenerateVideo(args: {
    sourceTaskId: string;
    resolution: MiniMaxResolution;
    model?: MiniMaxModel;
  }): Promise<MiniMaxCreateResponse> {
    const r: VideoGenCreateResponse = await minimaxProvider.regenerateVideo!({
      sourceTaskId: args.sourceTaskId,
      resolution: args.resolution,
      model: args.model,
      apiKey: this.apiKey,
    });
    return { task_id: r.taskId };
  }

  async submitOptimizePrompt(args: {
    prompt: string;
    duration: number;
    ratio: MiniMaxRatio;
    references: ReferenceItem[];
    model?: MiniMaxModel;
  }): Promise<MiniMaxCreateResponse> {
    const r: VideoGenCreateResponse = await minimaxProvider.submitOptimizePrompt!({
      prompt: args.prompt,
      duration: args.duration,
      ratio: args.ratio,
      references: args.references,
      model: args.model,
      apiKey: this.apiKey,
    });
    return { task_id: r.taskId };
  }
}