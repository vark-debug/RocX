/**
 * 共享消息协议 + 业务类型定义
 * UXP 端（src/）与 Webview 端（webview-ui/src/）共用
 */

export type RecordStatus =
  | "pending"
  | "generating"
  | "generated"
  | "imported"
  | "failed";

export type ReferenceType = "reference_video" | "reference_image" | "reference_audio";

export interface ReferenceItem {
  type: ReferenceType;
  localPath: string;
  fileId?: string;
  uploadedAt?: string;
  fileName: string;
  sizeBytes: number;
  /** 仅视频：本地粗略解析得到的时长（秒），用于累加总时长校验 */
  durationSec?: number;
  /** 仅图片：base64 data URL（PNG），由 UXP 端 captureActiveFrame 注入，用于缩略图 */
  thumbDataUrl?: string;
  /** webview 端标记：是否正在上传（UI 用，不持久化到磁盘） */
  uploading?: boolean;
}

export interface GenerationRecord {
  id: string;
  createdAt: string;
  prompt: string;
  params: {
    model: MiniMaxModel;
    ratio: MiniMaxRatio;
    duration: number;
    resolution: MiniMaxResolution;
  };
  references: ReferenceItem[];
  taskId?: string;
  workFile?: string;
  importedFile?: string;
  status: RecordStatus;
  thumb?: string;
  error?: {
    message: string;
    requestId?: string;
  };
  usage?: {
    total_seconds?: number;
  };
  /** 任务首次提交时刻（用于计费恢复的连续轮询） */
  submittedAt?: string;
  /** 最后一次轮询时间戳 */
  lastPolledAt?: string;
  /**
   * 像素提升链路：
   * - parentTaskId：本记录由哪条 taskId 升级而来（即 source_task_id）
   * - upgradedFromResolution：升级前的分辨率（如 '768P'），升级后通常为 '2K'
   * 用于把"原 768P 任务"和"升级出来的 2K 任务"关联起来，避免重复升级 / 重复扣费
   */
  parentTaskId?: string;
  upgradedFromResolution?: MiniMaxResolution;
}

export interface ProjectRecords {
  projectGuid: string;
  projectPath: string;
  records: GenerationRecord[];
  /** 记录文件落盘位置模式：'primary' = 项目旁；'fallback' = 插件数据目录 */
  storageMode: "primary" | "fallback";
}

export type MiniMaxModel = "MiniMax-H3" | "MiniMax-H3-Max";

export type MiniMaxRatio =
  | "adaptive"
  | "21:9"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16";

export type MiniMaxResolution = "480P" | "768P" | "2K";

export interface MiniMaxParamConstraints {
  resolutions: MiniMaxResolution[];
  durations: number[];
  /** 仅参考模式可选 ratio=adaptive */
  ratioAdaptiveAllowed: boolean;
}

export const MINIMAX_PARAM_CONSTRAINTS: Record<MiniMaxModel, MiniMaxParamConstraints> = {
  "MiniMax-H3": {
    resolutions: ["768P", "2K"],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratioAdaptiveAllowed: true,
  },
  "MiniMax-H3-Max": {
    resolutions: ["480P", "768P"],
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratioAdaptiveAllowed: true,
  },
};

export interface MiniMaxCreateRequest {
  model: MiniMaxModel;
  prompt: string;
  ratio: MiniMaxRatio;
  duration: number;
  resolution: MiniMaxResolution;
  references: ReferenceItem[];
}

export interface MiniMaxCreateResponse {
  task_id: string;
}

export interface MiniMaxQueryResponse {
  task_id?: string;
  model?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** 视频生成任务：content.url = 产物 CDN 地址；h3_context_ir 任务：content.prompt = 优化后提示词 */
  content?: { url?: string; prompt?: string };
  error?: { message: string; http_code?: number };
  usage?: { total_seconds?: number };
  resolution?: string;
  duration?: number;
  ratio?: string;
  task_type?: string;
  request_id?: string;
}

export interface MiniMaxUploadResponse {
  file_id: string;
  bytes?: number;
}

export type FileKind = "video" | "audio" | "image";

/** UXP 端通过 bridge 暴露给 Webview 的完整接口 */
export interface BridgeAPI {
  /** Echo 测试 */
  echo(message: string): Promise<string>;

  /** 当前插件 / 宿主 / 版本信息 */
  getUXPInfo(): Promise<{
    version: string;
    hostName: string;
    hostVersion: string;
    pluginId: string;
    pluginVersion: string;
  }>;

  /** 当前 PR 项目信息（含 path / guid / name / 序列列表 / 当前序列）；项目未保存返回 null */
  queryProjectState(): Promise<{
    project: {
      path: string;
      guid: string;
      name: string;
    } | null;
    activeSequenceGuid: string | null;
    sequences: Array<{
      guid: string;
      name: string;
      videoTrackCount: number;
      audioTrackCount: number;
    }>;
  }>;

  /** 主动获取最新主题（启动期 / 调色板刷新） */
  getColorScheme(): Promise<{
    theme: string;
    colors: Record<string, string>;
  }>;

  /** 读取当前 PR 项目对应的记录 JSON（不存在返回空 records） */
  recordsRead(): Promise<{
    ok: boolean;
    data: ProjectRecords | null;
    error?: string;
    fallbackPath?: string;
  }>;

  /** 写回记录 JSON；防抖合并由 UXP 端负责 */
  recordsWrite(data: ProjectRecords): Promise<{
    ok: boolean;
    error?: string;
    storageMode: "primary" | "fallback";
  }>;

