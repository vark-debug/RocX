/**
 * MiniMax provider 入口：默认导出已构造好的实例 + 模型列表
 */
import { MiniMaxProvider, MINIMAX_MODEL_LIST } from "./MiniMaxProvider";
import { VideoGenError } from "../core/errors";
import { parseMiniMaxError, friendlyMiniMaxError } from "./errorMap";

export { MiniMaxProvider, MINIMAX_MODEL_LIST, parseMiniMaxError, friendlyMiniMaxError };
export { VideoGenError };
export const minimaxProvider = new MiniMaxProvider();