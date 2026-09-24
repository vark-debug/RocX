/**
 * Webview 端调用 UXP API 的统一封装
 * initWebview 返回的 api 代理经过 Comlink 直接转发调用
 */
import type { BridgeAPI, ProjectRecords, FileKind } from "./messages";

let _api: BridgeAPI | null = null;

export const setBridge = (api: BridgeAPI) => {
  _api = api;
};

const ensure = (): BridgeAPI => {
  if (!_api) throw new Error("桥未初始化");
  return _api;
};

export const bridge = {
  echo: (msg: string) => ensure().echo(msg),
  queryProjectState: () => ensure().queryProjectState(),
  getColorScheme: () => ensure().getColorScheme(),
  recordsRead: () => ensure().recordsRead(),
  recordsWrite: (data: ProjectRecords) => ensure().recordsWrite(data),
  pickAndUploadReference: (kind: FileKind) =>
    ensure().pickAndUploadReference({ kind }),
  reuploadReference: (args: any) => ensure().reuploadReference(args),
  uploadExistingFileAsReference: (args: any) =>
    ensure().uploadExistingFileAsReference(args),
  downloadFile: (args: any) => ensure().downloadFile(args),
  insertToTimeline: (args: any) => ensure().insertToTimeline(args),
  importToProject: (args: any) => ensure().importToProject(args),
  getApiKey: () => ensure().getApiKey(),
  setApiKey: (k: string) => ensure().setApiKey(k),
  toLocalFileUrl: (p: string) => ensure().toLocalFileUrl(p),
  readAsDataUrl: (fileOrPath: any) => ensure().readAsDataUrl(fileOrPath),
  ensureWorkDir: () => ensure().ensureWorkDir(),
  openWorkDir: () => ensure().openWorkDir(),
  detectFileKind: (p: string) => ensure().detectFileKind(p),
  getProjectInfo: () => ensure().getProjectInfo(),
  captureActiveFrame: (args?: any) => ensure().captureActiveFrame(args),
  captureAndUploadAsReference: (args?: any) =>
    ensure().captureAndUploadAsReference(args),
  captureFrameOnlyAsReference: (args?: any) =>
    ensure().captureFrameOnlyAsReference(args),
  uploadReferenceFile: (args: any) => ensure().uploadReferenceFile(args),
  captureWorkAreaAndUploadAsReference: (args?: any) =>
    ensure().captureWorkAreaAndUploadAsReference(args),
  captureWorkAreaOnlyAsReference: (args?: any) =>
    ensure().captureWorkAreaOnlyAsReference(args),
  /** 缩略图（按 recordId 查 plugin-data Thumbs 目录） */
  getThumbUrl: (args: { recordId: string }) => ensure().getThumbUrl(args),
};