/**
 * Webview 端 → MiniMax API（参考视频生成 v2 + 文件上传）
 * - 创建/查询任务用 fetch（Webview 层支持 fetch）
 * - 文件上传用 UXP 端代理（multipart 受限）
 */
import type {
  MiniMaxCreateRequest,
  MiniMaxCreateResponse,
  MiniMaxModel,
  MiniMaxQueryResponse,
  MiniMaxRatio,
  MiniMaxResolution,
  ReferenceItem,
  ReferenceType,
} from "@shared/messages";

const CREATE_URL = "https://api.minimax.cn/v2/video_generation";
const QUERY_BASE = "https://api.minimax.cn/v2/query/video_generation";
const REGENERATE_URL = "https://api.minimax.cn/v2/video_regeneration";
const H3_CONTEXT_IR_URL = "https://api.minimax.cn/v2/h3_context_ir";

export class MiniMaxAPI {
  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * 构造创建任务的请求载荷（仅组装，不发送）
   */
  buildCreatePayload(req: MiniMaxCreateRequest): {
    url: string;
    headers: Record<string, string>;
    body: any;
    bodyString: string;
  } {
    const content: any[] = [{ type: "text", text: req.prompt }];
    for (const ref of req.references) {
      if (!ref.fileId) {
        throw new Error("参考素材缺少 fileId，请先上传");
      }
      // 官方格式：url 必须放在对应类型的子对象里
      //   { type: "video_url", video_url: { url: "mm_file://..." }, role: "reference_video" }
      const wireType = refTypeToWireType(ref.type); // "video_url" | "image_url" | "audio_url"
      content.push({
        type: wireType,
        [wireType]: {
          url: `mm_file://${ref.fileId}`,
        },
        role: ref.type,
      });
    }

    const body: any = {
      model: req.model,
      content,
      resolution: req.resolution,
      duration: req.duration,
    };
    if (req.references.length === 0) {
      body.ratio = req.ratio === "adaptive" ? "16:9" : req.ratio;
    } else {
      body.ratio = req.ratio;
    }
    const bodyString = JSON.stringify(body, null, 2);
    // 安全检查：发出去的 body 不应包含任何 base64 data URL
    if (bodyString.includes("data:") && bodyString.includes("base64")) {
      console.warn(
        "[MiniMax] ⚠️ body 包含 base64 data URL！请改用 mm_file://<file_id>",
      );
    }
    console.log(
      "%c[MiniMax buildCreatePayload]",
      "color:#5cb85c;font-weight:bold",
      "\nURL:", CREATE_URL,
      "\nHeaders:", JSON.stringify(this.headers(), null, 2),
      "\nBody:", bodyString,
    );
    return {
      url: CREATE_URL,
      headers: this.headers(),
      body,
      bodyString,
    };
  }

  /**
   * 调试模式：仅打印请求到 UDT 控制台，不实际发送
   */
  async createVideoDryRun(req: MiniMaxCreateRequest): Promise<{
    task_id: string;
    payload: ReturnType<MiniMaxAPI["buildCreatePayload"]>;
  }> {
    const payload = this.buildCreatePayload(req);
    // 同时输出到 console 和 UDT（UDT 会捕获 console.log）
    console.log(
      "%c[MiniMax createVideo DRY-RUN]",
      "color:#4b9cf5;font-weight:bold",
    );
    console.log("URL:", payload.url);
    console.log("Method:", "POST");
    console.log("Headers:", JSON.stringify(payload.headers, null, 2));
    console.log("Body:", payload.bodyString);
    // 返回一个 mock task_id 让 UI 流程能继续（实际不会落库）
    return {
      task_id: `dryrun_${Date.now()}`,
      payload,
    };
  }

  /**
   * 真实发送创建任务
   */
  async createVideo(req: MiniMaxCreateRequest): Promise<MiniMaxCreateResponse> {
    const { url, headers, body } = this.buildCreatePayload(req);
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e: any) {
      throw new MiniMaxError("网络错误: " + String(e?.message || e), {
        httpStatus: 0,
        errorType: "network_error",
      });
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = parseMiniMaxError(t);
      const msg = friendlyErrorMessage(parsed, r.status);
      throw new MiniMaxError(msg, {
        httpStatus: r.status,
        errorType: parsed?.type || "http_error",
        requestId: parsed?.requestId,
      });
    }
    const j = (await r.json()) as MiniMaxCreateResponse & {
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (!j.task_id) {
      throw new MiniMaxError("MiniMax 响应缺少 task_id", {
        errorType: "missing_task_id",
      });
    }
    return { task_id: j.task_id };
  }

