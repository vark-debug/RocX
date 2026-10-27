/**
 * 可灵 CLI 错误解析与友好文案
 *
 * ⚠ 不臆造错误码：可灵 CLI 没有自己的错误码体系，错误一律以**文本**形式出现：
 *   - 客户端校验失败 → stderr 文本，exit 1，stdout 为空
 *     例："未知参数 --foo。模型 X 声明的生成参数：…" /
 *         "模型 \"X\" 不在 text_to_video 的可用列表内。可用：…" /
 *         "Invalid value 'abc' for argument 'duration'. Allowed values: 5, 10." /
 *         "模型 X 缺少必填输入：first_image。请对照 kling who_am_i 补齐。"
 *   - 服务端业务失败 → stdout 的 envelope `{ ok:false, status, body }`，
 *     body 可能是字符串（如 "Invalid generationId."）或对象
 *   - 鉴权失败 → stderr 文本含"未登录" / "unauthorized" 等
 *
 * 这里的分类只是**按文本特征归类**，用于 UI 分主题 + 给出可操作提示，
 * 不是服务端下发的错误码。
 */
import type { VideoGenErrorParsed } from "../core/types";

export type KlingErrorKind =
  | "not_logged_in"
  | "insufficient_credits"
  | "content_moderation"
  | "invalid_params"
  | "model_not_found"
  | "not_found"
  | "timeout"
  | "server_error"
  | "unknown";

/** 按实际错误文本归类 */
export function classifyKlingError(text: string): KlingErrorKind {
  const t = (text || "").toLowerCase();
  if (!t) return "unknown";

  // 鉴权：CLI 的 AuthError / 未登录提示
  if (
    t.includes("未登录") ||
    t.includes("请先登录") ||
    t.includes("not logged in") ||
    t.includes("unauthorized") ||
    t.includes("no valid login") ||
    t.includes("access_token") ||
    t.includes("autherror") ||
    t.includes("登录态")
  ) {
    return "not_logged_in";
  }

  // 灵感值不足（CLI 会带上服务端下发的充值链接）
  if (
    t.includes("灵感值不足") ||
    t.includes("灵感值不够") ||
    t.includes("余额不足") ||
    t.includes("insufficient") ||
    t.includes("not enough credit") ||
    t.includes("credits exhausted")
  ) {
    return "insufficient_credits";
  }

  // 内容审核
  if (
    t.includes("审核") ||
    t.includes("违规") ||
    t.includes("敏感") ||
    t.includes("moderation") ||
    t.includes("sensitive") ||
    t.includes("risk control")
  ) {
    return "content_moderation";
  }

  // 参数非法（客户端校验）
  if (
    t.includes("未知参数") ||
    t.includes("invalid value") ||
    t.includes("缺少必填输入") ||
    t.includes("不能为空") ||
    t.includes("必须") ||
    t.includes("validationerror") ||
    t.includes("must be") ||
    t.includes("required inputs")
  ) {
    return "invalid_params";
  }

  // 模型不在可用列表
  if (
    t.includes("不在") ||
    t.includes("可用列表") ||
    t.includes("not available") ||
    t.includes("unsupported model")
  ) {
    return "model_not_found";
  }

  // 任务不存在
  if (
    t.includes("invalid generationid") ||
    t.includes("not found") ||
    t.includes("does not exist") ||
    t.includes("已过期")
  ) {
    return "not_found";
  }

  // 超时
  if (t.includes("超时") || t.includes("timeout") || t.includes("timed out")) {
    return "timeout";
  }

  // 服务端异常
  if (
    t.includes("服务异常") ||
    t.includes("服务错误") ||
    t.includes("internal error") ||
    t.includes("service unavailable") ||
    t.includes("bad gateway") ||
    t.includes("gateway timeout")
  ) {
    return "server_error";
  }

  return "unknown";
}

/**
 * 从错误文本里抽出服务端下发的链接（如充值链接）。
 * 不硬编码 URL —— 可灵各区域 / 各活动的充值入口可能不同。
 */
export function extractKlingRechargeUrl(text: string): string | undefined {
  const m = (text || "").match(/https?:\/\/[^\s"'<>）)]+/);
  return m ? m[0] : undefined;
}

/**
 * CLI 的 usage 文本（客户端校验失败时打到 stderr 的帮助全文）。
 *
 * 可灵 CLI 在「prompt 为空」等客户端校验失败场景下，会把整段 usage 打到 stderr 并 exit 1。
 * 那段文本有 3000+ 字符，直接甩给用户毫无信息量 —— 这里识别出来，
 * 换成一句能指导下一步操作的中文提示。
 */
function isCliUsageText(text: string): boolean {
  return /^Usage:\s*kling\s+/i.test(text.trim());
}

/** usage 文本对应的中文提示 */
const CLI_USAGE_HINT =
  "可灵 CLI 未接受本次参数（提示词为空或参数格式不被识别）。请确认提示词非空后重试。";

/**
 * 解析错误文本 / envelope。
 * rawText 可能是纯文本（stderr），也可能是 envelope 的 JSON 字符串。
 */
export function parseKlingError(
  rawText: string,
  httpStatus: number,
): VideoGenErrorParsed {
  const fallback = (text: string): VideoGenErrorParsed => ({
    type: classifyKlingError(text),
    message: text.slice(0, 500),
    httpCode: httpStatus,
  });

  const text = (rawText || "").trim();
  if (!text) return fallback("");

  if (!text.startsWith("{")) {
    // usage 文本：换成可行动的中文提示，不甩英文帮助
    if (isCliUsageText(text)) {
      return {
        type: "invalid_params",
        message: CLI_USAGE_HINT,
        httpCode: httpStatus,
      };
    }
    return fallback(text);
  }

  try {
    const env = JSON.parse(text) as {
      ok?: boolean;
      status?: number;
      body?: unknown;
    };
    const body = env.body;
    const message =
      typeof body === "string"
        ? body
        : ((body as any)?.message ??
          (body as any)?.error?.message ??
          (body as any)?.error ??
          "");
    const msgText = typeof message === "string" ? message : JSON.stringify(message ?? "");
    return {
      type: classifyKlingError(msgText),
      message: msgText || text.slice(0, 500),
      httpCode: typeof env.status === "number" ? env.status : httpStatus,
    };
  } catch {
    return fallback(text);
  }
}

/** 错误 → 用户可读的一句话 */
export function friendlyKlingError(
  parsed: VideoGenErrorParsed,
  httpStatus: number,
): string {
  const msg = (parsed.message || "").trim();
  switch (parsed.type) {
    case "not_logged_in":
      return "可灵 CLI 未登录。请在终端执行 `kling login` 完成登录后重试。";
    case "insufficient_credits": {
      const url = extractKlingRechargeUrl(msg);
      return `可灵灵感值不足，请充值后重试${url ? `：${url}` : ""}`;
    }
    case "content_moderation":
      return `提示词或参考素材未通过可灵内容审核，请调整后重试${msg ? `（${msg}）` : ""}`;
    case "invalid_params":
      return `可灵拒绝了当前参数：${msg}`;
    case "model_not_found":
      return `当前可灵模型不可用：${msg}`;
    case "not_found":
      return `可灵任务不存在或已过期${msg ? `：${msg}` : ""}`;
    case "timeout":
      return "可灵任务超时，请稍后在任务列表查看结果";
    case "server_error":
      return `可灵服务异常（${httpStatus}）：${msg}`;
    default:
      return msg ? `可灵请求失败：${msg}` : `可灵请求失败（${httpStatus}）`;
  }
}
