/**
 * Ark（火山方舟）错误解析与友好文案
 * 错误响应形如 { error: { code, message } }（HTTP 非 2xx）
 */
import type { VideoGenErrorParsed } from "../core/types";

export function parseArkError(
  rawText: string,
  httpStatus: number,
): VideoGenErrorParsed {
  try {
    const j = JSON.parse(rawText) as {
      error?: { code?: string | number; message?: string };
      message?: string;
    };
    return {
      type: j.error?.code != null ? String(j.error.code) : undefined,
      message: j.error?.message || j.message,
      httpCode: httpStatus,
    };
  } catch {
    return { message: rawText.slice(0, 200), httpCode: httpStatus };
  }
}

export function friendlyArkError(
  parsed: VideoGenErrorParsed,
  httpStatus: number,
): string {
  if (httpStatus === 401) {
    return "火山方舟 API Key 无效，请在设置里检查";
  }
  if (httpStatus === 403) {
    return "火山方舟 API Key 无权限，请在控制台确认已开通模型调用";
  }
  if (httpStatus === 404) {
    // 典型：InvalidEndpointOrModel.NotFound（模型未开通 / ID 错误）
    return "火山方舟模型不存在或未开通访问权限，请在方舟控制台开通后重试";
  }
  if (httpStatus === 429) {
    return "火山方舟请求限流，请稍后重试";
  }
  const code = parsed.type;
  if (code) {
    return `火山方舟错误(${code}): ${parsed.message || "未知错误"}`;
  }
  return `火山方舟请求失败(${httpStatus}): ${parsed.message || "未知错误"}`;
}
