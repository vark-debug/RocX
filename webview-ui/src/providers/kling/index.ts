/**
 * 可灵（Kling CLI）provider 入口：单例导出
 * （与 runninghub / minimax / ark 目录结构对齐）
 */
import { KlingProvider } from "./KlingProvider";

export const klingProvider = new KlingProvider();

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
} from "./KlingProvider";
export type { KlingEnvState } from "./KlingProvider";

export { KLING_PROVIDER_ID } from "./wireFormat";
