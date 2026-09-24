/**
 * Premiere Pro 时间线集成（重写版 - 清晰的 async/sync 边界）
 *
 * 流程：
 *   1) 把生成的文件先 importFiles 到 project root bin（async）
 *   2) 在项目 root bin 中按文件名找到对应 ProjectItem（async）
 *   3) project.lockedAccess + executeTransaction 批量插入（sync）
 */
import { premierepro } from "../globals";
import { filesCore } from "./files";
import type { ProjectRecords } from "./messages";

interface InsertArgs {
  recordIds: string[];
  sequenceGuid?: string;
  trackIndex?: number;
  insertAtSec?: number;
}

interface InsertedItem {
  recordId: string;
  importedFile: string;
  trackItemGuid?: string;
}

async function getProjectOrThrow() {
  const project = await premierepro.Project.getActiveProject();
  if (!project) throw new Error("无活动 PR 项目");
  if (!project.path) {
    throw new Error("项目尚未保存（path 为空），请先保存项目再导入");
  }
  return project;
}

async function getTargetSequence(project: any, guid?: string) {
  const sequences = await project.getSequences();
  if (!sequences || sequences.length === 0) throw new Error("项目无序列");
  if (!guid) {
    const active = await project.getActiveSequence();
    if (!active) throw new Error("无活动序列");
    return active;
  }
  const found = sequences.find((s: any) => String(s.guid) === guid);
  if (!found) throw new Error(`找不到序列 guid=${guid}`);
  return found;
}

async function findImportedItems(
  project: any,
  filePaths: string[],
): Promise<Array<{ path: string; item: any }>> {
  const root = await project.getRootItem();
  // 递归列出所有后代（含子 bin）
  const allItems = await collectAllDescendants(root);
  const byName = new Map<string, any>();
  for (const it of allItems) {
    if (it?.name) byName.set(it.name, it);
  }
  const result: Array<{ path: string; item: any }> = [];
  for (const p of filePaths) {
    const fileName = p.split(/[\\/]/).pop() || "";
    const found = byName.get(fileName);
    if (found) result.push({ path: p, item: found });
  }
  return result;
}

async function collectAllDescendants(root: any): Promise<any[]> {
  const out: any[] = [];
  async function visit(parent: any) {
    let children: any[] = [];
    try {
      children = (await parent.getChildren?.()) || [];
    } catch (e) {
      return;
    }
    for (const c of children) {
      out.push(c);
      // FolderItem.cast 判断
      const folder = (premierepro as any).FolderItem?.cast?.(c);
      if (folder) await visit(c);
    }
  }
  await visit(root);
  return out;
}

export const timelineCore = {
  async importAndInsert(
    args: InsertArgs,
    records: ProjectRecords,
  ): Promise<{
    ok: boolean;
    inserted?: InsertedItem[];
    error?: string;
  }> {
    try {
      const project = await getProjectOrThrow();
      const sequence = await getTargetSequence(project, args.sequenceGuid);

      // 1) 收集待插入记录 + 拷贝到项目旁
      const items = args.recordIds
        .map((id) => records.records.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => !!r);
      if (items.length === 0) return { ok: false, error: "无有效记录" };

      const projectDir = project.path.replace(/[\\/][^\\/]+$/, "");
      const newPaths: string[] = [];
      const importedMap: Array<{ recordId: string; importedFile: string }> = [];
      for (const rec of items) {
        if (!rec.workFile) continue;
        const r = await filesCore.copyToProject(rec.workFile, projectDir);
        if (!r.ok || !r.destPath) {
          return { ok: false, error: `拷贝失败(${rec.id}): ${r.error}` };
        }
        newPaths.push(r.destPath);
        importedMap.push({ recordId: rec.id, importedFile: r.destPath });
      }
      if (newPaths.length === 0) return { ok: false, error: "无可导入文件" };

      // 2) importFiles 到 root bin
      const importOK = await project.importFiles(newPaths, true);
      if (!importOK) return { ok: false, error: "PR importFiles 返回 false" };

      // 3) 在 root bin 中按文件名查找 ProjectItem
      const found = await findImportedItems(project, newPaths);
      if (found.length === 0) {
        return { ok: false, error: "导入后未找到对应 ProjectItem" };
      }

      // 4) 同步：lockedAccess + executeTransaction 批量插入
      const editor = premierepro.SequenceEditor.getEditor(sequence);
      const tickTime = premierepro.TickTime.createWithSeconds(args.insertAtSec ?? 0);
      const videoIdx = args.trackIndex ?? 0;
      const audioIdx = args.trackIndex ?? 0;

      const actions: any[] = [];
      let txError: any = null;

      project.lockedAccess(() => {
        try {
          project.executeTransaction((compoundAction: any) => {
            for (const f of found) {
              try {
                const action = editor.createOverwriteItemAction(
                  f.item,
                  tickTime,
                  videoIdx,
                  audioIdx,
                );
                if (action && typeof compoundAction.addAction === "function") {
                  compoundAction.addAction(action);
                  actions.push(action);
                }
              } catch (e) {
                console.warn("createOverwriteItemAction failed", e);
                txError = txError || e;
              }
            }
          }, "AI 生成插入时间线");
        } catch (e) {
          txError = txError || e;
        }
      });

      if (txError) return { ok: false, error: String(txError?.message || txError) };
      if (actions.length === 0) {
        return { ok: false, error: "未生成任何 Action" };
      }

      const inserted: InsertedItem[] = found.map((f) => ({
        recordId: importedMap.find((m) => m.importedFile === f.path)!.recordId,
        importedFile: f.path,
        trackItemGuid: f.item?.guid ? String(f.item.guid) : undefined,
      }));
      void actions;
      return { ok: true, inserted };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};