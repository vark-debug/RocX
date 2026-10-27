/**
 * 飞书多维表格上报 composable
 *
 * 责任:
 * - toRecordError: 把异常归一化为 GenerationRecord.error 形状
 * - reportToFeishu: 把已生成 record 推送到飞书;fire-and-forget,失败仅 toast
 * - reportKlingSubmitted: 可灵「提交即上报」路径(积分已扣,不等终态)
 *
 * 不做:不持有 inflight,不关心 records 数组;调用方传入 record + purpose。
 * 这样 video upload / 多工程并行 / 升级任务都可以复用同一上报入口。
 */
import { bridge } from "../services/bridge";
import { VideoGenError } from "../providers/core/errors";
import { REPORT_PURPOSE } from "@shared/messages";
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

  /**
   * 可灵「提交即上报」:提交成功的瞬间就入账,不等终态。
   *
   * 可灵在**提交时即扣**灵感值,且服务端无退款机制(任务失败积分不退)。
   * 若沿用「终态成功才上报」,失败任务就会「扣了钱但查无记录」。
   * 反过来终态再报一次又会重复计账 —— 所以终态路径对可灵是**不触发**上报的。
   *
   * rec 必须已带上 creditsConsumed(实扣值),否则飞书侧该行会记成 0 灵感值。
   */
  function reportKlingSubmitted(rec: GenerationRecord) {
    reportToFeishu(rec, REPORT_PURPOSE.KLING_VIDEO_GEN);
  }

  /**
   * 可灵**图片**的「提交即上报」。
   *
   * 与视频侧同语义（提交即扣、失败不退），但 purpose 不同 ——
   * 飞书侧按 purpose 分列汇总成本口径，图片与视频不能混在一列。
   */
  function reportKlingImageSubmitted(rec: GenerationRecord) {
    reportToFeishu(rec, REPORT_PURPOSE.KLING_IMAGE_GEN);
  }

  return {
    toRecordError,
    reportToFeishu,
    reportKlingSubmitted,
    reportKlingImageSubmitted,
  };
}