/**
 * 导入生成结果到 PR 工程(下沉自 api.ts.importToProject)
 *
 * 流程:
 * 1) projectCore.getCurrent() 拿当前活动项目
 * 2) recordsCore.read() 读当前工程 records(按归属读取)
 * 3) filesCore.ensureProjectSubdir(projectDir, "AI-Generated-Media/Imports")
 * 4) 逐条 filesCore.moveFileToDir + 更新 item.workFile
 * 5) recordsCore.write() 持久化新路径
 * 6) waitForFileReady 校验文件已落盘(moved 条目走 waitForFileReadyInFolder)
 * 7) premierepro.Project.importFiles(paths, true)
 *
 * 与 timelineCore 语义不重叠(timelineCore.importAndInsert 是先 importFiles 再插入时间线
 * 这条路径只 importFiles,不做插入)。
 *
 * 错误流:任何异常都转 {ok:false, error} 返回,避免桥端 Promise 挂起、界面无反应。
 */
import { premierepro } from "../globals";
import { projectCore } from "./project";
import { recordsCore } from "./records";
import { filesCore } from "./files";
import { WORK_DIR_NAME } from "./workDir";

export const importCore = {
  /**
   * 把指定 records 对应的生成结果移动到 PR 项目旁 Imports/ 并执行 importFiles。
   *
   * 移动成功时返回 moved:Array<{recordId, newPath}>,webview 端据此同步本地 records
   * 的 workFile(深 watch 自动写回磁盘,无需二次 write)。
   *
   * 移动失败不阻断导入:降级用原路径。仅当移动+落盘校验全部通过才把 records 持久化。
   */
  async importToProject(args: { recordIds: string[] }): Promise<{
    ok: boolean;
    imported?: string[];
    moved?: Array<{ recordId: string; newPath: string }>;
    error?: string;
  }> {
    // 任何异常都转成 {ok:false,error} 返回，避免桥端 Promise 挂起、界面无反应
    try {
      const cur = await projectCore.getCurrent();
      if (!cur) return { ok: false, error: "无活动项目" };
      if (!cur.path) {
        return { ok: false, error: "项目尚未保存，请先保存项目再导入" };
      }
      const rec = await recordsCore.read();
      if (!rec.ok || !rec.data) return { ok: false, error: rec.error || "读取记录失败" };
      const items = args.recordIds
        .map((id) => rec.data!.records.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => !!r);

      console.log(`[importToProject] step1 项目=${cur.path} 待导入=${items.length}`);
      // 1) 确保项目旁 Imports 目录存在
      const projectDir = cur.path.replace(/[\\/][^\\/]+$/, "");
      const dirR = await filesCore.ensureProjectSubdir(
        projectDir,
        `${WORK_DIR_NAME}/Imports`,
      );
      if (!dirR.ok || !dirR.folder || !dirR.dirPath) {
        return {
          ok: false,
          error: `无法创建导入目录（${projectDir}/${WORK_DIR_NAME}/Imports）: ${dirR.error}`,
        };
      }

      console.log(`[importToProject] step2 Imports目录就绪: ${dirR.dirPath}`);
      // 2) 逐条移动生成结果到 Imports/，更新 workFile
      const moved: Array<{ recordId: string; newPath: string }> = [];
      const paths: string[] = [];
      for (const item of items) {
        if (!item.workFile) continue;
        const normalized = item.workFile.replace(/\\/g, "/");
        // 已经在 Imports/ 里的（重复导入）直接用现路径，不重复移动
        if (normalized.includes(`/${WORK_DIR_NAME}/Imports/`)) {
          console.log(
            `[importToProject] already in Imports, skip move: ${item.workFile}`,
          );
          paths.push(item.workFile);
          continue;
        }
        const fileName =
          item.workFile.split(/[\\/]/).pop() || `video-${Date.now()}.mp4`;
        const m = await filesCore.moveFileToDir(
          item.workFile,
          dirR.folder,
          fileName,
        );
        if (!m.ok || !m.newPath) {
          // 移动失败不阻断导入：降级用原路径
          console.warn(
            `[importToProject] move failed (${item.id}), import from original path:`,
            m.error,
          );
          paths.push(item.workFile);
          continue;
        }
        console.log(
          `[importToProject] moved ${item.id}: ${item.workFile} -> ${m.newPath}`,
        );
        item.workFile = m.newPath;
        paths.push(m.newPath);
        moved.push({ recordId: item.id, newPath: m.newPath });
      }
      console.log(`[importToProject] step3 移动完成 moved=${moved.length} paths=${paths.length}`);
      if (paths.length === 0) return { ok: false, error: "无可导入的视频" };

      // 3) 有移动发生时先持久化新路径（再导入，保证 records 与 PR 引用一致）
      if (moved.length > 0) {
        const w = await recordsCore.write(rec.data);
        if (!w.ok) {
          console.warn("[importToProject] records write failed:", w.error);
        }
      }

      console.log(`[importToProject] step4 开始落盘校验: ${JSON.stringify(paths)}`);
      // 4) 时序保证：所有待导入文件必须已真实落盘（UXP moveTo/copy resolve
      //    只代表操作提交，PR importFiles 直接读磁盘路径，必须等文件可见）
      //    moved 条目首选 Folder entry 直查子文件（不走 URL，最可靠）
      for (const p of paths) {
        const fileName = p.split(/[\\/]/).pop() || "";
        const movedItem = moved.find((m) => m.newPath === p);
        let ready: { ok: boolean; error?: string };
        if (movedItem && dirR.folder && fileName) {
          ready = await filesCore.waitForFileReadyInFolder(
            dirR.folder,
            fileName,
            5000,
          );
        } else {
          ready = await filesCore.waitForFileReady(p, 5000);
        }
        if (!ready.ok) {
          console.error("[importToProject]", ready.error);
          return { ok: false, error: ready.error };
        }
      }
      console.log("[importToProject] step5 落盘校验全部通过");
      // 落盘后稍作停顿，给文件系统/PR 媒体缓存留出稳定时间
      await new Promise((r) => setTimeout(r, 200));

      // 5) importFiles
      try {
        const project = await premierepro.Project.getActiveProject();
        if (!project) return { ok: false, error: "无活动项目" };
        const ok = await project.importFiles(paths, true);
        console.log(`[importToProject] step6 importFiles 返回 ${ok}`);
        if (!ok) return { ok: false, error: "importFiles 返回 false" };
        return { ok: true, imported: paths, moved };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    } catch (outer: any) {
      console.error("[importToProject] unexpected error:", outer);
      return { ok: false, error: String(outer?.message || outer) };
    }
  },
};