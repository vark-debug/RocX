/**
 * 参数浮层的「点别处就收起」
 *
 * 视频（PromptInput）与图片（ImagePromptInput）两个提示词组件共用同一套交互。
 *
 * 规则：
 * - 点击提示词输入框 → 收起浮层，并把焦点还给输入框（用户点完可直接打字）
 * - 点击浮层外的任意位置 → 收起浮层
 * - 点击浮层内的选项 / 切换按钮 → **不收起**（用户还在选；按钮自己管开关）
 *
 * ⚠ 浮层向上展开，**正好盖住提示词输入框** —— 用户「点提示词框」时
 *   实际点到的是浮层，不是输入框。所以除了收起浮层，还要看点击位置
 *   是否落在输入框上，命中就把焦点还回去（否则用户点完还得再点一次）。
 */
import { onMounted, onUnmounted } from "vue";
import type { Ref } from "vue";

/** 浮层内不触发收起的元素（选项 / 切换按钮） */
const IGNORE_SELECTORS = [".param-toggle", ".radio-item"];

/**
 * 一次点击对浮层的影响。
 *
 * - `ignore`：不动浮层（点在选项 / 切换按钮上，用户还在选）
 * - `close`：收起浮层，但不动焦点（点在叠在输入框上的独立按钮上）
 * - `close-and-focus`：收起浮层，且命中输入框时把焦点还给输入框
 */
export type DismissAction = "ignore" | "close" | "close-and-focus";

/** 只需 `closest` 的最小元素接口（便于无头测试） */
export interface Closable {
  closest(selector: string): unknown;
}

/**
 * 判定一次点击对浮层的影响（纯函数，无 DOM 依赖）。
 *
 * 抽出成纯函数是为了能脱离浏览器跑回归 —— 浮层收起的规则最容易在
 * 「点选项」「点旁挂按钮」这类边界上被改坏。
 */
export function resolveDismissAction(
  target: Closable | null | undefined,
  noFocus: string[] = [],
): DismissAction {
  if (!target) return "close-and-focus";
  for (const sel of IGNORE_SELECTORS) {
    if (target.closest(sel)) return "ignore";
  }
  for (const sel of noFocus) {
    if (target.closest(sel)) return "close";
  }
  return "close-and-focus";
}

/** 点是否落在矩形内（用于「点击位置命中输入框 → 回焦」） */
export function isPointInRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  );
}

export function usePopoverDismiss(opts: {
  /** 是否有浮层处于展开状态（用于提前 return，避免无谓的 DOM 查询） */
  isOpen: () => boolean;
  /** 收起浮层 */
  close: () => void;
  /** 提示词输入框（点击位置命中它时把焦点还回去） */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /**
   * 额外的「点了收起但不抢焦点」选择器。
   * 用于叠在输入框上的独立按钮（如视频侧的 ✨ 优化按钮）——
   * 它不是浮层内容，但也不是「点输入框」，不该顺手把焦点抢回输入框。
   */
  noFocus?: string[];
}): void {
  function onDocClick(e: MouseEvent) {
    if (!opts.isOpen()) return;
    const t = e.target as HTMLElement | null;
    const action = resolveDismissAction(t, opts.noFocus);
    if (action === "ignore") return;
    opts.close();
    if (action === "close") return;
    // 点击位置落在提示词框上 → 把焦点还给输入框（用户可以接着打字）
    const ta = opts.textareaRef.value;
    if (!ta) return;
    if (isPointInRect(e.clientX, e.clientY, ta.getBoundingClientRect())) {
      ta.focus();
    }
  }

  // 捕获阶段：先于目标元素的 handler 触发，能穿透子元素的 @click.stop
  onMounted(() => document.addEventListener("click", onDocClick, true));
  onUnmounted(() => document.removeEventListener("click", onDocClick, true));
}
