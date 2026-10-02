/**
 * UXP 端 API 聚合（暴露给 Webview）
 */
import * as premiereproApi from "./premierepro";
import { uxp } from "../globals";
import { notify, getProjectInfo } from "./premierepro";
import { storage } from "../core/storage";
import { webhookCore } from "../core/webhook";
import { projectCore } from "../core/project";
import { recordsCore } from "../core/records";
import { filesCore, detectFileKind, WORK_DIR_NAME } from "../core/files";
import { uploadCore } from "../core/ai/upload";
import { downloadCore } from "../core/ai/download";
import { timelineCore } from "../core/timeline";
import { importCore } from "../core/import";
import { framesCore } from "../core/frames";
import { captureVideoCore } from "../core/captureVideo";
import { getColorScheme, getUXPInfo, openURL } from "./uxp";
import type { GenerationRecord, ReportPurpose } from "@shared/messages";

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
  async recordsRead(target?: { projectGuid?: string; projectPath?: string }) {
    return await recordsCore.read(target);
  },
  /**
   * 实时探针:试写一个 .ai-gen-probe.json,返回当前活动工程 primary 路径实际可写性。
   * webview 端在 mount / onProjectChanged 时调一次,更新 ⚠ 降级 storage 提示。
   */
  async probePrimary(target?: { projectPath?: string }) {
    return recordsCore.probePrimary(target);
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
   * 实际实现见 src/core/import.ts;这里仅委托。
   * 行为包括:移动生成结果到项目旁 Imports/、更新 records.workFile、
   * 落盘校验、执行 PR importFiles。返回 moved 数组供 webview 端同步本地状态。
   */
  async importToProject(args: { recordIds: string[] }) {
    return importCore.importToProject(args);
  },

  // API Key
  async getApiKey() {
    return await storage.getApiKey();
  },
  async setApiKey(key: string) {
    return await storage.setApiKey(key);
  },

  // 飞书多维表格联动
  async getFeishuConfig() {
    return await storage.getFeishuConfig();
  },
  async setFeishuConfig(cfg: {
    webhookUrl: string;
    token: string;
    editorName: string;
  }) {
    return await storage.setFeishuConfig(cfg);
  },
  async reportGenerated(record: GenerationRecord, purpose?: ReportPurpose) {
    return await webhookCore.reportGenerated(record, purpose);
  },
  async testFeishuReport() {
    return await webhookCore.testReport();
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

  // 抓帧→PS：用 C++ Hybrid Plugin 强制命中 PS，失败 fallback 到系统关联
  // 详见 capture-frame-and-open-ps spec + cpp-hybrid-plugin-ps-launch spec
  async openInPhotoshop(localPath: string) {
    return await filesCore.openWithPhotoshopNative(localPath);
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