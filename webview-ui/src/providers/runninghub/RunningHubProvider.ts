/**
 * RunningHub provider：实现 ImageGenProvider
 *
 * 智能路由（provider 内部，因 API 无服务端路由）：
 * - references 为空 → /seedream-v5-pro/text-to-image（文生图）
 * - referencesDataUris 非空 → /seedream-v5-pro/image-to-image（imageUrls 必填，
 *   元素为 Base64 data URI；外链 download_url / 纯文件名引用均报 1007，实测弃用）
 *
 * wire format（官方示例）：
 * - create: POST { prompt, width, height, outputFormat: "jpeg" }（width/height 为
 *   Int 直传，不再传 resolution 枚举）
 *   → { taskId, status: "RUNNING", ... }
 * - query:  POST { taskId } → { status: "SUCCESS"|"RUNNING"|"QUEUED"|"FAILED",
 *   results: [{ url, nodeId, outputType }], errorMessage, ... }
 */
import type { ImageGenProvider } from "../core/ImageGenProvider";
import type {
  ImageGenCreateRequest,
  ModelDescriptor,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenErrorParsed,
} from "../core/types";
import { VideoGenError } from "../core/errors";
import { parseRunningHubError, friendlyRunningHubError } from "./errorMap";

const TEXT_TO_IMAGE_URL =
  "https://www.runninghub.cn/openapi/v2/seedream-v5-pro/text-to-image";
const IMAGE_TO_IMAGE_URL =
  "https://www.runninghub.cn/openapi/v2/seedream-v5-pro/image-to-image";
const QUERY_URL = "https://www.runninghub.cn/openapi/v2/query";

export const RUNNINGHUB_MODEL_LIST: ModelDescriptor[] = [
  {
    providerId: "runninghub",
    modelId: "seedream-v5-pro",
    displayName: "Seedream V5 Pro",
    description: "RunningHub Seedream V5 Pro 文生图，单次 1 张，最高 2K",
    paramConstraints: {
      resolutions: ["1K", "2K"],
      durations: [],
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      ratioAdaptiveAllowed: false,
    },
    capabilities: ["imageGeneration"],
  },
];

export class RunningHubProvider implements ImageGenProvider {
  readonly providerId = "runninghub";
  readonly displayName = "RunningHub";
  readonly models = RUNNINGHUB_MODEL_LIST;

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed {
    return parseRunningHubError(rawText, httpStatus);
  }

  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string {
    return friendlyRunningHubError(parsed, httpStatus);
  }

  async createImage(
    req: ImageGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    // 智能路由：有参考图 data URI → image-to-image（imageUrls 必填字段，
    // 元素为 Base64 data URI 直传；外链/纯文件名引用会报 1007 无法识别）；无 → text-to-image
    const dataUris = req.referencesDataUris ?? [];
    const hasReferences = dataUris.length > 0;
    const endpoint = hasReferences ? IMAGE_TO_IMAGE_URL : TEXT_TO_IMAGE_URL;

    const model = this.models.find((m) => m.modelId === req.model);
    if (!model || !model.capabilities.includes("imageGeneration")) {
      throw new VideoGenError(`未知图片模型: ${req.model}`, {
        errorType: "unknown_model",
        providerId: this.providerId,
      });
    }

    // width/height 由上层算好直传（智能档=序列分辨率 / 预设档=ratioToSize）；
    // 单次仅 1 张（count>1 由上层拆多任务，当前 UI 固定 1）
    const body = {
      prompt: req.prompt,
      width: Math.round(req.width),
      height: Math.round(req.height),
      outputFormat: req.outputFormat,
      ...(hasReferences ? { imageUrls: dataUris } : {}),
    };

    // 日志截断 base64 内容，避免刷爆控制台
    const bodyPreview = JSON.stringify(body, (_k, v) =>
      typeof v === "string" && v.startsWith("data:")
        ? `${v.slice(0, 48)}...<base64 ${v.length} chars>`
        : v,
    );
    console.log(
      "%c[RunningHub createImage]",
      "color:#5cb85c;font-weight:bold",
      "\nURL:", endpoint,
      "\nRoute:", hasReferences ? "image-to-image (base64)" : "text-to-image",
      "\nBody:", bodyPreview,
    );

    let r: Response;
    try {
      r = await fetch(endpoint, {
        method: "POST",
        headers: this.buildAuthHeaders(apiKey),
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new VideoGenError("网络错误: " + String(e?.message || e), {
        httpStatus: 0,
        errorType: "network_error",
        providerId: this.providerId,
      });
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = this.parseError(t, r.status);
      throw new VideoGenError(this.friendlyErrorMessage(parsed, r.status), {
        httpStatus: r.status,
        errorType: parsed.type || "http_error",
        providerId: this.providerId,
      });
    }
    const j = (await r.json()) as {
      taskId?: string;
      errorCode?: string | number;
      errorMessage?: string;
    };
    // RunningHub 提交失败也可能 HTTP 200（errorCode 非空）
    if (!j.taskId) {
      const parsed: VideoGenErrorParsed = {
        type: j.errorCode ? String(j.errorCode) : undefined,
        message: j.errorMessage,
        httpCode: r.status,
      };
      throw new VideoGenError(
        this.friendlyErrorMessage(parsed, r.status),
        { errorType: "missing_task_id", providerId: this.providerId },
      );
    }
    return { taskId: j.taskId, raw: j };
  }

  async queryTask(
    taskId: string,
    apiKey: string,
  ): Promise<VideoGenQueryResponse> {
    const r = await fetch(QUERY_URL, {
      method: "POST",
      headers: this.buildAuthHeaders(apiKey),
      body: JSON.stringify({ taskId }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new VideoGenError(
        `RunningHub 查询失败 (${r.status}): ${t.slice(0, 200)}`,
        { httpStatus: r.status, errorType: "http_error", providerId: this.providerId },
      );
    }
    const j = (await r.json()) as {
      taskId?: string;
      status?: string;
      errorMessage?: string;
      failedReason?: Record<string, unknown> | null;
      usage?: Record<string, unknown>;
      results?: Array<{ url?: string; nodeId?: string; outputType?: string }> | null;
    };
    const url = j.results && j.results.length > 0 ? j.results[0]?.url : undefined;
    return {
      status: mapStatus(j.status),
      content: url ? { url } : undefined,
      error:
        j.status === "FAILED" || j.status === "CANCELLED"
          ? { message: j.errorMessage || "任务失败" }
          : undefined,
      usage: j.usage,
      raw: j,
    };
  }
}

/** RunningHub 状态 → 中性状态 */
function mapStatus(s?: string): VideoGenQueryResponse["status"] {
  switch (s) {
    case "SUCCESS":
      return "succeeded";
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      // 未知状态按失败处理，避免无限轮询
      return "failed";
  }
}
