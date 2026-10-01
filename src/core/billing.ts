/**
 * 费用估算(从 webhook.ts 抽离)
 *
 * 价格表与算法集中在本文件,webhook 只负责限流重试 + HTTP 上报。
 *
 * 估价按用途(purpose)分档:
 * - 视频生成 / 分辨率升级:(参考视频时长 + 输出视频时长) × 档位单价
 * - 提示词优化:输入 token × 输入单价 + 输出 token × 输出单价(不产视频,与时长口径无关)
 *
 * 价格调整(模型促销 / 协议价等)只动本文件,不涉及 webhook 上报逻辑。
 */
import {
  REPORT_PURPOSE,
  type GenerationRecord,
  type ReportPurpose,
} from "@shared/messages";

/** 档位单价(元/秒),按输出分辨率取值;后续调整只改这一处 */
export const PRICE_BY_RESOLUTION: Record<string, number> = {
  "2K": 0.8,
  "768P": 0.5,
  "480P": 0.33,
};

/** 分辨率升级任务(768P → 2K)单独一档 */
export const UPGRADE_UNIT_PRICE = 0.3;

/**
 * 提示词优化按 token 计费(元 / 百万 tokens)
 * 输入与输出单价不同,需分开累计;单价随模型定价调整,改这一处即可。
 */
export const TOKEN_PRICE_PER_MILLION = {
  prompt: 5.8,
  completion: 23,
};

/**
 * 统一保留 COST_PRECISION 位小数:token 类估价量级仅 0.2~0.3,两位小数会丢失约
 * 1.4%,批量累加后误差不可忽略,故取三位。
 */
const COST_PRECISION = 3;

/** 记录自带分辨率升级标记时即为升级任务 */
export function resolvePurpose(record: GenerationRecord): ReportPurpose {
  return record.upgradedFromResolution
    ? REPORT_PURPOSE.UPSCALE
    : REPORT_PURPOSE.VIDEO_GEN;
}

/** 估价:视频生成/升级/优化 按各自公式 */
export function estimateCost(
  record: GenerationRecord,
  purpose: ReportPurpose,
): number {
  const factor = 10 ** COST_PRECISION;
  const round = (n: number) => Math.round(n * factor) / factor;

  if (purpose === REPORT_PURPOSE.PROMPT_OPT) {
    const usage = record.usage;
    const cost =
      ((usage?.prompt_tokens || 0) * TOKEN_PRICE_PER_MILLION.prompt +
        (usage?.completion_tokens || 0) * TOKEN_PRICE_PER_MILLION.completion) /
      1_000_000;
    return round(cost);
  }

  const refSec = (record.references || [])
    .filter((r) => r.type === "reference_video")
    .reduce((sum, r) => sum + (r.durationSec || 0), 0);
  const outSec = record.params?.duration || 0;
  const unitPrice =
    purpose === REPORT_PURPOSE.UPSCALE
      ? UPGRADE_UNIT_PRICE
      : PRICE_BY_RESOLUTION[record.params?.resolution] ?? 0;
  return round((refSec + outSec) * unitPrice);
}