  /** 弹 FilePicker，选文件 → 校验 → 调用 MiniMax upload */
  pickAndUploadReference(args: { kind: FileKind }): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    error?: string;
  }>;

  /** 用已存在的本地路径 + 旧 fileId 重新上传（用于 7 天过期刷新） */
  reuploadReference(args: {
    type: ReferenceType;
    localPath: string;
    fileName: string;
    sizeBytes: number;
  }): Promise<{
    ok: boolean;
    fileId?: string;
    error?: string;
  }>;

  /** 下载 MiniMax CDN 结果视频到生成工作目录 */
  downloadFile(args: {
    url: string;
    suggestedName: string;
    recordId: string;
  }): Promise<{
    ok: boolean;
    localPath?: string;
    error?: string;
  }>;

  /** 把指定记录复制到 PR 项目旁并导入 + 插入时间线（事务化） */
  insertToTimeline(args: {
    recordIds: string[];
    sequenceGuid?: string;
    trackIndex?: number;
    insertAtSec?: number;
  }): Promise<{
    ok: boolean;
    inserted?: Array<{
      recordId: string;
      importedFile: string;
      trackItemGuid?: string;
    }>;
    error?: string;
  }>;

  /**
   * 把视频导入到 PR 项目（仅 importFiles，不插入时间线）
   * moved：导入前生成结果被移动到项目旁 Imports/ 后的路径映射
   */
  importToProject(args: { recordIds: string[] }): Promise<{
    ok: boolean;
    imported?: string[];
    moved?: Array<{ recordId: string; newPath: string }>;
    error?: string;
  }>;

  /** 获取 / 设置 API Key（uxp.storage） */
  getApiKey(): Promise<string | null>;
  setApiKey(key: string): Promise<{ ok: boolean; error?: string }>;

  /** 把已生成的视频（本地路径）作为参考：返回 ReferenceItem（会走上传） */
  uploadExistingFileAsReference(args: {
    localPath: string;
    fileName: string;
    kind: FileKind;
  }): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    error?: string;
  }>;

  /** 把本地文件（绝对路径）作为 URL 给 Webview 用（用于 <video> / 缩略图） */
  toLocalFileUrl(localPath: string): Promise<string>;

  /**
   * 把视频 / 图片读成 base64 data URL，给 WebView 直接 <video>/<img src=""> 显示
   * 避免 file:// 被 WebView 拦截。
   */
  readAsDataUrl(
    fileOrPath: any | string,
  ): Promise<{
    ok: boolean;
    dataUrl?: string;
    mime?: string;
    size?: number;
    error?: string;
  }>;

  /** 确保生成工作目录，返回 ok 与 nativePath */
  ensureWorkDir(): Promise<{ ok: boolean; nativePath: string }>;

  /** 用系统文件管理器打开生成工作目录 */
  openWorkDir(): Promise<{ ok: boolean; error?: string }>;

  /** 检测文件归属类型 */
  detectFileKind(p: string): Promise<FileKind | null>;

  /** 获取 PR 项目信息 */
  getProjectInfo(): Promise<{ name: string; path: string; id: string }>;

/**
 * 抓取当前活动序列 playhead 位置的帧（PNG）
 * 返回 imagePath + dataUrl（base64 PNG data URL，方便 webview 直接显示）
 */
  captureActiveFrame(args?: {
    width?: number;
    height?: number;
  }): Promise<{
    ok: boolean;
    imagePath?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
    error?: string;
  }>;

  /**
   * 抓取当前 playhead 帧 + 自动上传 MiniMax + 返回 ReferenceItem（含缩略图 dataUrl）
   */
  captureAndUploadAsReference(args?: {
    width?: number;
    height?: number;
  }): Promise<{
    ok: boolean;
    reference?: ReferenceItem & { thumbDataUrl?: string };
    error?: string;
  }>;

  /**
   * 只导出 + 读取缩略图（不传 MiniMax），用于"立即显示 + 后台上传"两阶段流程
   */
  captureFrameOnlyAsReference(args?: {
    width?: number;
    height?: number;
  }): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    error?: string;
  }>;

  /**
   * 上传本地文件到 MiniMax（两阶段流程的第二步）
   * filePath 可以是 native path、plugin-data:/...、或 file:// URL
   */
  uploadReferenceFile(args: {
    filePath: string;
    fileName: string;
  }): Promise<{
    ok: boolean;
    fileId?: string;
    uploadedAt?: string;
    error?: string;
  }>;

  /**
   * 抓取当前序列工作区（in/out）→ 导出视频 → 上传 MiniMax → 返回 ReferenceItem
   */
  captureWorkAreaAndUploadAsReference(args?: {
    exportFull?: boolean;
  }): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    inSec?: number;
    outSec?: number;
    durationSec?: number;
    error?: string;
  }>;

  /**
   * 只导出视频工作区（不传 MiniMax），用于"立即显示 + 后台上传"两阶段流程
   */
  captureWorkAreaOnlyAsReference(args?: {
    exportFull?: boolean;
  }): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    inSec?: number;
    outSec?: number;
    durationSec?: number;
    error?: string;
  }>;
}

/** Webview 端通过 bridge 暴露给 UXP 的 API（事件 / 推送） */
export interface WebviewAPI {
  /** UXP 端推主题 */
  updateColorScheme(scheme: { theme: string; colors: Record<string, string> }): void;
  /** UXP 端推项目切换 */
  onProjectChanged(project: {
    path: string;
    guid: string;
    name: string;
  } | null): void;
  /** UXP 端推主题变更（与 updateColorScheme 合并即可，保留以备扩展） */
  pingWebview(): string;
}