/**
 * MiniMax 错误解析 + UI 友好消息
 */
import type { VideoGenErrorParsed } from "../core/types";

export function parseMiniMaxError(raw: string): VideoGenErrorParsed | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.error) {
      return {
        type: j.error.type,
        message: j.error.message,
        httpCode: j.error.http_code,
        requestId: j.request_id,
      };
    }
  } catch {
    // 不是 JSON，原样返回
  }
  return null;
}

export function friendlyMiniMaxError(
  parsed: VideoGenErrorParsed | null,
  httpStatus: number,
): string {
  const t = parsed?.type;
  if (httpStatus === 402 || t === "insufficient_balance_error") {
    return "余额不足（402）— 请前往 MiniMax 用户中心充值后重试";
  }
  if (httpStatus === 401 || t === "authorized_error") {
    return "鉴权失败（401）— API Key 无效或不正确";
  }
  if (httpStatus === 429 || t === "rate_limit_error") {
    return "触发限流（429）— 请稍后再试";
  }
  if (httpStatus === 422 || t === "unprocessable_entity_error") {
    return "输入涉及敏感内容（422）— 请修改提示词";
  }
  if (httpStatus === 400 || t === "bad_request_error") {
    return `参数错误（400）— ${parsed?.message || "请检查请求参数"}`;
  }
  if (httpStatus === 500 || t === "server_error") {
    return `服务端错误（500）— ${parsed?.message || "请稍后再试"}`;
  }
  if (parsed?.message) {
    return `MiniMax 创建任务失败（${httpStatus}）：${parsed.message}`;
  }
  return `MiniMax 创建任务失败（${httpStatus}）`;
}