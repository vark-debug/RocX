/**
 * Ark（火山方舟）provider：实现 ImageGenProvider
 *
 * 同步 API 适配（关键差异）：Ark /images/generations 一次请求直接返回结果
 * （实测 55~80s，无 taskId / 无轮询）。为复用现有记录 + 轮询链路：
 * - createImage 同步等待结果，把产物 URL 存入模块级 Map，返回合成伪 taskId
 * - queryTask 查 Map 立即返回 succeeded(content.url)
 *
 * 智能路由（provider 内部，透明通道必须图生图达成）：
 * - referencesDataUris 非空 → image: dataUris，不传 background（用户有参考图 = 非透明）
 * - 为空 + prompt 命中透明关键词 → 自动补透明画布 data URI + background: "transparent"
 * - 为空 + 未命中 → 纯文生图（不传 image / background，正常非透明结果）
 *
 * wire format：
 * - create: POST { model, prompt, size: "WxH", response_format, output_format,
 *   watermark: false, image?, background? }
 *   → { data: [{ url | b64_json, size }], usage }
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
import { parseArkError, friendlyArkError } from "./errorMap";
import {
  ARK_IMAGE_GENERATE_URL,
  arkSizeOf,
  clampToArkMin,
  hasTransparentIntent,
  makeTransparentCanvasDataUri,
} from "./wireFormat";

export const ARK_MODEL_LIST: ModelDescriptor[] = [
  {
    providerId: "ark",
    modelId: "doubao-seedream-5-0-pro-260628",
    displayName: "Seedream 5.0 Pro (火山方舟)",
    description: "火山方舟 Seedream 5.0 Pro，支持透明底（提示词含透明关键词自动生效）",
    paramConstraints: {
      resolutions: ["1K", "2K"],
      durations: [],
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      ratioAdaptiveAllowed: false,
    },
    capabilities: ["imageGeneration"],
  },
];

/** 伪 taskId → 结果 URL（同步 API 适配轮询链路；webview 重载会丢失，见 queryTask 兜底） */
const resultUrls = new Map<string, string>();

export class ArkProvider implements ImageGenProvider {
  readonly providerId = "ark";
  readonly displayName = "火山方舟";
  readonly models = ARK_MODEL_LIST;
  /** 同步 API：createImage 内部直接等待出图，提交记录跳过 pending 直接展示生成中伪计时 */
  readonly syncGeneration = true;

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed {
    return parseArkError(rawText, httpStatus);
  }

  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string {
    return friendlyArkError(parsed, httpStatus);
  }

  async createImage(
    req: ImageGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    const model = this.models.find((m) => m.modelId === req.model);
    if (!model || !model.capabilities.includes("imageGeneration")) {
      throw new VideoGenError(`未知图片模型: ${req.model}`, {
        errorType: "unknown_model",
        providerId: this.providerId,
      });
    }

    // 智能路由：refs → 普通图生图；无 refs + 透明关键词 → 自动补透明画布；
    // 都没有 → 纯文生图（透明通道必须图生图达成，纯文生图无法出透明背景）
    const dataUris = req.referencesDataUris ?? [];
    const hasReferences = dataUris.length > 0;
    const transparentIntent = !hasReferences && hasTransparentIntent(req.prompt);
    const image = hasReferences
      ? dataUris
      : transparentIntent
        ? [makeTransparentCanvasDataUri(req.width, req.height)]
        : undefined;
    // 仅透明画布路由传 background=transparent；refs 路由视为非透明，不传
    const backgroundParam = transparentIntent ? "transparent" : undefined;

    // 输出格式：透明底强制 png（jpeg 无 alpha）；其余沿用上层（当前固定 png）
    const outputFormat = transparentIntent ? "png" : req.outputFormat;

    // 尺寸钳制：低于 Ark 最小像素（1MP）时等比放大（智能档小序列场景）
    const clamped = clampToArkMin(req.width, req.height);

    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      size: arkSizeOf(clamped.width, clamped.height),
      response_format: "url",
      output_format: outputFormat,
      watermark: false,
      ...(image ? { image } : {}),
      ...(backgroundParam ? { background: backgroundParam } : {}),
    };

    // 日志截断 base64 内容，避免刷爆控制台
    const bodyPreview = JSON.stringify(body, (_k, v) =>
      typeof v === "string" && v.startsWith("data:")
        ? `${v.slice(0, 48)}...<base64 ${v.length} chars>`
        : v,
    );
    console.log(
      "%c[Ark createImage]",
      "color:#e65100;font-weight:bold",
      "\nURL:", ARK_IMAGE_GENERATE_URL,
      "\nRoute:", hasReferences
        ? "image-to-image (refs, 非透明)"
        : transparentIntent
          ? "image-to-image (自动透明画布 + background=transparent)"
          : "text-to-image",
      clamped.scaled
        ? `\n尺寸放大: ${req.width}x${req.height} → ${clamped.width}x${clamped.height} (低于 Ark 最小像素)`
        : "",
      "\nBody:", bodyPreview,
    );

    let r: Response;
    try {
      // 同步 API：一次请求挂起至生成完成（实测 55~80s）
      r = await fetch(ARK_IMAGE_GENERATE_URL, {
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
      data?: Array<{ url?: string; b64_json?: string; size?: string }>;
      usage?: Record<string, unknown>;
    };
    const url = j.data && j.data.length > 0 ? j.data[0]?.url : undefined;
    if (!url) {
      throw new VideoGenError("火山方舟返回成功但缺少图片地址(data[0].url 为空)", {
        errorType: "missing_result_url",
        providerId: this.providerId,
      });
    }

    // 合成伪 taskId 存入内存 Map，供 queryTask 立即取回
    const taskId = `ark-${crypto.randomUUID()}`;
    resultUrls.set(taskId, url);
    return { taskId, raw: j };
  }

  async queryTask(
    taskId: string,
    _apiKey: string,
  ): Promise<VideoGenQueryResponse> {
    const url = resultUrls.get(taskId);
    if (url) {
      // 取出后即删除：终态只需返回一次，避免 Map 无限增长
      resultUrls.delete(taskId);
      return { status: "succeeded", content: { url } };
    }
    // Map 丢失 = 提交后 webview 被重载（极小窗口）；结果已无法找回，明确标失败
    return {
      status: "failed",
      error: { message: "任务结果已丢失（提交后页面被重载），请重新生成" },
    };
  }
}