  async queryTask(taskId: string): Promise<MiniMaxQueryResponse> {
    const r = await fetch(`${QUERY_BASE}/${taskId}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`MiniMax 查询失败 (${r.status}): ${t.slice(0, 200)}`);
    }
    // 官方响应结构：{ task: { id, status, content: { url }, ... }, request_id, base_resp }
    // 字段在 task 嵌套下，需 unwrap
    const j = (await r.json()) as {
      task?: MiniMaxQueryResponse;
      request_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (j.task) return j.task;
    // fallback：扁平（兼容可能的变体）
    return j as unknown as MiniMaxQueryResponse;
  }

  /**
   * 像素提升（video_regeneration）
   * - 官方接口：POST https://api.minimax.cn/v2/video_regeneration
   * - body: { model: 'MiniMax-H3', source_task_id: string, resolution: '2K' }
   * - 复用 createVideo 的响应解析与错误处理逻辑（task_id + MiniMaxError）
   */
  async regenerateVideo(args: {
    sourceTaskId: string;
    resolution: MiniMaxResolution;
    /** 默认为 'MiniMax-H3'（官方仅 H3 支持） */
    model?: MiniMaxModel;
  }): Promise<MiniMaxCreateResponse> {
    const model = args.model || "MiniMax-H3";
    const body = {
      model,
      source_task_id: args.sourceTaskId,
      resolution: args.resolution,
    };
    const bodyString = JSON.stringify(body, null, 2);
    console.log(
      "%c[MiniMax regenerateVideo]",
      "color:#ffa500;font-weight:bold",
      "\nURL:", REGENERATE_URL,
      "\nHeaders:", JSON.stringify(this.headers(), null, 2),
      "\nBody:", bodyString,
    );
    let r: Response;
    try {
      r = await fetch(REGENERATE_URL, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new MiniMaxError("网络错误: " + String(e?.message || e), {
        httpStatus: 0,
        errorType: "network_error",
      });
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = parseMiniMaxError(t);
      const msg = friendlyErrorMessage(parsed, r.status);
      throw new MiniMaxError(msg, {
        httpStatus: r.status,
        errorType: parsed?.type || "http_error",
        requestId: parsed?.requestId,
      });
    }
    const j = (await r.json()) as MiniMaxCreateResponse & {
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (!j.task_id) {
      throw new MiniMaxError("MiniMax 像素提升响应缺少 task_id", {
        errorType: "missing_task_id",
      });
    }
    return { task_id: j.task_id };
  }

  /**
   * 提交 H3 提示词优化任务（h3_context_ir）
   * - 官方接口：POST https://api.minimax.cn/v2/h3_context_ir
   * - 该接口是**异步任务**：POST 响应只返回 `{ task_id }`，
   *   需要再调用 queryTask 轮询，succeeded 后从 `task.content.prompt` 取优化后提示词
   * - 文生视频（content 仅含 text）时 ratio 必填且不能为 adaptive；
   *   含 references 时 ratio 可选默认 adaptive
   */
  async submitOptimizePrompt(args: {
    prompt: string;
    duration: number;
    ratio: MiniMaxRatio;
    references: ReferenceItem[];
    /** 强制固定 H3（官方仅 H3 支持该 IR 任务） */
    model?: MiniMaxModel;
  }): Promise<MiniMaxCreateResponse> {
    const model = args.model || "MiniMax-H3";

    // 构造 content 数组
    const content: any[] = [{ type: "text", text: args.prompt }];
    for (const ref of args.references) {
      if (!ref.fileId) {
        throw new Error("参考素材缺少 fileId，请先上传");
      }
      const wireType = refTypeToWireType(ref.type);
      content.push({
        type: wireType,
        [wireType]: {
          url: `mm_file://${ref.fileId}`,
        },
        role: ref.type,
      });
    }

    const body: any = {
      model,
      content,
      duration: args.duration,
      ratio: args.ratio,
    };
    const bodyString = JSON.stringify(body, null, 2);
    if (bodyString.includes("data:") && bodyString.includes("base64")) {
      console.warn(
        "[MiniMax] ⚠️ optimizePrompt body 包含 base64 data URL！请改用 mm_file://<file_id>",
      );
    }
    console.log(
      "%c[MiniMax submitOptimizePrompt]",
      "color:#9b59b6;font-weight:bold",
      "\nURL:", H3_CONTEXT_IR_URL,
      "\nHeaders:", JSON.stringify(this.headers(), null, 2),
      "\nBody:", bodyString,
    );

    let r: Response;
    try {
      r = await fetch(H3_CONTEXT_IR_URL, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new MiniMaxError("网络错误: " + String(e?.message || e), {
        httpStatus: 0,
        errorType: "network_error",
      });
    }
    if (!r.ok) {
      const t = await r.text();
      const parsed = parseMiniMaxError(t);
      const msg = friendlyErrorMessage(parsed, r.status);
      throw new MiniMaxError(msg, {
        httpStatus: r.status,
        errorType: parsed?.type || "http_error",
        requestId: parsed?.requestId,
      });
    }
    const j = (await r.json()) as {
      task_id?: string;
      request_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    console.log(
      "%c[MiniMax submitOptimizePrompt RESPONSE]",
      "color:#9b59b6;font-weight:bold",
      JSON.stringify(j, null, 2),
    );
    if (!j.task_id) {
      throw new MiniMaxError("MiniMax 提示词优化响应缺少 task_id", {
        errorType: "missing_task_id",
        requestId: j.request_id,
      });
    }
    return { task_id: j.task_id };
  }
}

