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
  | "imageGeneration"
  | "promptOptimization"
  | "resolutionUpscale"
  | "imageReference"
  | "videoReference"
  | "audioReference";

/**
 * 可灵 provider id。
 *
 * UXP 端（billing / webhook 的成本与用途分流）与 Webview 端（provider 注册）
 * 共用同一个常量，避免两侧各写一份字符串导致分流失效。
 */
export const KLING_PROVIDER_ID = "kling";

/**
 * 该 provider 的参考素材是否需要先上传到 provider 自家的文件服务。
 *
 * 可灵走本机 CLI：素材以**本地路径**传给 CLI，由 CLI 自己上传到可灵
 * （CLI 的 resolveFileUrl 会先把本地文件传上去），因此可灵**没有 fileId**，
 * 也不该去调 provider 的上传接口 —— 调了必然失败（"未配置 API Key"）。
 */
export function providerNeedsReferenceUpload(providerId?: string): boolean {
  return providerId !== KLING_PROVIDER_ID;
}

/** 上报用途（写入多维表格的 purpose 列） */
export const REPORT_PURPOSE = {
  VIDEO_GEN: "视频生成",
  UPSCALE: "分辨率升级",
  PROMPT_OPT: "提示词优化",
  IMAGE_GEN: "图片生成",
  /**
   * 可灵视频 / 图片生成。
   *
   * 与上面四项分列的原因不是「谁生成的」，而是**成本口径不同**：
   * 可灵是实扣灵感值（提交即扣、失败不退），其余三家是本地价格表估算的人民币元。
   * 飞书侧按 purpose 区分汇总口径。现有四个值不动。
   */
  KLING_VIDEO_GEN: "可灵视频生成",
  KLING_IMAGE_GEN: "可灵图片生成",
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
  /** fileId 归属的 provider id；缺省视为 legacy 单 provider 时代的默认 provider */
  uploadProvider?: string;
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
  /**
   * 可灵 CDN 直链（预上传产物）。
   *
   * 可灵走本机 CLI：素材以**本地路径**传给 CLI 时，CLI 会在提交命令内部现传 CDN
   * （实测 6-9MB 素材 4-8s），这段时间全落在「点生成 → 显示生成中」的空窗里。
   * 抓素材时后台先传一次拿到直链，提交时直接传 URL —— CLI 的 resolveFileUrl 对 http(s)
   * 是**直通不重传**的，于是空窗从 ~10s 降到 ~2s。
   *
   * 与 fileId 分开存：fileId 语义是「provider 自家文件服务的 id」（与 uploadProvider 绑定），
   * 可灵没有这层服务，直链不能占用该字段，否则会污染 minimax 的换 provider 补传逻辑。
   */
  klingFileUrl?: string;
  /** klingFileUrl 的上传时刻（ISO）—— 用于 TTL 判定，过期则回退本地路径重传 */
  klingUploadedAt?: string;
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
  /** 记录类型：缺省 "video"（老记录兼容）；"image" 为图片生成记录 */
  kind?: "video" | "image";
  params: {
    /** 多 provider 后 model id 由 provider 决定，放宽为 string */
    model: string;
    ratio: VideoRatio;
    duration: number;
    /** 多 provider 后分辨率档位名由 provider 决定，放宽为 string */
    resolution: string;
    /** 当前记录对应的 provider id；老记录缺失时默认 "minimax" */
    provider?: string;
  };
  /**
   * 图片生成记录专属参数（kind === "image" 时使用）。
   * 视频语义的 duration/resolution 对图片无意义，图片的尺寸档位/像素在这里。
   */
  imageParams?: {
    width: number;
    height: number;
    /** 计价档位："1K" | "2K"（由输出像素总数 ≤236 万与否算出，见 billingTierOf） */
    resolution: string;
    /** 输出格式："jpeg" | "png" */
    outputFormat: string;
  };
  references: ReferenceItem[];
  taskId?: string;
  workFile?: string;
  importedFile?: string;
  /** 图片生成（阶段 2A 预览）：结果图 CDN URL（下载/导入在后续阶段） */
  resultUrl?: string;
  status: RecordStatus;
  /**
   * pending 阶段的细分（仅 status === "pending" 时有意义）。
   *
   * 之前 pending 一律显示「排队」，但 pending 里其实包含两段完全不同的等待：
   * 准备素材（CLI 自检 + 素材上传）与提交任务（provider 提交接口）。
   * 拆开显示后，用户能看出到底卡在哪一步。
   * 终态（generating / failed）会清空该字段。
   */
  pendingStage?: "preparing" | "submitting";
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
    /** 可灵 CLI 的实扣灵感值（提交时由服务端返回） */
    credits_consumed?: number;
  };
  /**
   * 本次实扣的灵感值（**仅可灵记录**）。
   *
   * 可灵在提交时即扣费，该值随 generationId 一起返回 —— 是真实扣费额，
   * 不是本地价格表推算的估算值。上报时独立成列，绝不折算成人民币元。
   * 缺失表示「扣费未知」（不是 0 扣费），上报时按 amount=0 + unit=CREDITS 表达。
   */
  creditsConsumed?: number;
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

