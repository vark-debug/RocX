/**
 * 共享消息协议 + 业务类型定义
 * UXP 端与 WebView 端共用
 */

export type RecordStatus =
  | "pending"
  | "generating"
  | "generated"
  | "imported"
  | "failed";

export type ReferenceType = "reference_video" | "reference_image" | "reference_audio";

/** Provider 模型能力位（用于 UI 按能力隐藏按钮） */
export type VideoGenCapability =
  | "videoGeneration"
  | "promptOptimization"
  | "resolutionUpscale"
  | "imageReference"
  | "videoReference"
  | "audioReference";

/** 上报用途（写入多维表格的 purpose 列） */
export const REPORT_PURPOSE = {
  VIDEO_GEN: "视频生成",
  UPSCALE: "分辨率升级",
  PROMPT_OPT: "提示词优化",
} as const;

export type ReportPurpose =
  (typeof REPORT_PURPOSE)[keyof typeof REPORT_PURPOSE];

/** 通用模型描述符（具体 provider 实现用） */
export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  displayName: string;
  description?: string;
  paramConstraints: VideoParamConstraints;
  capabilities: VideoGenCapability[];
}

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
  /** webview 端标记：是否已被某次生成提交消费；用于清空状态列显示（UI 用，不持久化到磁盘） */
  consumed?: boolean;
  /**
   * webview 端标记：抓帧→PS 路径下的「等待用户点修改完成」状态（UI 用，不持久化到磁盘）。
   * 抓帧后立刻写入，调用方调 bridge.openInPhotoshop 启动 PS；用户在面板上点确认按钮后才
   * 走 uploadReferenceFile，成功后清掉。references 数组本身不持久化，session 断电即丢，
   * 避免刷新/重载场景下静默上传历史 jpg。
   */
  pendingUpload?: boolean;
}

/**
 * 抓素材那一刻的工程归属快照。
 *
 * 归属不再事后推断（曾用「素材父级目录 → 实时活动工程 → 缓存」三层信任层级，
 * 读一次写一次各猜一次，多工程下必然错位），而是在抓取瞬间由 UXP 端
 * 从真实的工程对象直接读出并随抓取结果返回。
 */
export interface CaptureOwner {
  projectGuid: string;
  /** 工程文件的绝对路径（不是目录），落盘按它定位 records JSON */
  projectPath: string;
  projectName?: string;
}

