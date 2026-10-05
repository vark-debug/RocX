/**
 * RunningHub wire format：尺寸档位/比例 → 具体像素宽高映射
 *
 * Seedream v5 pro 文生图约束（官方文档）：
 * - width/height 自定义 Int 直传（不再传 resolution 枚举）
 * - 计价档位由输出像素总数决定：≤ 236 万像素为 1K，否则 2K
 * - 单次仅生成 1 张
 * - outputFormat: "jpeg" | "png"
 */

/** 1K 计价上限（像素总数）：≤ 236 万按 1K 计价，超过按 2K */
export const IMAGE_1K_MAX_PIXELS = 2_360_000;

/** API 像素上限：超过时须等比缩放（实测 4K 序列报 "must be at most 4194304 pixels"） */
export const IMAGE_API_MAX_PIXELS = 4_194_304;

/** 比例 → 1K 基准像素（2K 为 ×2） */
const RATIO_SIZE_1K: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
};

export function ratioToSize(
  ratio: string,
  resolution: string,
): { width: number; height: number } {
  const base = RATIO_SIZE_1K[ratio] ?? RATIO_SIZE_1K["1:1"];
  if (resolution === "2K") {
    return { width: base.width * 2, height: base.height * 2 };
  }
  return base;
}

/** 按输出像素总数定计价档位：≤ 236 万 → "1K"，否则 → "2K" */
export function billingTierOf(width: number, height: number): "1K" | "2K" {
  return width * height <= IMAGE_1K_MAX_PIXELS ? "1K" : "2K";
}

/** 向下取偶数：整偶像素对编码器/采样更友好 */
function floorEven(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * 等比缩放到 API 像素上限内（幂等：已合规的原样返回）。
 * scale = sqrt(上限 / 当前像素数)，两边同乘后向下取偶，比例严格不变。
 * 例：3840×2160 → 2730×1536（419 万像素，压线合规）。
 */
export function clampToApiMax(
  width: number,
  height: number,
): { width: number; height: number; scaled: boolean } {
  if (width * height <= IMAGE_API_MAX_PIXELS) {
    return { width, height, scaled: false };
  }
  const scale = Math.sqrt(IMAGE_API_MAX_PIXELS / (width * height));
  return { width: floorEven(width * scale), height: floorEven(height * scale), scaled: true };
}

/** 常见比例表（智能档宽高比展示用） */
const KNOWN_RATIOS: Array<[string, number]> = [
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 由实际像素推导宽高比描述：先按 2% 容差匹配常见比例（3840×2160 → "16:9"），
 * 命不中再按 GCD 精确约分（如 455:256）。
 */
export function describeRatio(width: number, height: number): string {
  const r = width / height;
  for (const [label, v] of KNOWN_RATIOS) {
    if (Math.abs(r - v) / v <= 0.02) return label;
  }
  const g = gcd(width, height) || 1;
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}
