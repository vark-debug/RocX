/**
 * MiniMax provider：实现 VideoGenProvider
 */
import type {
  VideoGenProvider,
} from "../core/VideoGenProvider";
import type {
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenErrorParsed,
} from "../core/types";
import type { ModelDescriptor, VideoParamConstraints, VideoModel, VideoResolution } from "@shared/messages";
import { VIDEO_PARAM_CONSTRAINTS } from "@shared/messages";
import { VideoGenError } from "../core/errors";
import { buildContent, warnIfContainsBase64 } from "./wireFormat";
import { parseMiniMaxError, friendlyMiniMaxError } from "./errorMap";

const CREATE_URL = "https://api.minimax.cn/v2/video_generation";
const QUERY_BASE = "https://api.minimax.cn/v2/query/video_generation";
const REGENERATE_URL = "https://api.minimax.cn/v2/video_regeneration";
const H3_CONTEXT_IR_URL = "https://api.minimax.cn/v2/h3_context_ir";

export const MINIMAX_MODEL_LIST: ModelDescriptor[] = [
  {
    providerId: "minimax",
    modelId: "MiniMax-H3",
    displayName: "H3 标准",
    description: "MiniMax H3 标准模型，支持多档分辨率与时长",
    paramConstraints: VIDEO_PARAM_CONSTRAINTS["MiniMax-H3"],
    capabilities: [
      "videoGeneration",
      "imageReference",
      "videoReference",
      "audioReference",
      "resolutionUpscale",   // 视频_regeneration 仅 H3 支持
      "promptOptimization",  // h3_context_ir 仅 H3 支持
    ],
  },
  {
    providerId: "minimax",
    modelId: "MiniMax-H3-Max",
    displayName: "H3-Max 极速",
    description: "MiniMax H3 极速模型，480P/768P",
    paramConstraints: VIDEO_PARAM_CONSTRAINTS["MiniMax-H3-Max"],
    capabilities: [
      "videoGeneration",
      "imageReference",
      "videoReference",
      "audioReference",
    ],
  },
];

export class MiniMaxProvider implements VideoGenProvider {
  readonly providerId = "minimax";
  readonly displayName = "MiniMax（海螺 AI）";
  readonly models = MINIMAX_MODEL_LIST;

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  parseError(rawText: string, _httpStatus: number): VideoGenErrorParsed {
    return parseMiniMaxError(rawText) || {};
  }

  friendlyErrorMessage(
    parsed: VideoGenErrorParsed,
    httpStatus: number,
  ): string {
    return friendlyMiniMaxError(parsed, httpStatus);
  }

  async createVideo(
    req: VideoGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    const content = buildContent(req.prompt, req.references);
    const body: any = {
      model: req.model,
      content,
      resolution: req.resolution,
      duration: req.duration,
    };
    if (req.references.length === 0) {
      body.ratio = req.ratio === "adaptive" ? "16:9" : req.ratio;
    } else {
      body.ratio = req.ratio;
    }
    const bodyString = JSON.stringify(body, null, 2);
    warnIfContainsBase64(bodyString, "createVideo");

    console.log(
      "%c[MiniMax createVideo]",
      "color:#5cb85c;font-weight:bold",
      "\nURL:", CREATE_URL,
      "\nHeaders:", JSON.stringify(this.buildAuthHeaders(apiKey), null, 2),
      "\nBody:", bodyString,
    );

    let r: Response;
    try {
      r = await fetch(CREATE_URL, {
        method: "POST",
        headers: this.buildAuthHeaders(apiKey),
        body: bodyString,
      });
    } catch (e: any) {
      throw new VideoGenError(
        "网络错误: " + String(e?.message || e),
        { httpStatus: 0, errorType: "network_error", providerId: this.providerId },
      );
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = this.parseError(t, r.status);
      const msg = this.friendlyErrorMessage(parsed, r.status);
      throw new VideoGenError(msg, {
        httpStatus: r.status,
        errorType: parsed.type || "http_error",
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = (await r.json()) as {
      task_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 响应缺少 task_id", {
        errorType: "missing_task_id",
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }

  async queryTask(
    taskId: string,
    apiKey: string,
  ): Promise<VideoGenQueryResponse> {
    const r = await fetch(`${QUERY_BASE}/${taskId}`, {
      method: "GET",
      headers: this.buildAuthHeaders(apiKey),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new VideoGenError(
        `MiniMax 查询失败 (${r.status}): ${t.slice(0, 200)}`,
        { httpStatus: r.status, errorType: "http_error", providerId: this.providerId },
      );
    }
    const j = (await r.json()) as {
      task?: any;
      request_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    // 官方响应：{ task: { id, status, content: { url }, ... }, request_id, base_resp }
    const task = j.task || j;
    return {
      status: task.status,
      content: task.content,
      error: task.error,
      usage: task.usage,
      raw: j,
    };
  }

  async regenerateVideo(args: {
    sourceTaskId: string;
    resolution: string;
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse> {
    const model = args.model || "MiniMax-H3";
    const body = {
      model,
      source_task_id: args.sourceTaskId,
      resolution: args.resolution,
    };
    console.log(
      "%c[MiniMax regenerateVideo]",
      "color:#ffa500;font-weight:bold",
      "\nURL:", REGENERATE_URL,
      "\nBody:", JSON.stringify(body, null, 2),
    );
    let r: Response;
    try {
      r = await fetch(REGENERATE_URL, {
        method: "POST",
        headers: this.buildAuthHeaders(args.apiKey),
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new VideoGenError(
        "网络错误: " + String(e?.message || e),
        { httpStatus: 0, errorType: "network_error", providerId: this.providerId },
      );
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = this.parseError(t, r.status);
      throw new VideoGenError(this.friendlyErrorMessage(parsed, r.status), {
        httpStatus: r.status,
        errorType: parsed.type || "http_error",
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = (await r.json()) as { task_id?: string };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 像素提升响应缺少 task_id", {
        errorType: "missing_task_id",
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }

  async submitOptimizePrompt(args: {
    prompt: string;
    duration: number;
    ratio: string;
    references?: import("@shared/messages").ReferenceItem[];
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse> {
    const model = args.model || "MiniMax-H3";
    const refs = args.references || [];
    const content = buildContent(args.prompt, refs);
    const body: any = {
      model,
      content,
      duration: args.duration,
      ratio: args.ratio,
    };
    const bodyString = JSON.stringify(body, null, 2);
    warnIfContainsBase64(bodyString, "submitOptimizePrompt");

    let r: Response;
    try {
      r = await fetch(H3_CONTEXT_IR_URL, {
        method: "POST",
        headers: this.buildAuthHeaders(args.apiKey),
        body: bodyString,
      });
    } catch (e: any) {
      throw new VideoGenError(
        "网络错误: " + String(e?.message || e),
        { httpStatus: 0, errorType: "network_error", providerId: this.providerId },
      );
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = this.parseError(t, r.status);
      throw new VideoGenError(this.friendlyErrorMessage(parsed, r.status), {
        httpStatus: r.status,
        errorType: parsed.type || "http_error",
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = (await r.json()) as {
      task_id?: string;
      request_id?: string;
    };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 提示词优化响应缺少 task_id", {
        errorType: "missing_task_id",
        requestId: j.request_id,
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }
}