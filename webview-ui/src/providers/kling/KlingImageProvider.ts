/**
 * 可灵图片 provider：实现 ImageGenProvider（经 C++ Hybrid addon 调本机 kling CLI）
 *
 * 与可灵视频 provider（KlingProvider）同源，差异只在工具与参数：
 * - 工具：`text_to_image`（文生图）/ `image_to_image`（图生图）
 * - 分辨率参数名 `img_resolution`（"1k"/"2k"/"4k"），**不是**视频侧的 `resolution`
 * - 有 `imageCount`（张数 1~9），无 duration
 *
 * 与其余三个图片 provider（RunningHub / 火山方舟）的根本差异：
 * 1. 鉴权走 CLI 的浏览器 OAuth，**没有 API Key 槽位**
 * 2. 成本是**提交即扣**的实扣灵感值（creditsConsumed），不是本地价格表估算
 * 3. 素材走**本地路径 / CDN 直链**，不是 base64 data URI
 *    （CLI 的 resolveImageUrl 只认 http(s) 与本地文件，data URI 会被当成路径去上传而失败）
 * 4. 模型清单与视频侧共用同一份 `who_am_i` 响应（同一个 catalog）
 */
import { bridge } from "../../services/bridge";
import type { ImageGenProvider } from "../core/ImageGenProvider";
import type {
  ImageGenCreateRequest,
  ModelDescriptor,
  VideoGenCreateResponse,
  VideoGenQueryResponse,
  VideoGenErrorParsed,
} from "../core/types";
import { VideoGenError } from "../core/errors";
import type { ReferenceItem } from "@shared/messages";
import {
  KLING_PROVIDER_ID,
  KLING_TOOL_IMAGE_TO_IMAGE,
  KLING_TOOL_TEXT_TO_IMAGE,
  buildKlingImageArgs,
  buildKlingImageModelDescriptors,
  buildKlingQueryArgs,
  countKlingImageSlots,
  extractKlingCredits,
  extractKlingErrorMessage,
  extractKlingGenerationId,
  extractKlingImageResultUrl,
  findKlingModelSpec,
  mapKlingStatus,
  newKlingTraceId,
  pickKlingImageDefaultModel,
} from "./wireFormat";
import type { KlingModelCatalog } from "./wireFormat";
import {
  parseKlingError,
  friendlyKlingError,
  extractKlingRechargeUrl,
} from "./errorMap";
import { ensureKlingUrls, isKlingUrlExpired } from "./klingPreUpload";
import { klingEnv } from "./KlingProvider";
import { ensureKlingCatalog, getKlingCatalogSync } from "./KlingProvider";
import { klingImageModels } from "./imageState";

// ---------- 模块级响应式状态 ----------

/**
 * 可灵图片的默认模型 id（服务端 text_to_image.defaultModel）。
 *
 * 与视频侧的 getKlingDefaultModel 分开 —— 两者取的是不同工具的 defaultModel，
 * 混用会拿到视频模型 id。
 */
export function getKlingImageDefaultModel(): string {
  const catalog = getKlingCatalogSync();
  return catalog ? pickKlingImageDefaultModel(catalog) : "";
}

// ---------- 参考图来源 ----------

/**
 * 参考图来源：优先用预上传拿到的可灵 CDN 直链（过期则回退本地路径），
 * 其次公网 URL 直传（不下载重传），否则用本地绝对路径
 * （CLI 的 resolveImageUrl 会自动上传本地文件）。
 *
 * ⚠ **不能传 base64 data URI** —— CLI 只认 http(s) 与本地文件路径，
 *   data: URI 会被当成文件路径去上传，必然失败。
 */
