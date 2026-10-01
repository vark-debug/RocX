/**
 * 抓素材锁定的工程归属上下文
 *
 * 归属判定从「推断」改为「赋值」：素材是在哪个工程抓的，这个信息在抓取那一刻
 * 就是确定的，由 UXP 端随抓取结果一起返回（CaptureOwner）。这里只负责把它留住，
 * 一直留到用户点生成。
 *
 * 为什么需要它：PR 允许同进程打开多个工程，之前的归属靠「参考素材父级目录 →
 * 实时活动工程 → 插件缓存」三层信任层级推断，且读记录和写记录各推断一次。
 * 两个时机之间用户可以切工程，两次结果可能不同，于是出现读 A 的记录、写 B 的 JSON。
 *
 * 生命周期以「每批素材」为粒度：首次抓素材锁定（first-write-wins），参考素材列表
 * 变空时释放。不跨批次继承 —— 上一批生成完就解锁，下一批抓取时重新锁定。
 */
import type { CaptureOwner } from "@shared/messages";

/** 归属来源：素材继承 / 实时活动工程（纯文生视频）。仅用于 UI 提示与日志，不参与落盘路由 */
export type OwnerSource = "capture" | "live";

export interface CaptureContext {
  projectGuid: string;
  /** 工程文件的绝对路径（不是目录） */
  projectPath: string;
  projectName: string;
  /** 锁定时刻 */
  lockedAt: number;
  source: OwnerSource;
}

// 模块级单例：生命周期独立于面板组件，不能放在 Vue ref 里
let ctx: CaptureContext | null = null;

/**
 * 锁定归属。first-write-wins：已锁定时直接返回 false，不覆盖。
 * owner 为空（抓取时无活动工程）时不锁定。
 * @returns 是否成功建立了锁定
 */
export function lockCaptureContext(
  owner: CaptureOwner | null | undefined,
  source: OwnerSource = "capture",
): boolean {
  if (!owner || !owner.projectPath) return false;
  if (ctx) {
    console.log(
      `[capture-ctx] 已锁定（${ctx.projectName || ctx.projectPath}），忽略本次锁定请求: ${owner.projectPath}`,
    );
    return false;
  }
  ctx = {
    projectGuid: owner.projectGuid || "",
    projectPath: owner.projectPath,
    projectName: owner.projectName || "",
    lockedAt: Date.now(),
    source,
  };
  console.log(`[capture-ctx] 锁定归属: ${ctx.projectPath} guid=${ctx.projectGuid || "-"}`);
  return true;
}

/** 读取当前锁定值；未锁定返回 null */
export function getCaptureContext(): CaptureContext | null {
  return ctx;
}

/** 释放锁定（参考素材列表变空时调用） */
export function resetCaptureContext() {
  if (!ctx) return;
  console.log(`[capture-ctx] 释放归属: ${ctx.projectPath}`);
  ctx = null;
}