/** 提示词模板（输入 "/" 唤起；自定义模板上限 10 条） */
export interface PromptTemplate {
  id: string;
  /** 列表里显示的名称 */
  label: string;
  /**
   * 模板正文，支持两种锚定符（仅模板内有效，不进入最终提示词）：
   * - 「甲或乙」模式等效符：视频模式取甲、图片模式取乙（无「或」时原文保留）
   * - {xxx} 光标锚点：插入后光标定位到该处，xxx 作为预填文本全选，打字即覆盖
   */
  template: string;
  /** 适用生成模式 */
  scope: "video" | "image" | "both";
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
//
// ⚠ 这三个类型都**允许 provider 自定义取值**（尾部 `string & {}`）：
//   - model id：可灵的模型清单由服务端动态下发，不能写死成枚举
//   - resolution：可灵用 "720p" / "1080p" / "4k"，与 MiniMax 的 "768P" / "2K" 不是一套
//   - ratio：同理，取值随服务端声明变化
//   尾部的 `string & {}` 保留已知值的字面量自动补全，同时不拒绝未知值。
export type VideoModel = "MiniMax-H3" | "MiniMax-H3-Max" | (string & {});

export type VideoRatio =
  | "adaptive"
  | "21:9"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16"
  | (string & {});

export type VideoResolution = "480P" | "768P" | "2K" | (string & {});

export interface VideoParamConstraints {
  resolutions: VideoResolution[];
  durations: number[];
  /** 模型支持的画面比例集（不含 "adaptive" 也可；存在 "adaptive" 表示文生视频场景也可选） */
  ratios: VideoRatio[];
  /** 仅参考模式可选 ratio=adaptive（已废弃，留作兼容：等价于 ratios 包含 "adaptive"） */
  ratioAdaptiveAllowed: boolean;
}

/**
 * MiniMax 模型的参数约束表（provider 私有，挂在 MiniMaxProvider 的 descriptor 上）。
 *
 * ⚠ 这只是 MiniMax 的**默认值**；运行时 UI 的实际约束以当前 provider 的
 * model descriptor.paramConstraints 为准（可灵的参数由服务端动态下发，不在本表里）。
 */
export const VIDEO_PARAM_CONSTRAINTS: Record<string, VideoParamConstraints> = {
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
  /** ⚠ MiniMax 上传接口的 file_id 是 int64，JSON 里是**数字**。
   *  内部使用前需 String() 归一化（见 MiniMaxUxPProvider.uploadFile）。 */
  file_id: string | number;
  bytes?: number;
}

export type FileKind = "video" | "audio" | "image";

/**
 * 可灵 CLI 调用结果
 *
 * `code` 语义:
 * - `ok`                 成功，data 为 CLI envelope 的 body
 * - `addon_unavailable`  C++ Hybrid addon 不可用（PR 版本过低 / uxpaddon 缺失）
 * - `cli_not_installed`  本机找不到可灵 CLI
 * - `not_logged_in`      CLI 未登录（需 `kling login`）
 * - `bad_output`         stdout 不是合法 JSON（raw 携带原文）
 * - `command_failed`     CLI 正常返回但业务失败（如参数非法）
 * - `timeout`            执行超时被 kill
 */
export type KlingCliCode =
  | "ok"
  | "addon_unavailable"
  | "cli_not_installed"
  | "not_logged_in"
  | "bad_output"
  | "command_failed"
  | "timeout";

export interface KlingCliExecResult {
  ok: boolean;
  code: KlingCliCode;
  /** 解析后的 CLI body（envelope.body） */
  data?: unknown;
  error?: string;
  /** 原始 stdout；解析失败时用于排查 */
  raw?: string;
}

/**
 * 可灵环境自检的持久化快照。
 *
 * 目的：CLI 定位（找 node / npm root / 探测 cli.js）要跑好几次子进程，
 * 首次约 1s+。持久化后二次启动直接读快照渲染 UI，再后台刷新。
 *
 * 非敏感数据（余额 / 会员 / 模型清单），可安全落盘。
 */
export interface KlingEnvSnapshot {
  /** 环境是否可用（CLI 已装 + 已登录 + 模型清单拉到） */
  ready: boolean;
  /** 未就绪的原因 */
  reason?: "cli_not_installed" | "not_logged_in" | "error";
  /** 人话提示 */
  message?: string;
  /** 余额（灵感值），来自 `kling account` */
  credits?: number;
  /** 会员等级（如 SVIP） */
  membershipType?: string;
  /** 会员等级描述（如「铂金会员」） */
  membershipDescription?: string;
  /** 可用模型数量 */
  modelCount?: number;
  /** 充值链接（服务端下发，不硬编码） */
  rechargeUrl?: string;
  /** 上次自检时间（ISO 字符串） */
  checkedAt?: string;
  /**
   * 模型清单快照（who_am_i 的 availableModels 原始结构）。
   * 服务端可能上新/下架模型，持久化只为「启动即有模型可选」，
   * 后台刷新会用新值覆盖。
   */
  catalog?: unknown;
}

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

