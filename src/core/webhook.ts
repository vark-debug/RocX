/**
 * Webhook 上报：生成成功后把结果推送到外部平台（飞书多维表格 / 钉钉等）
 *
 * 请求由 UXP 端发出（而非 webview），原因有二：
 * 1. webhook 地址与 token 存于 secureStorage，不跨桥暴露给 webview；
 * 2. UXP 端 fetch 不受 webview 的 CORS / 白名单双重约束。
 *
 * 飞书频率限制（官方）：
 * - 整个多维表格 50 次/秒
 * - 单个自动化流程 5 次/秒
 * - 单个流程未开启凭证校验时仅 1 次/秒 → 因此强烈建议开启 Bearer token
 *
 * 上报为 fire-and-forget：限流、鉴权、网络故障都不影响生成结果。
 */
import {
  REPORT_PURPOSE,
  type GenerationRecord,
  type ReportPurpose,
} from "@shared/messages";
import { projectCore } from "./project";
import { storage } from "./storage";

/** 档位单价（元/秒），按输出分辨率取值；后续调整只改这一处 */
const PRICE_BY_RESOLUTION: Record<string, number> = {
  "2K": 0.8,
  "768P": 0.5,
  "480P": 0.33,
};

/** 分辨率升级任务（768P → 2K）单独一档 */
const UPGRADE_UNIT_PRICE = 0.3;

/**
 * 提示词优化按 token 计费（元 / 百万 tokens）
 * 输入与输出单价不同，需分开累计；单价随模型定价调整，改这一处即可。
 */
const TOKEN_PRICE_PER_MILLION = {
  prompt: 5.8,
  completion: 23,
};

/** 飞书返回的限流错误码：触发频率超出限制 */
const RATE_LIMIT_CODE = 800005652;

/** 限流退避基数（ms），最多重试 3 次；首档 ≈ 单流程 200ms 最小间隔的 2 倍 */
const RETRY_BASE_DELAYS_MS = [400, 800, 1600];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 记录自带分辨率升级标记时即为升级任务 */
export function resolvePurpose(record: GenerationRecord): ReportPurpose {
  return record.upgradedFromResolution
    ? REPORT_PURPOSE.UPSCALE
    : REPORT_PURPOSE.VIDEO_GEN;
}

/**
 * 估价按用途（purpose）分档：
 * - 视频生成 / 分辨率升级：（参考视频时长 + 输出视频时长）× 档位单价
 * - 提示词优化：输入 token × 输入单价 + 输出 token × 输出单价（不产视频，与时长口径无关）
 *
 * 统一保留 COST_PRECISION 位小数：token 类估价量级仅 0.2~0.3，两位小数会丢失约
 * 1.4%，批量累加后误差不可忽略，故取三位。
 */
const COST_PRECISION = 3;

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

/** 工程名为空时退回路径末段文件名 */
function resolveProjectName(p: {
  path: string;
  name: string;
}): string {
  if (p.name) return p.name;
  const seg = (p.path || "").split(/[\\/]/).filter(Boolean).pop();
  return seg || "未知工程";
}

interface PostResult {
  ok: boolean;
  /** 是否命中限流（用于决定是否重试） */
  rateLimited: boolean;
  error?: string;
}

async function postOnce(
  url: string,
  token: string,
  body: string,
): Promise<PostResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body });
  } catch (e: any) {
    // 网络异常不重试：大概率是断网或地址不可达，退避也救不回来
    return {
      ok: false,
      rateLimited: false,
      error: `网络异常: ${String(e?.message || e)}`,
    };
  }

  const text = await resp.text().catch(() => "");
  // 飞书限流可能以 HTTP 200 + body.code 表达，也可能是标准 429，两种都算
  let code: number | undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.code === "number") code = parsed.code;
  } catch {
    // 非 JSON 响应体，忽略
  }
  if (resp.status === 429 || code === RATE_LIMIT_CODE) {
    return { ok: false, rateLimited: true };
  }
  if (!resp.ok) {
    return {
      ok: false,
      rateLimited: false,
      error: `HTTP ${resp.status} ${text.slice(0, 200)}`,
    };
  }
  // HTTP 2xx 但 body.code 非 0：属于业务侧拒绝（如 token 校验失败），不算限流
  if (code !== undefined && code !== 0) {
    return {
      ok: false,
      rateLimited: false,
      error: `飞书返回错误码 ${code}: ${text.slice(0, 200)}`,
    };
  }
  return { ok: true, rateLimited: false };
}

/** 设置页「测试上报」用的固定样例，与飞书表格字段一一对应 */
const SAMPLE_PAYLOAD = {
  recordId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  estimateCost: 5,
  editorName: "张三",
  projectName: "Nike_春季广告片_剪辑版",
  purpose: REPORT_PURPOSE.VIDEO_GEN,
} as const;

/**
 * 发送一次并在命中限流时退避重试。
 * 仅限流类失败重试；鉴权、参数、网络异常直接返回，避免无意义等待。
 */
async function sendWithRetry(
  url: string,
  token: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  let last: PostResult = { ok: false, rateLimited: false, error: "" };
  for (let attempt = 0; attempt <= RETRY_BASE_DELAYS_MS.length; attempt++) {
    last = await postOnce(url, token, body);
    if (last.ok || !last.rateLimited) break;
    if (attempt < RETRY_BASE_DELAYS_MS.length) {
      // ±50% 抖动：多台机器被同时限流时，避免同步重试再次撞墙
      const base = RETRY_BASE_DELAYS_MS[attempt];
      await sleep(base * (0.5 + Math.random()));
    }
  }

  if (last.ok) return { ok: true };
  if (last.rateLimited) {
    return {
      ok: false,
      error: `飞书接口限流，已重试 ${RETRY_BASE_DELAYS_MS.length} 次仍未成功（错误码 ${RATE_LIMIT_CODE}）`,
    };
  }
  return { ok: false, error: last.error };
}

export const webhookCore = {
  estimateCost,

  /**
   * 设置页「测试上报」：用固定样例打一次 webhook，验证地址 / 令牌 / 表格字段映射。
   * 沿用真实上报的限流重试逻辑，避免测试路径与生产路径行为不一致。
   */
  async testReport(): Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
  }> {
    const cfg = await storage.getFeishuConfig();
    if (!cfg.webhookUrl) {
      return { ok: false, skipped: true, error: "未配置飞书 Webhook 地址" };
    }
    return await sendWithRetry(
      cfg.webhookUrl,
      cfg.token,
      JSON.stringify(SAMPLE_PAYLOAD),
    );
  },

  /**
   * 把一条已生成的记录上报到飞书多维表格。
   * purpose 缺省时按记录推断；提示词优化等无视频产出的用途由调用方显式传入。
   * 未配置地址时返回 skipped，不发请求。
   */
  async reportGenerated(
    record: GenerationRecord,
    purpose?: ReportPurpose,
  ): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
    const cfg = await storage.getFeishuConfig();
    if (!cfg.webhookUrl) {
      return { ok: false, skipped: true, error: "未配置飞书 Webhook 地址" };
    }

    const resolved = purpose || resolvePurpose(record);
    const cur = await projectCore.getCurrent();
    const payload = {
      recordId: record.id,
      estimateCost: estimateCost(record, resolved),
      editorName: cfg.editorName,
      projectName: cur ? resolveProjectName(cur) : "",
      purpose: resolved,
    };

    return await sendWithRetry(cfg.webhookUrl, cfg.token, JSON.stringify(payload));
  },
};
