/**
 * RunningHub provider 入口：单例导出（与 minimax 目录结构对齐）
 */
import { RunningHubProvider } from "./RunningHubProvider";

export const runningHubProvider = new RunningHubProvider();
export { RUNNINGHUB_MODEL_LIST } from "./RunningHubProvider";