  /** 活动序列分辨率（序列画布原始像素，不缩放）；无项目/序列返回 null */
  getActiveSequenceSize(): Promise<{ width: number; height: number } | null>;

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
  getApiKey(args?: { providerId?: string }): Promise<string | null>;
  setApiKey(key: string, providerId?: string): Promise<{ ok: boolean; error?: string }>;

  /** 提示词模板：自定义模板读写（全局持久化，上限 10 条，宿主侧负责截断） */
  getPromptTemplates(): Promise<PromptTemplate[]>;
  setPromptTemplates(list: PromptTemplate[]): Promise<{ ok: boolean; error?: string }>;

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
    /** 序列帧尺寸（用于 webview 智能填写画面比例） */
    width?: number;
    height?: number;
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
   * 执行可灵 CLI 命令（经 C++ Hybrid addon 拉起本机 `kling` CLI）。
   *
   * args 为 CLI 子命令 + 参数数组（如 ["who_am_i", "--quiet"]）。
   * 返回解析后的 envelope.body；失败时 code 标明原因。
   *
   * priority：foreground（默认，用户直接感知）/ background（后台预热，
   * 可被前台请求插队 —— 素材预上传用它，避免把「点生成」堵在队列里）。
   */
  klingCliExec(
    args: string[],
    opts?: { timeoutMs?: number; priority?: "foreground" | "background" },
  ): Promise<KlingCliExecResult>;

  /**
   * 读可灵环境自检的持久化快照（无快照时返回 null）。
   *
   * 二次启动先读它渲染 UI，避免每次都跑一遍 CLI 定位（~1s+）。
   */
  getKlingEnvSnapshot(): Promise<KlingEnvSnapshot | null>;

  /** 写可灵环境自检快照（覆盖写） */
  setKlingEnvSnapshot(snapshot: KlingEnvSnapshot): Promise<{ ok: boolean; error?: string }>;

  /** 清空可灵环境快照（用户重置 / 检测环境变更时用） */
  clearKlingEnvSnapshot(): Promise<{ ok: boolean; error?: string }>;

  /**
   * 抓当前序列工作区（in/out）→ 导出视频 → 上传 MiniMax → 返回 ReferenceItem
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
