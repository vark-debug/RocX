/**
 * 飞书多维表格上报 composable
 *
 * 责任:
 * - toRecordError: 把异常归一化为 GenerationRecord.error 形状
 * - reportToFeishu: 把已生成 record 推送到飞书;fire-and-forget,失败仅 toast
 *
 * 不做:不持有 inflight,不关心 records 数组;调用方传入 record + purpose。
 * 这样 video upload / 多工程并行 / 升级任务都可以复用同一上报入口。
 */
import { bridge } from "../services/bridge";
import { VideoGenError } from "../providers/core/errors";
import type { GenerationRecord, ReportPurpose } from "@shared/messages";

type RefAny<T> = { value: T };

/** 把异常归一化为 GenerationRecord.error 形状 */
export function toRecordError(e: any): {
  message: string;
  requestId?: string;
  httpStatus?: number;
  errorType?: string;
} {
  if (e instanceof VideoGenError) {
    return {
      message: e.message,
      requestId: e.requestId,
      httpStatus: e.httpStatus,
      errorType: e.errorType,
    };
  }
  return { message: String(e?.message || e) };
}

export function useFeishuReport(opts: {
  showToast: (msg: string | unknown) => void;
}) {
  /**
   * 把已生成记录推送到飞书多维表格。
   * 全程不阻塞:桥调用 / 限流重试都在后台完成,失败仅 toast 提示。
   * purpose 缺省时由 UXP 端按记录推断(升级任务带 upgradedFromResolution)。
   */
  function reportToFeishu(rec: GenerationRecord, purpose?: ReportPurpose) {
    bridge
      .reportGenerated(rec, purpose)
      .then((r) => {
        // skipped = 未配置 webhook 地址,属于正常情况,静默
        if (!r.ok && !r.skipped) opts.showToast(`飞书上报失败: ${r.error}`);
      })
      .catch((e: any) => {
        opts.showToast(`飞书上报失败(桥调用异常): ${e?.message || e}`);
      });
  }

  return {
    toRecordError,
    reportToFeishu,
  };
}