function refTypeToWireType(t: ReferenceType): string {
  switch (t) {
    case "reference_video":
      return "video_url";
    case "reference_image":
      return "image_url";
    case "reference_audio":
      return "audio_url";
  }
}

/**
 * 解析 MiniMax 错误响应（OpenAI 风格）
 * { type: "error", error: { type, message, http_code }, request_id }
 */
interface ParsedMiniMaxError {
  type?: string;
  message?: string;
  httpCode?: string;
  requestId?: string;
}
function parseMiniMaxError(raw: string): ParsedMiniMaxError | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.error) {
      return {
        type: j.error.type,
        message: j.error.message,
        httpCode: j.error.http_code,
        requestId: j.request_id,
      };
    }
  } catch {
    // 不是 JSON，原样返回
  }
  return null;
}

/**
 * 把 MiniMax 错误转成 UI 友好的中文提示
 */
function friendlyErrorMessage(
  parsed: ParsedMiniMaxError | null,
  httpStatus: number,
): string {
  const t = parsed?.type;
  if (httpStatus === 402 || t === "insufficient_balance_error") {
    return "余额不足（402）— 请前往 MiniMax 用户中心充值后重试";
  }
  if (httpStatus === 401 || t === "authorized_error") {
    return "鉴权失败（401）— API Key 无效或不正确";
  }
  if (httpStatus === 429 || t === "rate_limit_error") {
    return "触发限流（429）— 请稍后再试";
  }
  if (httpStatus === 422 || t === "unprocessable_entity_error") {
    return "输入涉及敏感内容（422）— 请修改提示词";
  }
  if (httpStatus === 400 || t === "bad_request_error") {
    return `参数错误（400）— ${parsed?.message || "请检查请求参数"}`;
  }
  if (httpStatus === 500 || t === "server_error") {
    return `服务端错误（500）— ${parsed?.message || "请稍后再试"}`;
  }
  if (parsed?.message) {
    return `MiniMax 创建任务失败（${httpStatus}）：${parsed.message}`;
  }
  return `MiniMax 创建任务失败（${httpStatus}）`;
}

/**
 * 自定义错误：携带 HTTP status + 错误类型 + request_id，方便 UI 精准展示
 */
export class MiniMaxError extends Error {
  httpStatus?: number;
  errorType?: string;
  requestId?: string;
  constructor(
    message: string,
    opts: { httpStatus?: number; errorType?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "MiniMaxError";
    this.httpStatus = opts.httpStatus;
    this.errorType = opts.errorType;
    this.requestId = opts.requestId;
  }
}