function imageReferenceSource(ref: ReferenceItem): string {
  if (ref.klingFileUrl && !isKlingUrlExpired(ref.klingUploadedAt)) {
    return ref.klingFileUrl;
  }
  const id = typeof ref.fileId === "string" ? ref.fileId.trim() : "";
  if (/^https?:\/\//i.test(id)) return id;
  return ref.localPath;
}

// ---------- 分辨率档位映射 ----------

/**
 * 从 UI 的尺寸档位推出可灵的 img_resolution 值。
 *
 * UI 的档位是 "1K" / "2K"（大写），可灵要的是 "1k" / "2k" / "4k"（小写）。
 * UI 没有 4K 档（现有图片 provider 只到 2K），所以这里的映射是：
 * - "1K" → "1k"
 * - "2K" → "2k"
 * - 其它（含"智能"）→ 由 req.width/height 推算（见 klingResolutionFromPixels）
 */
function klingImageResolutionOf(req: ImageGenCreateRequest): string {
  const tier = (req as any).resolutionTier as string | undefined;
  if (tier) return tier.toLowerCase();
  return klingResolutionFromPixels(req.width, req.height);
}

/**
 * 由输出像素推算分辨率档位。
 *
 * 可灵的档位语义是「长边像素量级」：
 * - 1k → 长边约 1024
 * - 2k → 长边约 2048
 * - 4k → 长边约 4096
 *
 * 用长边而不是总像素：1:1 的 2k 图是 2048×2048（总像素 419 万），
 * 16:9 的 2k 图是 2048×1152（总像素 236 万）—— 总像素算不出稳定档位。
 */
export function klingResolutionFromPixels(width: number, height: number): string {
  const long = Math.max(width || 0, height || 0);
  if (long >= 3400) return "4k";
  if (long >= 1700) return "2k";
  return "1k";
}

// ---------- trace id ----------

const imageTraceIds = new Map<string, string>();

function registerKlingImageTraceId(taskId: string, traceId: string): void {
  imageTraceIds.set(taskId, traceId);
}

function klingImageTraceIdFor(taskId: string): string {
  let id = imageTraceIds.get(taskId);
  if (!id) {
    id = newKlingTraceId();
    imageTraceIds.set(taskId, id);
  }
  return id;
}

// ---------- Provider ----------

export class KlingImageProvider implements ImageGenProvider {
  readonly providerId = KLING_PROVIDER_ID;
  readonly displayName = "可灵（Kling CLI）";

  /** 模型清单来自服务端动态下发（who_am_i），加载前为空 */
  get models(): ModelDescriptor[] {
    return klingImageModels.value;
  }

  /**
   * 同步生成型 provider？
   *
   * ❌ 不是 —— 可灵图片是**异步**的：提交返回 generationId，
   *   需要轮询 query_tasks 才能拿到结果 URL（实测约 25s）。
   *   所以走标准 pending → generating → 终态的轮询链路。
   */
  readonly syncGeneration = false;

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
   * 提交图片生成。
   *
   * 按参考图有无路由：
   * - 有参考图 → `kling image_to_image --image …`
   * - 无参考图 → `kling text_to_image`
   *
   * ⚠ 素材**不是** base64 data URI —— CLI 只接受 http(s) URL 或本地路径。
   */
  async createImage(
    req: ImageGenCreateRequest,
    _apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    // 等抓素材时启动的预上传跑完，把 CDN 直链回填到 ref。
    // 直链就绪 → CLI 的 resolveImageUrl 直通不重传（省掉内部 4-8s 上传）；
    // 没就绪 → 保持本地路径，CLI 自行上传（与改造前一致）。
    await ensureKlingUrls(req.references ?? []);

    const catalog = await ensureKlingCatalog();

    const imageRefs = (req.references ?? []).filter(
      (r) => r.type === "reference_image",
    );

    const tool = imageRefs.length
      ? KLING_TOOL_IMAGE_TO_IMAGE
      : KLING_TOOL_TEXT_TO_IMAGE;

    const spec = findKlingModelSpec(catalog, tool, req.model);
    if (!spec) {
      // 该模型可能不支持图生图（image_to_image 清单里没有它）→ 明确告知
      if (tool === KLING_TOOL_IMAGE_TO_IMAGE) {
        throw new VideoGenError(
          `可灵模型 ${req.model} 不支持参考图，请换一个图片模型`,
          { errorType: "unsupported_reference", providerId: this.providerId },
        );
      }
      throw new VideoGenError(`可灵图片模型不可用：${req.model}`, {
        errorType: "unknown_model",
        providerId: this.providerId,
      });
    }

    const images: string[] = [];
    for (const ref of imageRefs) {
      const src = imageReferenceSource(ref);
      if (!src) {
        throw new VideoGenError("参考图缺少本地路径，无法提交", {
          errorType: "invalid_reference",
          providerId: this.providerId,
        });
      }
      images.push(src);
    }

    // 槽位数量预检（CLI 侧同样会校验，这里提前给出更直接的提示）
    if (images.length) {
      const cap = countKlingImageSlots(spec);
      if (images.length > cap) {
        throw new VideoGenError(
          `模型 ${spec.model} 最多支持 ${cap} 张参考图，当前 ${images.length} 张`,
          { errorType: "too_many_references", providerId: this.providerId },
        );
      }
      // image_to_image 的 image_1 是必填（v3_0_omni / o1 / v3_0）
      const requiredInputs = (spec.inputs ?? []).filter((i) => i.required).length;
      if (images.length < requiredInputs) {
        throw new VideoGenError(
          `模型 ${spec.model} 需要至少 ${requiredInputs} 张参考图`,
          { errorType: "missing_references", providerId: this.providerId },
        );
      }
    }

    const traceId = newKlingTraceId();
    const args = buildKlingImageArgs({
      tool,
      spec,
      prompt: req.prompt,
      // 分辨率档位：可灵用 img_resolution（"1k"/"2k"/"4k"），与 UI 的 "1K"/"2K" 大小写不同
      resolution: klingImageResolutionOf(req),
      ratio: req.ratio,
      count: req.count || 1,
      images,
      traceId,
    });

    console.log(
      "%c[Kling createImage]",
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
    // 登记 trace id：轮询时复用（同一次任务的所有 CLI 调用带同一个 trace）
    registerKlingImageTraceId(taskId, traceId);

    const creditsConsumed = extractKlingCredits(res.data);
    return { taskId, creditsConsumed, raw: res.data };
  }

  /** 轮询任务状态（`kling query_tasks <generationId>`） */
  async queryTask(
    taskId: string,
    _apiKey: string,
  ): Promise<VideoGenQueryResponse> {
    const traceId = klingImageTraceIdFor(taskId);
    const res = await bridge.klingCliExec(buildKlingQueryArgs(taskId, traceId), {
      timeoutMs: 60000,
    });
    if (!res.ok) throw cliFailure(res, this.providerId);

    const body = res.data as any;
    const status = mapKlingStatus(body?.status);
    const url = extractKlingImageResultUrl(body);
    const credits = extractKlingCredits(body);
    return {
      status,
      content: url ? { url } : undefined,
      error:
        status === "failed"
          ? { message: extractKlingErrorMessage(body) || "可灵图片任务失败" }
          : undefined,
      usage: credits !== undefined ? { credits_consumed: credits } : undefined,
      raw: body,
    };
  }
}

// ---------- 错误处理 ----------

/** UXP 端返回的失败 → VideoGenError */
function cliFailure(res: any, providerId: string): VideoGenError {
  const raw = res.error || res.raw || "";
  if (
    res.code === "cli_not_installed" ||
    res.code === "addon_unavailable" ||
    res.code === "not_logged_in"
  ) {
    return new VideoGenError(raw, { errorType: res.code, providerId });
  }
  const parsed = parseKlingError(raw, 0);
  if (parsed.type === "insufficient_credits") {
    // 余额不足：服务端在错误文本里带充值入口，记进环境状态供 UI 展示
    const url = extractKlingRechargeUrl(parsed.message || "");
    if (url) klingEnv.value = { ...klingEnv.value, rechargeUrl: url };
  }
  return new VideoGenError(friendlyKlingError(parsed, 0), {
    errorType: parsed.type || res.code,
    providerId,
  });
}
