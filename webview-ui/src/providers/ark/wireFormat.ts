/**
 * Ark（火山方舟）wire format：
 * - size 显式 "WxH" 字符串（如 "2048x1152"）
 * - 透明底走图生图：image 数组传 data URI + background: "transparent"
 *   （纯文生图无法产出透明通道，透明必须以图片为输入）
 * - 透明意图检测：可扩展关键词表，命中任一即视为需要透明底
 */

/** Ark 图片生成端点（cn-beijing，同步 API，一次请求直接返回结果） */
export const ARK_IMAGE_GENERATE_URL =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";

/**
 * 透明意图关键词表（可扩展）：prompt 命中任一子串 → 自动补透明画布走图生图。
 * 需要新增触发词时只改这个数组。
 */
export const TRANSPARENT_KEYWORDS: readonly string[] = [
  "透明背景",
  "透明底",
  "带通道",
  "alpha通道",
  "alpha 通道",
  "无背景",
  "无底色",
  "去背景",
  "transparent",
  "alpha",
];

/** prompt 是否包含任一透明意图关键词（大小写不敏感） */
export function hasTransparentIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return TRANSPARENT_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/** Ark 像素范围（Seedream 官方约束）：总像素 [1024×1024, 4096×4096] */
export const ARK_MIN_PIXELS = 1_048_576; // 1024 * 1024
export const ARK_MAX_PIXELS = 16_777_216; // 4096 * 4096

/** Ark 1K 计价上限（像素总数）：≤ 261 万按 1K 计价，超过按 2K（与 RunningHub 236 万分界不同） */
export const ARK_1K_MAX_PIXELS = 2_610_000;

/** 向上取偶数（等比放大时保持整偶像素） */
function ceilEven(n: number): number {
  return Math.max(2, Math.ceil(n / 2) * 2);
}

/**
 * 等比放大到 Ark 最小像素以上（幂等：已合规原样返回）。
 * 智能档小序列（如 1280×720 = 92 万像素 < 1MP）需放大，否则 API 报参数错误。
 */
export function clampToArkMin(
  width: number,
  height: number,
): { width: number; height: number; scaled: boolean } {
  if (width * height >= ARK_MIN_PIXELS) {
    return { width, height, scaled: false };
  }
  const scale = Math.sqrt(ARK_MIN_PIXELS / (width * height));
  return { width: ceilEven(width * scale), height: ceilEven(height * scale), scaled: true };
}

/** 生成 Ark size 字段：显式 "WxH" */
export function arkSizeOf(width: number, height: number): string {
  return `${Math.round(width)}x${Math.round(height)}`;
}

/**
 * 生成一张全透明画布的 PNG data URI（作为透明底图生图的输入图）。
 * 全透明 PNG 压缩后仅几 KB，直接传给 Ark image 数组。
 */
export function makeTransparentCanvasDataUri(
  width: number,
  height: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D 上下文不可用，无法生成透明画布");
  }
  // 不绘制任何内容：canvas 初始即为全透明
  return canvas.toDataURL("image/png");
}
