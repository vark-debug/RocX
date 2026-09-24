/**
 * UXP 端 API 聚合（暴露给 Webview）
 */
import * as premiereproApi from "./premierepro";
import { uxp } from "../globals";
import { notify, getProjectInfo } from "./premierepro";
import { storage } from "../core/storage";
import { projectCore } from "../core/project";
import { recordsCore } from "../core/records";
import { filesCore, detectFileKind, WORK_DIR_NAME } from "../core/files";
import { uploadCore } from "../core/ai/upload";
import { downloadCore } from "../core/ai/download";
import { timelineCore } from "../core/timeline";
import { framesCore } from "../core/frames";
import { captureVideoCore } from "../core/captureVideo";
import { getColorScheme, getUXPInfo, openURL } from "./uxp";

const hostName =
  uxp?.host?.name.toLowerCase().replace(/\s/g, "") || ("" as string);

export const api = {
  notify,
  getProjectInfo,
  getUXPInfo,
  openURL,
  getColorScheme,

  // 桥接扩展
  async echo(message: string): Promise<string> {
    console.log("[UXP echo]", message);
    return `echo: ${message}`;
  },

  async queryProjectState() {
    return await projectCore.queryProjectState();
  },

  async onProjectChanged(
    cb: (p: { path: string; guid: string; name: string } | null) => void,
  ): Promise<() => void> {
    return projectCore.onProjectChanged(cb);
  },

  async emitInitialProjectState() {
    return await projectCore.emitInitial();
  },

  // 记录读写
  async recordsRead() {
    return await recordsCore.read();
  },
  async recordsWrite(data: any) {
    return await recordsCore.write(data);
  },

  // 文件 IO / 上传
  async pickAndUploadReference(args: { kind: "video" | "audio" | "image" }) {
    const apiKey = await storage.getApiKey();
    if (!apiKey) return { ok: false, error: "未配置 MiniMax API Key" };

    const pick = await filesCore.pickAndValidate(args.kind);
    if (!pick.ok || !pick.file) return { ok: false, error: pick.error };

    const uploaded = await uploadCore.uploadFile({
      apiKey,
      fileToken: pick.file,
      fileName: pick.fileName || "ref.bin",
    });
    if (!uploaded.ok || !uploaded.fileId) {
      return { ok: false, error: uploaded.error };
    }

    const refType =
      args.kind === "video"
        ? "reference_video"
        : args.kind === "audio"
        ? "reference_audio"
        : "reference_image";
    return {
      ok: true,
      reference: {
        type: refType as any,
        localPath: pick.nativePath,
        fileId: uploaded.fileId,
        uploadedAt: new Date().toISOString(),
        fileName: pick.fileName,
        sizeBytes: pick.sizeBytes,
      },
    };
  },

  async reuploadReference(args: {
    type: "reference_video" | "reference_image" | "reference_audio";
    localPath: string;
    fileName: string;
    sizeBytes?: number;
  }) {
    const apiKey = await storage.getApiKey();
    if (!apiKey) return { ok: false, error: "未配置 MiniMax API Key" };
    const fileToken = await filesCore.getFileByPath(args.localPath);
    if (!fileToken) return { ok: false, error: "本地文件不可访问，请重新选择" };
    const r = await uploadCore.uploadFile({
      apiKey,
      fileToken,
      fileName: args.fileName,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, fileId: r.fileId };
  },

  async uploadExistingFileAsReference(args: {
    localPath: string;
    fileName: string;
    kind: "video" | "audio" | "image";
  }) {
    const apiKey = await storage.getApiKey();
    if (!apiKey) return { ok: false, error: "未配置 MiniMax API Key" };
    const fileToken = await filesCore.getFileByPath(args.localPath);
    if (!fileToken) return { ok: false, error: "本地文件不可访问" };
    const r = await uploadCore.uploadFile({
      apiKey,
      fileToken,
      fileName: args.fileName,
    });
    if (!r.ok || !r.fileId) return { ok: false, error: r.error };
    const refType =
      args.kind === "video"
        ? "reference_video"
        : args.kind === "audio"
        ? "reference_audio"
        : "reference_image";
    return {
      ok: true,
      reference: {
        type: refType as any,
        localPath: args.localPath,
        fileId: r.fileId,
        uploadedAt: new Date().toISOString(),
        fileName: args.fileName,
        sizeBytes: 0,
      },
    };
  },

  // 下载
  async downloadFile(args: { url: string; suggestedName: string; recordId: string }) {
    const r = await downloadCore.downloadToWorkDir({
      url: args.url,
      suggestedName: args.suggestedName,
    });
    return r;
  },

  // 时间线插入
  async insertToTimeline(args: {
    recordIds: string[];
    sequenceGuid?: string;
    trackIndex?: number;
    insertAtSec?: number;
  }) {
    const cur = await projectCore.getCurrent();
    if (!cur) return { ok: false, error: "无活动项目" };
    // 先拉取 records
    const rec = await recordsCore.read();
    if (!rec.ok || !rec.data) return { ok: false, error: rec.error || "读取记录失败" };
    const r = await timelineCore.importAndInsert(args, rec.data);
    if (r.ok && r.inserted) {
      // 回写状态
      for (const ins of r.inserted) {
        const target = rec.data.records.find((x) => x.id === ins.recordId);
        if (target) {
          target.importedFile = ins.importedFile;
          target.status = "imported";
        }
      }
      await recordsCore.write(rec.data);
    }
    return r;
  },

  /**
   * 把视频导入到 PR 项目（仅 importFiles，不插入时间线）
   *
   * 导入前先把生成结果从 plugin-data:/AI-Generated-Media/ 移动到
   * 项目旁 AI_Generated_Media/Imports/（与生成记录同位置、独立文件夹），
   * 并更新记录中的 workFile 路径后持久化，再拿新路径执行 importFiles。
   */
  async importToProject(args: { recordIds: string[] }) {
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
      const project = await (
        await import("../globals")
      ).premierepro.Project.getActiveProject();
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

  // API Key
  async getApiKey() {
    return await storage.getApiKey();
  },
  async setApiKey(key: string) {
    return await storage.setApiKey(key);
  },

  async toLocalFileUrl(localPath: string) {
    return filesCore.toLocalFileUrl(localPath);
  },

  async readAsDataUrl(fileOrPath: any | string) {
    return await filesCore.readAsDataUrl(fileOrPath);
  },

  async ensureWorkDir() {
    const dir = await filesCore.ensureWorkDir();
    return { ok: !!dir, nativePath: await filesCore.getWorkDirPath() };
  },

  async openWorkDir() {
    return await filesCore.openWorkDir();
  },

  // 调试：检测文件类型
  async detectFileKind(p: string) {
    return detectFileKind(p);
  },

  // 抓取当前 playhead 帧
  async captureActiveFrame(args?: { width?: number; height?: number }) {
    return await framesCore.captureActiveFrame(args);
  },

  // 抓取当前 playhead 帧 + 自动上传 MiniMax，返回 ReferenceItem（含缩略图 dataUrl）
  async captureAndUploadAsReference(args?: { width?: number; height?: number }) {
    return await framesCore.captureAndUploadAsReference(args);
  },

  // 只导出 + 读取缩略图（不传 MiniMax），用于"立即显示 + 后台上传"
  async captureFrameOnlyAsReference(args?: { width?: number; height?: number }) {
    return await framesCore.captureOnlyAsReference(args);
  },

  // 上传 reference 对应的本地文件到 MiniMax
  async uploadReferenceFile(args: { filePath: string; fileName: string }) {
    // 同一个实现用于图片和视频
    return await framesCore.uploadReferenceFile(args);
  },

  // 抓取当前序列工作区（in/out）→ 导出视频 → 上传 MiniMax → 返回 ReferenceItem
  async captureWorkAreaAndUploadAsReference(args?: { exportFull?: boolean }) {
    return await captureVideoCore.captureWorkAreaAndUploadAsReference(args);
  },

  // 只导出视频工作区（不传 MiniMax）
  async captureWorkAreaOnlyAsReference(args?: { exportFull?: boolean }) {
    return await captureVideoCore.captureWorkAreaOnlyAsReference(args);
  },

  // 工作目录名（前端展示用）
  WORK_DIR_NAME,

  // 让 Webview 端可以直接 ping Premiere API（仅暴露必要部分）
  ...(hostName.startsWith("premierepro") ? (premiereproApi as any) : {}),
};

export type API = typeof api;