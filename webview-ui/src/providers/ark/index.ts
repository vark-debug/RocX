/**
 * Ark（火山方舟）provider 入口：单例导出（与 runninghub / minimax 目录结构对齐）
 */
import { ArkProvider } from "./ArkProvider";

export const arkProvider = new ArkProvider();
export { ARK_MODEL_LIST } from "./ArkProvider";
