/**
 * RunningHub wire format：尺寸档位/比例 → 具体像素宽高映射
 *
 * Seedream v5 pro 文生图约束（官方文档）：
 * - width/height 自定义范围 1024–2048
 * - resolution: "1k" | "2k"（小写）
 * - 单次仅生成 1 张
 * - outputFormat: "jpeg" | "png"
 */

export type RunningHubResolution = "1k" | "2k";

/** 比例 → 1K 基准像素（2K 为 ×2，均在 1024–2048 内） */
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

/** UI 尺寸档位（"1K"/"2K"）→ RunningHub API resolution 值（小写） */
export function toWireResolution(resolution: string): RunningHubResolution {
  return resolution === "2K" ? "2k" : "1k";
}
