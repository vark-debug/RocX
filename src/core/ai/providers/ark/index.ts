/**
 * UXP 端 Ark provider 入口：注册单例（与 runninghub / minimax 目录结构对齐）
 */
import { registerUxPProvider } from "../registry";
import { ArkUxPProvider } from "./ArkUxPProvider";

export const arkUxPProvider = new ArkUxPProvider();
registerUxPProvider(arkUxPProvider);
