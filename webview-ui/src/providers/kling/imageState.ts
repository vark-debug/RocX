/**
 * 可灵图片侧的模块级状态（模型清单）。
 *
 * ⚠ 单独成文件的原因：**循环依赖**。
 *   KlingProvider 拉完 who_am_i 后要把图片模型同步进清单，
 *   而 KlingImageProvider 又要从 KlingProvider 取 catalog ——
 *   若把 syncKlingImageModels 放在 KlingImageProvider 里，
 *   两个模块就会互相 import（ESM 能跑但初始化顺序不可控）。
 *   本模块只依赖 wireFormat，是依赖链的最底层，两边都安全。
 */
import { ref } from "vue";
import type { ModelDescriptor } from "../core/types";
import { buildKlingImageModelDescriptors } from "./wireFormat";
import type { KlingModelCatalog } from "./wireFormat";

/** 可灵图片模型清单（who_am_i 拉取后填充；失败时保持空数组，不回退硬编码清单） */
export const klingImageModels = ref<ModelDescriptor[]>([]);

/**
 * 把 catalog 里的图片模型拍平到 klingImageModels。
 *
 * 由 KlingProvider 在解析完 who_am_i 后调用 —— 两边共用同一份响应，
 * 不额外发 CLI（`who_am_i` 实测 856ms，能省一次是一次）。
 */
export function syncKlingImageModels(catalog: KlingModelCatalog): void {
  klingImageModels.value = buildKlingImageModelDescriptors(catalog);
}
