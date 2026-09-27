/**
 * UXP 端 MiniMax provider 入口 + 默认注册
 */
import { MiniMaxUxPProvider } from "./MiniMaxUxPProvider";
import { registerUxPProvider } from "../registry";

export { MiniMaxUxPProvider };
export const minimaxUxPProvider = new MiniMaxUxPProvider();
registerUxPProvider(minimaxUxPProvider);
