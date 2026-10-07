/**
 * 把 throw 的同步函数翻译为 Promise<SafeCallResult>
 *
 * 业务层用统一的 {ok, error} 风格接收 provider 调用结果,
 * 失败时 error 已是 record.error 形状(可直接 spread 进 record.error),
 * 避免业务层手写 try/catch + instanceof VideoGenError 转换。
 *
 * 例:
 *   const r = await safeProviderCall(() => mini.createVideo(req, apiKey));
 *   if (!r.ok) {
 *     record.status = "failed";
 *     record.error = r.error;
 *     return;
 *   }
 *   const task_id = r.data.taskId;
 */
import { toRecordError } from "./useFeishuReport";

export type SafeCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ReturnType<typeof toRecordError> };

export async function safeProviderCall<T>(
  fn: () => Promise<T>,
): Promise<SafeCallResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e: any) {
    return { ok: false, error: toRecordError(e) };
  }
}