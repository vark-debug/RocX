/**
 * 费用估算与成本口径(从 webhook.ts 抽离)
 *
 * 价格表与算法集中在本文件,webhook 只负责限流重试 + HTTP 上报。
 *
 * 估价按用途(purpose)分档:
 * - 视频生成 / 分辨率升级:(参考视频时长 + 输出视频时长) × 档位单价
 * - 图片生成:按尺寸档位每张计价(1K/2K);图生图输入图首张免费、后续按张加收
 * - 提示词优化:输入 token × 输入单价 + 输出 token × 输出单价(不产视频,与时长口径无关)
 *
 * 价格调整(模型促销 / 协议价等)只动本文件,不涉及 webhook 上报逻辑。
 *
 * 可灵(CLI)不在上述估价体系内:它在**提交时即扣费**,真实扣费额随响应返回,
 * 走 resolveCost 的 CREDITS/actual 分支,绝不折算成人民币元。
 */
import {
  KLING_PROVIDER_ID,
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

/**
 * 图片生成档位单价(元/张,单次生成 1 张),按 provider → 尺寸档位两级取值;
 * 与视频表分开:口径不同(每张 vs 每秒),勿合并。
 * 档位分界像素各 provider 不同(RunningHub 236 万 / Ark 261 万),
 * 由 webview 侧 billingTierOf(…, threshold) 按当前 provider 定档后写入记录。
 */
export const IMAGE_PRICE_BY_RESOLUTION: Record<string, Record<string, number>> = {
  runninghub: { "2K": 0.54, "1K": 0.27 },
  ark: { "2K": 0.6, "1K": 0.3 },
};

/** 图片价格回落 provider（老记录缺 params.provider / 未知 provider 时） */
const DEFAULT_IMAGE_PRICE_PROVIDER = "runninghub";

/** 图生图输入图单价(元/张,按 provider):首张免费,从第 2 张起按此计价 */
export const IMAGE_INPUT_UNIT_PRICE: Record<string, number> = {
  runninghub: 0.018,
  ark: 0.02,
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

/**
 * 结构化成本:区分「单位」与「口径」。
 *
 * - `CNY` / `estimated`:MiniMax / RunningHub / Ark 的本地价格表估算,单位人民币元
 * - `CREDITS` / `actual`:可灵 CLI 的实扣灵感值,随提交响应返回,是真实扣费额
 *
 * ⚠ 两种单位**绝不互相折算**:可灵的充值折扣 / 会员等级 / 促销都会改变实际单价,
 *   写死「灵感值 → 元」汇率必然失准;把实扣值当估算值上报更是数据造假。
 *   飞书侧「人民币元」与「灵感值」两张表分别求和,不得跨单位相加。
 */
export type CostEstimate =
  | { amount: number; unit: "CNY"; basis: "estimated" }
  | { amount: number; unit: "CREDITS"; basis: "actual" };

/**
 * 解析上报用途(purpose)。
 *
 * 可灵单独分列(可灵视频生成 / 可灵图片生成):它的成本口径是**实扣灵感值**,
 * 与其余三家的「本地估算人民币元」不是一回事,飞书侧要分别汇总。
 *
 * 其余 provider 的判定逻辑逐字未变:记录自带分辨率升级标记 → 升级任务;
 * 图片记录(kind=image)→ 图片生成;否则 → 视频生成。
 */
export function resolvePurpose(record: GenerationRecord): ReportPurpose {
  const isKling = record.params?.provider === KLING_PROVIDER_ID;
  if (record.kind === "image") {
    return isKling ? REPORT_PURPOSE.KLING_IMAGE_GEN : REPORT_PURPOSE.IMAGE_GEN;
  }
  if (isKling) return REPORT_PURPOSE.KLING_VIDEO_GEN;
  return record.upgradedFromResolution
    ? REPORT_PURPOSE.UPSCALE
    : REPORT_PURPOSE.VIDEO_GEN;
}

/**
 * 解析一条记录的成本:单位 + 口径 + 金额。
 *
 * 可灵(params.provider === "kling"):提交即扣费,creditsConsumed 是服务端随
 * generationId 一起返回的**真实扣费额** —— 直接采用,绝不用任何本地价格表推算。
 * 缺失时返回 0(unit=CREDITS + amount=0 表示「扣费未知」,不是「免费」)。
 *
 * 其余 provider:走本地价格表估算,金额与改造前 estimateCost **逐字节一致**。
 */
export function resolveCost(
  record: GenerationRecord,
  purpose: ReportPurpose,
): CostEstimate {
  if (record.params?.provider === KLING_PROVIDER_ID) {
    return {
      amount:
        typeof record.creditsConsumed === "number" ? record.creditsConsumed : 0,
      unit: "CREDITS",
      basis: "actual",
    };
  }
  return {
    amount: estimateAmount(record, purpose),
    unit: "CNY",
    basis: "estimated",
  };
}

/**
 * 估价:视频生成/升级/优化 按各自公式(人民币元)。
 *
 * ⚠ 本函数是改造前的 estimateCost 主体,公式与取值**逐字节原样搬移**,
 *   现有 provider 的上报金额不得有任何变化。
 */
function estimateAmount(
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

  // 图片生成:生成费按尺寸档位每张计价(不走时长公式,图片记录 duration 恒为 0);
  // 图生图输入图:首张免费,后续每张加收。单价按记录锁定的 provider 取子表,
  // 缺 provider(老记录)/未知 provider 回落 runninghub
  if (purpose === REPORT_PURPOSE.IMAGE_GEN) {
    const priceProvider =
      record.params?.provider || DEFAULT_IMAGE_PRICE_PROVIDER;
    const priceTable =
      IMAGE_PRICE_BY_RESOLUTION[priceProvider] ??
      IMAGE_PRICE_BY_RESOLUTION[DEFAULT_IMAGE_PRICE_PROVIDER];
    const base = priceTable[record.params?.resolution] ?? 0;
    const inputUnit =
      IMAGE_INPUT_UNIT_PRICE[priceProvider] ??
      IMAGE_INPUT_UNIT_PRICE[DEFAULT_IMAGE_PRICE_PROVIDER];
    const inputCount = (record.references || []).filter(
      (r) => r.type === "reference_image",
    ).length;
    const inputCost = Math.max(0, inputCount - 1) * inputUnit;
    return round(base + inputCost);
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

/**
 * 兼容封装:老调用方拿到的仍是一个数字(现有外部调用方不改)。
 *
 * ⚠ 可灵记录返回的是**灵感值**而不是人民币元 —— 上报请直接用 resolveCost,
 *   避免把积分写进「人民币元」列。
 */
export function estimateCost(
  record: GenerationRecord,
  purpose: ReportPurpose,
): number {
  return resolveCost(record, purpose).amount;
}