/**
 * 导入到 PR 工程 composable
 *
 * 责任:
 * - importToProject(ids): 调 bridge.importToProject + 同步 records.workFile 新路径 + toast
 *
 * 状态注入:从 main-webview.vue 顶层 provide 的 SharedRefsKey 取 records;
 * showToast 仍由调用方注入(可能在多个场景下复用)。
 *
 * 桥失败 / 业务失败都仅 toast,不抛错(与原 useGenerationTasks 行为一致)。
 */
import { inject } from "vue";
import { bridge } from "../services/bridge";
import { SharedRefsKey } from "../providers/state";
import type { GenerationRecord } from "@shared/messages";

export function useImport(opts: {
  showToast: (msg: string | unknown) => void;
}) {
  const sharedRaw = inject(SharedRefsKey);
  if (!sharedRaw) {
    throw new Error("useImport requires SharedRefs provider in main-webview");
  }
  // 窄化别名：const 初始化取 rvalue 的窄化类型，闭包内不再 possibly undefined
  const shared = sharedRaw;

  async function importToProject(ids: string[]) {
    let r: any;
    try {
      r = await bridge.importToProject({ recordIds: ids });
    } catch (e: any) {
      console.error("[webview] importToProject bridge error:", e);
      opts.showToast(`导入到工程失败(桥调用异常): ${e?.message || e}`);
      return;
    }
    if (r.ok) {
      // 导入前生成结果已被移动到项目旁 Imports/,同步新路径到本地记录
      // (主进程已持久化 records.json,这里更新 UI 状态保持一致,深 watch 会自动落盘相同数据)
      if (r.moved?.length) {
        for (const m of r.moved) {
          const idx = shared.records.value.findIndex((x) => x.id === m.recordId);
          if (idx >= 0 && shared.records.value[idx].workFile !== m.newPath) {
            shared.records.value[idx] = {
              ...shared.records.value[idx],
              workFile: m.newPath,
            };
          }
        }
      }
      const movedCount = r.moved?.length || 0;
      const totalCount = r.imported?.length || 0;
      opts.showToast(
        movedCount > 0
          ? `已导入到 PR 项目 ${totalCount} 个视频(其中 ${movedCount} 个已从生成目录移动到 Imports/)`
          : `已导入到 PR 项目 ${totalCount} 个视频(文件已在 Imports/,无需重复移动)`,
      );
    } else {
      opts.showToast(`导入到工程失败: ${r.error}`);
    }
  }

  return { importToProject };
}