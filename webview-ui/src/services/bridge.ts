/**
 * Webview 端调用 UXP API 的统一封装
 * initWebview 返回的 api 代理经过 Comlink 直接转发调用
 */
import type { UxptoWebviewAPI, ProjectRecords, FileKind } from "@shared/messages";

let _api: UxptoWebviewAPI | null = null;

export const setBridge = (api: UxptoWebviewAPI) => {
  _api = api;
};

const ensure = (): UxptoWebviewAPI => {
  if (!_api) throw new Error("桥未初始化");
  return _api;
};

export const bridge = {
  echo: (msg: string) => ensure().echo(msg),
  queryProjectState: () => ensure().queryProjectState(),
  getActiveSequenceSize: () => ensure().getActiveSequenceSize(),
  getColorScheme: () => ensure().getColorScheme(),
  recordsRead: (target?: { projectGuid?: string; projectPath?: string }) =>
    ensure().recordsRead(target),
  recordsWrite: (data: ProjectRecords) => ensure().recordsWrite(data),
  probePrimary: (target?: { projectPath?: string }) => ensure().probePrimary(target),
  pickAndUploadReference: (args: { kind: FileKind; providerId?: string }) =>
    ensure().pickAndUploadReference(args),
  reuploadReference: (args: any) => ensure().reuploadReference(args),
  uploadExistingFileAsReference: (args: any) =>
    ensure().uploadExistingFileAsReference(args),
  downloadFile: (args: any) => ensure().downloadFile(args),
  insertToTimeline: (args: any) => ensure().insertToTimeline(args),
  importToProject: (args: any) => ensure().importToProject(args),
  getApiKey: (providerId?: string) => ensure().getApiKey({ providerId }),
  setApiKey: (k: string, providerId?: string) =>
    ensure().setApiKey(k, providerId),
  getFeishuConfig: () => ensure().getFeishuConfig(),
  setFeishuConfig: (cfg: any) => ensure().setFeishuConfig(cfg),
  reportGenerated: (record: any, purpose?: any) =>
    ensure().reportGenerated(record, purpose),
  testFeishuReport: () => ensure().testFeishuReport(),
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
  openInPhotoshop: (p: string) => ensure().openInPhotoshop(p),
  captureWorkAreaAndUploadAsReference: (args?: any) =>
    ensure().captureWorkAreaAndUploadAsReference(args),
  captureWorkAreaOnlyAsReference: (args?: any) =>
    ensure().captureWorkAreaOnlyAsReference(args),
};