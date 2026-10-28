/**
 * 图片生成参数选项（尺寸档位 / 宽高比）的**唯一来源**
 *
 * 为什么单独抽出来：
 * - ImagePromptInput.vue 渲染可选项
 * - main-webview.vue 切平台时把当前值收敛到新平台的值域
 * 两处必须用同一份规则，否则会出现「UI 显示的值在提交时是非法值」。
 *
 * 可灵走服务端声明（img_resolution "1k"/"2k"/"4k"、aspect_ratio 含 "auto"），
 * 与其余平台（"智能"/"1K"/"2K" + 固定 5 个比例）语义不同 ——
 * 所以取值集是**按平台**给的，不是全局常量。
 */

/** 服务端下发的图片参数约束（可灵用；其余平台为 undefined） */
export interface ImageParamConstraints {
  /** img_resolution 值域："1k" / "2k" / "4k" */
  resolutions: string[];
  /** aspect_ratio 值域（可能含 "auto"） */
  ratios: string[];
  /** 服务端声明的默认 img_resolution（切平台时优先用它，而不是值域首项） */
  defaultResolution?: string;
  /** 服务端声明的默认 aspect_ratio */
  defaultRatio?: string;
}

/** 其余平台的默认尺寸档位（"智能" = 跟随活动序列分辨率） */
export const DEFAULT_IMAGE_SIZE_OPTIONS = ["智能", "1K", "2K"];

/** 其余平台的默认宽高比 */
export const DEFAULT_IMAGE_RATIO_OPTIONS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

/**
 * 平台的默认宽高比（用户没手动选过时用它）。
 *
 * - 可灵：服务端声明的 `aspect_ratio` 默认值 —— 实测默认模型
 *   `kling-image-v3_0_omni` 声明的是 **"auto"**（模型按提示词自选比例）
 * - 其余平台：本地默认集首项（"1:1"）
 */
export function defaultImageRatio(
  constraints?: ImageParamConstraints | null,
): string {
  if (constraints) {
    if (constraints.defaultRatio) return constraints.defaultRatio;
    // 服务端没给默认值 → 用它声明的值域首项
    return constraints.ratios[0] ?? DEFAULT_IMAGE_RATIO_OPTIONS[0];
  }
  return DEFAULT_IMAGE_RATIO_OPTIONS[0];
}

/**
 * 平台的默认尺寸档位（用户没手动选过时用它）。
 *
 * - 可灵：服务端声明的 `img_resolution` 默认值 —— 实测默认模型
 *   `kling-image-v3_0_omni` 声明的是 **"2k"**
 * - 其余平台："智能"（跟随活动序列分辨率）
 */
export function defaultImageSize(
  constraints?: ImageParamConstraints | null,
  supportsSmartSize = true,
): string {
  if (constraints) {
    if (constraints.defaultResolution) return constraints.defaultResolution;
    // 服务端声明了参数但没给默认值 → 值域首项；压根没声明该参数 → 空串
    // （空串 = 分辨率由服务端决定，UI 不出尺寸选择器）
    return constraints.resolutions[0] ?? "";
  }
  return supportsSmartSize ? DEFAULT_IMAGE_SIZE_OPTIONS[0] : "";
}

/**
 * 尺寸档位选项。
 *
 * - 有服务端声明 → 用声明的值域（可灵："1k"/"2k"/"4k"；模型没声明该参数 → 空数组，
 *   表示「分辨率由服务端决定」，UI 不出尺寸选择器）
 * - 无声明 → 本地默认值；不支持"智能"档的平台去掉"智能"
 *
 * ⚠ 不支持"智能"档却拿不到服务端声明（可灵清单还没拉到）→ 返回空数组：
 *   可灵用的是 "1k"/"2k"/"4k"（小写），套别的平台的 "1K"/"2K" 是误导，
 *   与其显示一排不能用的档位，不如这一组先不出。
 */
export function imageSizeOptions(
  constraints?: ImageParamConstraints | null,
  supportsSmartSize = true,
): string[] {
  if (constraints) return constraints.resolutions;
  if (!supportsSmartSize) return [];
  return [...DEFAULT_IMAGE_SIZE_OPTIONS];
}

/** 宽高比选项（有服务端声明 → 用声明的值域） */
export function imageRatioOptions(
  constraints?: ImageParamConstraints | null,
): string[] {
  const fromServer = constraints?.ratios ?? [];
  return fromServer.length ? fromServer : [...DEFAULT_IMAGE_RATIO_OPTIONS];
}

/**
 * 把当前尺寸档位收敛到目标平台的值域。
 *
 * 大小写不敏感匹配（"1K" ↔ "1k"）：两个平台的档位名只差大小写，
 * 切平台时能保留用户的选择。
 *
 * preferred 是服务端声明的默认档位（可灵用）：当前值不在值域里时优先用它，
 * 而不是退到值域首项 —— 可灵的默认是 "2k"，退到首项会变成 "1k"（降一档画质）。
 *
 * 值域为空 → 返回空串（服务端没声明分辨率参数，由模型自己决定）。
 */
export function coerceImageSize(
  current: string,
  options: string[],
  preferred?: string,
): string {
  if (!options.length) return "";
  if (options.includes(current)) return current;
  const hit = options.find((o) => o.toLowerCase() === current.toLowerCase());
  if (hit) return hit;
  if (preferred && options.includes(preferred)) return preferred;
  return options[0];
}

/**
 * 把当前宽高比收敛到目标平台的值域。
 *
 * "auto"（可灵按提示词自选比例）在其余平台没有对应值 → 退回 "1:1"。
 * preferred 同 coerceImageSize：服务端声明的默认比例优先。
 */
export function coerceImageRatio(
  current: string,
  options: string[],
  preferred?: string,
): string {
  if (!options.length) return current;
  if (options.includes(current)) return current;
  if (preferred && options.includes(preferred)) return preferred;
  return options.includes("1:1") ? "1:1" : options[0];
}
