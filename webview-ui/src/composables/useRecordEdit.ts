/**
 * 记录 UI 回填 / 删除 composable:retryRecord / deleteRecord
 *
 * 责任:
 * - retryRecord(rec): 把 prompt/params/references 填回生成逻辑 UI;reference file_id 过期(>6 天)
 *   时重新上传;不自动提交,让用户看着 prompt 后手动点「生成」
 * - deleteRecord(id): 从 records 数组过滤掉
 *
 * 与 useRecordActions(RecordsPanel UI 状态)分开:
 * - 本文件管的是"操作 record 本身",与 panel 渲染无关
 * - useRecordActions 管的是 panel 的选中 / 拖拽 / 升级判定
 *
 * 状态注入:从 main-webview.vue 顶层 provide 的 SharedRefsKey 取 9 个高频 ref
 * (apiKey / records / prompt / model / ratio / duration / resolution /
 * references / selectedRecordId)。本 composable 无入参。
 *
 * 不做:不创建提交任务、不入库;纯 UI 回填与本地状态变更。
 */
import { inject } from "vue";
import { bridge } from "../services/bridge";
import { SharedRefsKey } from "../providers/state";
import type { GenerationRecord, ReferenceItem } from "@shared/messages";

const REF_FILE_ID_TTL_MS = 6 * 24 * 3600 * 1000;

export function useRecordEdit() {
  const shared = inject(SharedRefsKey);
  if (!shared) {
    throw new Error("useRecordEdit requires SharedRefs provider in main-webview");
  }

  /** 重试:把 prompt / params / references 全部填回生成逻辑 UI */
  async function retryRecord(rec: GenerationRecord) {
    if (!shared.apiKey.value) return;
    const idx = shared.records.value.findIndex((r) => r.id === rec.id);
    if (idx < 0) return;
    // 以这条记录为底子:把 prompt / params / references 全部填回生成逻辑 UI
    shared.prompt.value = rec.prompt;
    shared.model.value = rec.params.model;
    shared.ratio.value = rec.params.ratio;
    shared.duration.value = rec.params.duration;
    shared.resolution.value = rec.params.resolution;

    // 检查 reference file_id 过期,必要时重新上传拿新 file_id
    let newRefs = rec.references;
    if (newRefs.length > 0) {
      const refreshed: ReferenceItem[] = [];
      for (const ref of newRefs) {
        if (ref.fileId && ref.uploadedAt) {
          const age = Date.now() - new Date(ref.uploadedAt).getTime();
          if (age > REF_FILE_ID_TTL_MS) {
            const r = await bridge.reuploadReference({
              type: ref.type,
              localPath: ref.localPath,
              fileName: ref.fileName,
            });
            if (r.ok && r.fileId) {
              refreshed.push({
                ...ref,
                fileId: r.fileId,
                uploadedAt: new Date().toISOString(),
              });
            } else {
              refreshed.push(ref);
            }
          } else {
            refreshed.push(ref);
          }
        } else {
          refreshed.push(ref);
        }
      }
      newRefs = refreshed;
    }
    shared.references.value = newRefs;

    // 不自动提交,让用户看着填好的 prompt + references 后手动点「生成」
    // 但把记录状态从 failed 还原成 pending,方便观察
    if (idx >= 0) {
      shared.records.value[idx] = {
        ...shared.records.value[idx],
        references: newRefs,
        status:
          shared.records.value[idx].status === "failed"
            ? "pending"
            : shared.records.value[idx].status,
      };
    }
    // 把焦点切到这条记录(提示词输入框自动滚动到视图中)
    shared.selectedRecordId.value = rec.id;
    // 滚到顶部让用户看到 prompt 输入框
    const promptEl = document.querySelector(".prompt-section textarea");
    if (promptEl) (promptEl as HTMLTextAreaElement)?.focus?.();
  }

  /** 从 records 数组中过滤掉指定 id(仅 UI 状态,不影响磁盘) */
  async function deleteRecord(id: string) {
    shared.records.value = shared.records.value.filter((r) => r.id !== id);
  }

  return {
    retryRecord,
    deleteRecord,
  };
}