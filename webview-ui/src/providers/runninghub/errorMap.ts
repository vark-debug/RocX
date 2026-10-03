/**
 * RunningHub 错误解析与友好文案
 * 错误响应形如 { errorCode, errorMessage }（HTTP 非 2xx 或业务失败）
 */
import type { VideoGenErrorParsed } from "../core/types";

export function parseRunningHubError(
  rawText: string,
  httpStatus: number,
): VideoGenErrorParsed {
  try {
    const j = JSON.parse(rawText) as {
      errorCode?: string | number;
      errorMessage?: string;
      message?: string;
    };
    return {
      type: j.errorCode ? String(j.errorCode) : undefined,
      message: j.errorMessage || j.message,
      httpCode: httpStatus,
    };
  } catch {
    return { message: rawText.slice(0, 200), httpCode: httpStatus };
  }
}

export function friendlyRunningHubError(
  parsed: VideoGenErrorParsed,
  httpStatus: number,
): string {
  if (httpStatus === 401 || httpStatus === 403) {
    return "RunningHub API Key 无效或无权限，请在设置里检查";
  }
  const code = parsed.type;
  if (code) {
    return `RunningHub 错误(${code}): ${parsed.message || "未知错误"}`;
  }
  return `RunningHub 请求失败(${httpStatus}): ${parsed.message || "未知错误"}`;
}
