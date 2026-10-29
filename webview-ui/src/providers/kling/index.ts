/**
 * 可灵（Kling CLI）provider 入口：单例导出
 * （与 runninghub / minimax / ark 目录结构对齐）
 */
import { KlingProvider } from "./KlingProvider";
import { KlingImageProvider } from "./KlingImageProvider";

export const klingProvider = new KlingProvider();
export const klingImageProvider = new KlingImageProvider();

export {
  klingModels,
  klingEnv,
  KLING_LOW_CREDITS_THRESHOLD,
  loadKlingModels,
  refreshKlingAccount,
  resetKlingCatalogCache,
  checkKlingReady,
  rechargeHint,
  bootstrapKlingEnv,
  refreshKlingEnvInBackground,
  restoreKlingEnvSnapshot,
  getKlingDefaultModel,
  getKlingCatalogSync,
} from "./KlingProvider";
export type { KlingEnvState } from "./KlingProvider";

export {
  getKlingImageDefaultModel,
  klingResolutionFromPixels,
} from "./KlingImageProvider";
export { klingImageModels } from "./imageState";

export { KLING_PROVIDER_ID } from "./wireFormat";