export interface GenerationRecord {
  id: string;
  createdAt: string;
  prompt: string;
  params: {
    model: VideoModel;
    ratio: VideoRatio;
    duration: number;
    resolution: VideoResolution;
    /** 当前记录对应的 provider id；老记录缺失时默认 "minimax" */
    provider?: string;
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
    /** MiniMax API 错误类型（如 insufficient_balance_error），用于失败卡片分主题 */
    errorType?: string;
    /** HTTP status code */
    httpStatus?: number;
  };
  usage?: {
    total_seconds?: number;
    /** LLM 类任务（如提示词优化）的 token 用量，用于按 token 计费 */
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
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
  upgradedFromResolution?: VideoResolution;
  /**
   * 归属工程标识：PR 同一进程可打开多个工程，此字段标识本记录属于哪个工程。
   * - 用于「是否属于当前活动工程」的判定与 UI 归属提示
   * - 与 projectPath 共同构成归属信息：guid 用于判定，path 用于落盘路由
   * - 历史记录缺失时，读取时用外层 ProjectRecords 的同名字段补齐
   */
  projectGuid?: string;
  /** 归属工程的绝对路径：落盘路由依据（写入时不再用「调用瞬间的活动工程路径」） */
  projectPath?: string;
}

export interface PromptOptimization {
  /** 本次优化前的 prompt 文本 */
  originalPrompt: string;
  /** provider 优化后的 prompt 文本(成功时;失败则缺省) */
  optimizedPrompt?: string;
  /** 是否成功(失败时仍落盘,作为失败历史可追溯) */
  success: boolean;
  /** provider id(便于审计未来多 provider 场景) */
  provider: string;
  /** 关联的 references(用户调试时回看哪批素材下做的优化) */
  references: ReferenceItem[];
  /** ISO 时间戳 */
  createdAt: string;
  /** 错误信息(失败时) */
  error?: string;
  /** provider 用量;仅 UI 优化成功时上报飞书用 */
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  /**
   * 归属工程的 guid:落盘路由依据。
   * 优化与生成共用 CaptureContext 锁定值,所以归属在优化完成那一刻就已确定,
   * 不受后续切工程影响(与 GenerationRecord.projectGuid 同义)。
   */
  projectGuid?: string;
  /** 归属工程的绝对路径:落盘路由依据(缺失时回落到当前活动工程,兼容旧数据) */
  projectPath?: string;
}

export interface ProjectRecords {
  projectGuid: string;
  projectPath: string;
  records: GenerationRecord[];
  /** 记录文件落盘位置模式：'primary' = 项目旁；'fallback' = 插件数据目录 */
  storageMode: "primary" | "fallback";
  /**
   * 提示词优化历史(不入 records 数组,不显示在记录列表)。
   * 与生成 records 同盘,共享 primary / fallback 落盘路由;前端轮询时按需加载。
   */
  promptOptimizations?: PromptOptimization[];
}

// ===== 中性命名（推荐新代码使用）=====
export type VideoModel = "MiniMax-H3" | "MiniMax-H3-Max";

export type VideoRatio =
  | "adaptive"
  | "21:9"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16";

export type VideoResolution = "480P" | "768P" | "2K";

export interface VideoParamConstraints {
  resolutions: VideoResolution[];
  durations: number[];
  /** 模型支持的画面比例集（不含 "adaptive" 也可；存在 "adaptive" 表示文生视频场景也可选） */
  ratios: VideoRatio[];
  /** 仅参考模式可选 ratio=adaptive（已废弃，留作兼容：等价于 ratios 包含 "adaptive"） */
  ratioAdaptiveAllowed: boolean;
}

/** MiniMax 当前默认 provider 的参数约束表（兼容旧名） */
export const VIDEO_PARAM_CONSTRAINTS: Record<VideoModel, VideoParamConstraints> = {
  "MiniMax-H3": {
    resolutions: ["768P", "2K"],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
    ratioAdaptiveAllowed: true,
  },
  "MiniMax-H3-Max": {
    resolutions: ["480P", "768P"],
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
    ratioAdaptiveAllowed: true,
  },
};

// ===== MiniMax* 旧名 alias 已删除 (v2 refactor V1.1) =====
// 旧名仅保留在 MiniMaxCreateRequest / MiniMaxCreateResponse / MiniMaxQueryResponse
// 三个历史接口的命名上(V1.2 删除整个接口);字段类型已统一改为 Video* / VIDEO_*。

export interface MiniMaxCreateRequest {
  model: VideoModel;
  prompt: string;
  ratio: VideoRatio;
  duration: number;
  resolution: VideoResolution;
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
export interface UxptoWebviewAPI {
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
  /**
   * 读取指定工程的记录；不传 target 时读实时活动工程。
   * 多工程场景下由调用方（webview 的 projectInfo）指定，保证与写入指向同一工程。
   */
  recordsRead(target?: {
    projectGuid?: string;
    projectPath?: string;
  }): Promise<{
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

  /**
   * 实时探针:试在 primary 路径下写一个临时 .ai-gen-probe.json,返回当前
   * primary 路径实际可写性。webview 端 mount / onProjectChanged 时调一次刷新 ⚠ 提示。
   */
  probePrimary(target?: { projectPath?: string }): Promise<{
    ok: boolean;
    primaryAvailable: boolean;
    error?: string;
  }>;

  /** 弹 FilePicker，选文件 → 校验 → 调用 MiniMax upload */
  pickAndUploadReference(args: { kind: FileKind; providerId?: string }): Promise<{
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
    providerId?: string;
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

  /** 飞书多维表格联动设置（与 API Key 同位置持久化） */
  getFeishuConfig(): Promise<{
    webhookUrl: string;
    token: string;
    editorName: string;
  }>;
  setFeishuConfig(cfg: {
    webhookUrl: string;
    token: string;
    editorName: string;
  }): Promise<{ ok: boolean; error?: string }>;

  /**
   * 生成成功后上报到飞书多维表格 webhook（内部含限流退避重试）
   * purpose 缺省时按记录推断（存在 upgradedFromResolution 即为分辨率升级）
   * skipped=true 表示未配置 webhook 地址（未发请求）
   */
  reportGenerated(
    record: GenerationRecord,
    purpose?: ReportPurpose,
  ): Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
  }>;

  /**
   * 设置页「测试上报」：发送固定样例到 webhook，验证地址 / 令牌 / 字段映射
   * skipped=true 表示未配置 webhook 地址（未发请求）
   */
  testFeishuReport(): Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
  }>;

  /** 把已生成的视频（本地路径）作为参考：返回 ReferenceItem（会走上传） */
  uploadExistingFileAsReference(args: {
    localPath: string;
    fileName: string;
    kind: FileKind;
    providerId?: string;
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
    /** 抓取瞬间的工程归属；无活动工程时为 null */
    owner?: CaptureOwner | null;
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
    /** 抓取瞬间的工程归属；无活动工程时为 null */
    owner?: CaptureOwner | null;
    error?: string;
  }>;

  /**
   * 上传本地文件到 MiniMax（两阶段流程的第二步）
   * filePath 可以是 native path、plugin-data:/...、或 file:// URL
   */
  uploadReferenceFile(args: {
    filePath: string;
    fileName: string;
    providerId?: string;
  }): Promise<{
    ok: boolean;
    fileId?: string;
    uploadedAt?: string;
    error?: string;
  }>;

  /**
   * 拉起 Photoshop 打开指定本地文件（抓帧→PS 路径）。
   * 内部按 C++ Hybrid addon → launcher 脚本 → 系统关联兜底 顺序尝试，
   * `source` 返回实际命中的那条路径，供实机诊断日志使用。
   * 异常一律吞掉转成 {ok:false}，webview 端不据此报错，只 console.warn。
   */
  openInPhotoshop(localPath: string): Promise<{
    ok: boolean;
    source?: "native" | "launcher" | "fallback";
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
    /** 导出视频的像素宽高（用于前端自动按比例填写） */
    width?: number;
    height?: number;
    /** 抓取瞬间的工程归属；无活动工程时为 null */
    owner?: CaptureOwner | null;
    error?: string;
  }>;
}

/** Webview 端通过 bridge 暴露给 UXP 的 API（事件 / 推送） */
export interface WebviewToUxPAPI {
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
