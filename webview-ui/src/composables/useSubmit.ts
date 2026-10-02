/**
 * 提交生成 / 升级 2K / 优化提示词 composable
 *
 * 责任:
 * - submitGenerate(): 校验 capability / 写 pending record / 调 MiniMax createVideo /
 *   dry-run 分支 / 启动轮询
 * - upgradeTo2K(rec): 像素提升 re-create
 * - optimizePrompt(): 异步任务复用 polling_,完成后把 prompt.content 写回 UI
 * - resolveSubmitOwner(): 抓素材时锁定的 CaptureContext 优先,无锁定回落实时活动工程
 *
 * 共享状态从 useInflight 注入(inflight / polling_ / commitInflight / resumePolling),
 * 上报通过外部传入的 callback (reportToFeishu),错误通过 toRecordError 归一化。
 *
 * 不做:不管理 records 防抖落盘(loadRecords 等在 useGenerationState 里);
 * 不管理 inflight 与 pollingActive 派生(都在 useInflight 里)。
 */
import { ref, inject } from "vue";
import { bridge } from "../services/bridge";
import { MiniMaxProvider } from "../providers/minimax";
import { getCaptureContext, lockCaptureContext, resetCaptureContext } from "./useCaptureContext";
import { safeProviderCall } from "./useProviderSafe";
import { SharedRefsKey } from "../providers/state";
import { REPORT_PURPOSE } from "@shared/messages";
import type {
  GenerationRecord,
  VideoRatio,
  ReferenceItem,
  PromptOptimization,
} from "@shared/messages";
import type {
  VideoGenCapability,
  VideoGenCreateRequest,
} from "../providers/core/types";

// ---- 构建时常量：dry-run 调试开关(由 vite.config.ts 的 define 注入) ----
declare const __ROCX_DRY_RUN__: boolean;

type RefAny<T> = { value: T };

export interface UseSubmitInflightApi {
  inflight: Map<string, { record: GenerationRecord; polling: boolean }>;
  polling_: {
    start: (opts: {
      taskId: string;
      apiKey: string;
      onUpdate: (resp: any) => void;
      onTerminal: (resp: any, err?: Error) => void;
      intervalMs?: number;
    }) => Promise<void>;
  };
  commitInflight: (recId: string, patch: Partial<GenerationRecord>) => GenerationRecord | null;
  resumePolling: (rec: GenerationRecord) => void;
  /** 派生 pollingActive(供 optimizePrompt 防并发) */
  pollingActive: RefAny<boolean>;
}

export function useSubmit(opts: {
  /** 不进 SharedRefs 的当前 provider id(useGenerationState 等仍按入参) */
  currentProviderId: RefAny<string>;
  /** provider 中性查找 model 描述 */
  findModelDescriptor: (modelId: string, providerId?: string) => ModelDescriptor | null;
  /** toast */
  showToast: (msg: string | unknown) => void;
  /** 共享 in-flight 表与轮询 */
  inflightApi: UseSubmitInflightApi;
  /** 飞书上报回调(infligh.onTerminalSuccess / optimizePrompt 完成后调用) */
  reportToFeishu: (rec: GenerationRecord, purpose?: any) => void;
  /** 把一次提示词优化结果 push 进持久化数组(不入 records 列表) */
  recordPromptOptimization: (opt: PromptOptimization) => void;
}) {
  const shared = inject(SharedRefsKey);
  if (!shared) {
    throw new Error("useSubmit requires SharedRefs provider in main-webview");
  }
  const { inflightApi } = opts;
  const { inflight, polling_, commitInflight, resumePolling, pollingActive } = inflightApi;
  const optimizingPrompt = ref(false);

  /**
   * 取本次提交应归属的工程。
   *
   * 归属是"赋值"而非"推断"：只要抓过素材,锁定值就在 CaptureContext 里,
   * 一直保持到用户点生成 —— 期间切到哪个工程都不改变它。
   * 纯文生视频(从未抓素材,context 为空)才回落到实时活动工程。
   */
  async function resolveSubmitOwner(): Promise<{
    path: string;
    guid: string;
    name: string;
  } | null> {
    const locked = getCaptureContext();
    if (locked) {
      console.log(
        `[gen] 归属来自抓素材锁定: path=${locked.projectPath} guid=${locked.projectGuid || "-"}`,
      );
      return {
        path: locked.projectPath,
        guid: locked.projectGuid,
        name: locked.projectName,
      };
    }
    // 纯文生视频:没有锁定值,用点击瞬间的实时活动工程
    const live = await bridge.queryProjectState();
    if (live.project?.path) {
      console.log(`[gen] 无锁定归属(纯文生视频),用实时活动工程: ${live.project.path}`);
      return {
        path: live.project.path,
        guid: String(live.project.guid ?? ""),
        name: live.project.name ?? "",
      };
    }
    return null;
  }

  // ---------- 提交生成 ----------
  async function submitGenerate() {
    if (!shared.apiKey.value) return;
    const owner = await resolveSubmitOwner();
    if (!owner || !owner.path) {
      opts.showToast("无活动 PR 项目，无法记录生成历史");
      return;
    }
    // 按 capability 校验当前模型是否支持视频生成(provider 抽象)
    const currentModelDesc = opts.findModelDescriptor(
      shared.model.value,
      opts.currentProviderId.value,
    );
    if (
      !currentModelDesc?.capabilities.includes(
        "videoGeneration" as VideoGenCapability,
      )
    ) {
      opts.showToast("当前模型不支持视频生成");
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // 抓帧→PS 路径下,pendingUpload=true 的 ref 还差 fileId(用户没点修改完成),
    // 不能直接进 MiniMax createVideo(wireFormat 会 throw)。提交前先过滤并 toast 提示。
    const refsForSubmit = shared.references.value.filter((r) => !r.pendingUpload);
    if (refsForSubmit.length < shared.references.value.length) {
      const skipped = shared.references.value.length - refsForSubmit.length;
      opts.showToast(
        `已跳过 ${skipped} 张「✏ PS 中」的参考素材，请先点「修改完成」再生成`,
      );
    }
    const newRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: shared.prompt.value,
      params: {
        model: shared.model.value,
        ratio: shared.ratio.value,
        duration: shared.duration.value,
        resolution: shared.resolution.value,
        provider: opts.currentProviderId.value,
      },
      references: [...refsForSubmit],
      status: "pending",
      submittedAt: now,
      // 归属标记:抓素材时锁定(纯文生视频为点击瞬间的实时活动工程),
      // 任务完成后按此落盘,不受后续切换影响
      projectGuid: owner.guid,
      projectPath: owner.path,
    };
    shared.records.value.unshift(newRec);
    console.log(
      `[gen][submit] 提交生成: record.guid=${newRec.projectGuid || "-"} record.path=${newRec.projectPath || "-"} 归属来源=${getCaptureContext() ? "抓素材锁定" : "实时活动工程"}`,
    );
    shared.prompt.value = "";
    // 一次提交 = 一次完整的输入清空:参考素材 UI 同步置空,
    // 避免下一轮生成误带上本次的参考图/参考视频。
    // 磁盘上的原始文件不受影响(本地路径由 UXP 端管理)。
    shared.references.value = [];
    // 素材列表变空 = 一批素材的边界结束,释放归属锁定。
    // 下一批抓素材会重新锁定(不跨批次继承)。
    resetCaptureContext();
    // 提交成功后 ratio=adaptive 在无 references 时不合法,自动回退到 16:9,
    // 让用户在继续输入 prompt 后「生成」按钮可立即可点。
if (shared.ratio.value === "adaptive") {
      shared.ratio.value = "16:9";
    }

    const mini = new MiniMaxProvider();
    const reqPayload: VideoGenCreateRequest = {
      model: shared.model.value,
      prompt: newRec.prompt,
      ratio: shared.ratio.value,
      duration: shared.duration.value,
      resolution: shared.resolution.value,
      references: newRec.references,
    };
    if (__ROCX_DRY_RUN__) {
      // 调试模式：仅打印请求，不实际发送
      // dry-run 在新 provider 架构下不再构建真实 payload，返回 mock task_id
      const task_id = `dryrun_${Date.now()}`;
      console.log(
        "%c[MiniMax createVideo DRY-RUN]",
        "color:#4b9cf5;font-weight:bold",
        "(provider 架构下 dry-run 不发请求,只返回 mock task_id)",
        JSON.stringify(reqPayload),
      );
      const idx = shared.records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        shared.records.value[idx] = {
          ...shared.records.value[idx],
          taskId: task_id,
          status: "generating",
          // @ts-ignore
          dryRunPayload: null,
        };
      }
      console.log(
        "[MiniMax dry-run] 已写入 record.taskId =",
        task_id,
        "(dry-run 不会真正创建任务,不会启动轮询)",
      );
    } else {
      // 实发模式:用 safeProviderCall 把 throw 转 {ok, error},失败直接写 record.error
      const r = await safeProviderCall(() =>
        mini.createVideo(reqPayload, shared.apiKey.value),
      );
      if (!r.ok) {
        const idx = shared.records.value.findIndex((rec) => rec.id === id);
        if (idx >= 0) {
          shared.records.value[idx] = {
            ...shared.records.value[idx],
            status: "failed",
            error: r.error,
          };
        }
        return;
      }
      const task_id = r.data.taskId;
      const idx = shared.records.value.findIndex((rec) => rec.id === id);
      if (idx >= 0) {
        shared.records.value[idx] = {
          ...shared.records.value[idx],
          taskId: task_id,
          status: "generating",
        };
      }
      resumePolling({ ...newRec, taskId: task_id, status: "generating" });
    }
  }

  // ---------- 升级到 2K ----------
  /**
   * 像素提升:把已生成的 H3 768P 视频提交到 video_regeneration 升级为 2K
   * - 限制:仅 H3 模型 + 768P 可升级(H3-Max 不支持 / 2K 已为最高档)
   * - 实现:创建一条新 record(保留原 768P 不动),记录 parentTaskId + upgradedFromResolution
   * - 复用 resumePolling,等下载完成后再让用户选择导入到工程
   */
  async function upgradeTo2K(rec: GenerationRecord) {
    if (!shared.apiKey.value) {
      opts.showToast("请先在设置里填写 API Key");
      return;
    }
    if (!rec.taskId) {
      opts.showToast("原记录缺少 task_id，无法升级");
      return;
    }
    if (rec.status !== "generated" && rec.status !== "imported") {
      opts.showToast("仅对已生成 / 已导入的视频可以升级");
      return;
    }
    // 按 provider + model 的 capability 判断(不再硬编码 MiniMax-H3)
    const upgradeModelDesc = opts.findModelDescriptor(
      rec.params.model,
      rec.params.provider,
    );
    if (
      !upgradeModelDesc?.capabilities.includes(
        "resolutionUpscale" as VideoGenCapability,
      )
    ) {
      opts.showToast("当前模型不支持像素提升");
      return;
    }
    // 业务规则保留:分辨率升级是 MiniMax 业务规则(768P → 2K)
    if (rec.params.resolution !== "768P") {
      opts.showToast("仅 768P 分辨率可升级到 2K");
      return;
    }
    // 防重复:已经升级过(按 parentTaskId 查)
    const dup = shared.records.value.find(
      (r) => r.parentTaskId === rec.taskId && r.status !== "failed",
    );
    if (dup) {
      opts.showToast("该视频已存在升级任务，正在记录列表中");
      shared.selectedRecordId.value = dup.id;
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const upgradeRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: rec.prompt,
      params: {
        model: rec.params.model,
        ratio: rec.params.ratio,
        duration: rec.params.duration,
        resolution: "2K",
        provider: rec.params.provider || opts.currentProviderId.value,
      },
      references: [...rec.references],
      status: "pending",
      submittedAt: now,
      parentTaskId: rec.taskId,
      upgradedFromResolution: "768P",
      // 归属标记:跟随被升级的原记录。
      // 原记录可能属于其它工程(在飞任务切工程后仍会完成),
      // 此时不应把升级任务记到当前活动工程下。
      projectGuid: rec.projectGuid ?? shared.projectInfo.value?.guid,
      projectPath: rec.projectPath ?? shared.projectInfo.value?.path,
    };
    shared.records.value.unshift(upgradeRec);

    const mini = new MiniMaxProvider();
    const r = await safeProviderCall(() =>
      mini.regenerateVideo!({
        sourceTaskId: rec.taskId,
        resolution: "2K",
        apiKey: shared.apiKey.value,
      }),
    );
    if (!r.ok) {
      const idx = shared.records.value.findIndex((rec) => rec.id === id);
      if (idx >= 0) {
        shared.records.value[idx] = {
          ...shared.records.value[idx],
          status: "failed",
          error: r.error,
        };
      }
      return;
    }
    const task_id = r.data.taskId;
    const idx = shared.records.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      shared.records.value[idx] = {
        ...shared.records.value[idx],
        taskId: task_id,
        status: "generating",
      };
    }
    resumePolling({ ...upgradeRec, taskId: task_id, status: "generating" });
  }

  // ---------- 优化提示词 ----------
  /**
   * 提示词优化(h3_context_ir)
   * - 官方接口是异步任务:POST 返回 { task_id },需 queryTask 轮询,
   *   succeeded 后从 task.content.prompt 取优化后字符串
   * - 限制:仅 H3 模型;prompt 非空;references 中若仍有未上传的 fileId 会被忽略
   * - 行为:成功时直接覆盖填入 prompt 输入框(不创建 record,不计入历史)
   * - ratio:与 createVideo 一致,无 references 时 'adaptive' 不合法,自动回退到 '16:9'
   * - 复用现有 usePolling,与视频生成的轮询代码路径同源(共享 polling_ 实例与在飞登记表)
   */
  async function optimizePrompt() {
    if (!shared.apiKey.value) {
      opts.showToast("请先在设置里填写 API Key");
      return;
    }
    if (!shared.prompt.value.trim()) {
      opts.showToast("请先填写提示词");
      return;
    }
    // 按 provider + model 的 capability 判断(不再硬编码 MiniMax-H3)
    const optimizeModelDesc = opts.findModelDescriptor(
      shared.model.value,
      opts.currentProviderId.value,
    );
    if (
      !optimizeModelDesc?.capabilities.includes(
        "promptOptimization" as VideoGenCapability,
      )
    ) {
      opts.showToast("当前模型不支持提示词优化");
      return;
    }
    if (optimizingPrompt.value) return;
    // 优化任务与视频生成共用在飞登记表:已有任务在飞时拒绝并发提交
    if (pollingActive.value) {
      opts.showToast("有视频生成正在轮询，请稍候再试");
      return;
    }

    // 与 videoGen 落盘路径完全一致:optimizePrompt 第一次调用时主动锁定
    // 当前活动工程到 CaptureContext(first-write-wins,已锁定则跳过),避免后续切工程
    // 导致归属漂移。videoGen 在 captureXxx 时已 lock,optimizePrompt 没那个入口,
    // 这里补上。锁定源标 \"live\"(与 captureXxx 的 \"capture\" 区分,便于 UI 提示)。
    if (!getCaptureContext()) {
      const live = await bridge.queryProjectState();
      if (live.project?.path) {
        lockCaptureContext(
          {
            projectGuid: live.project.guid,
            projectPath: live.project.path,
            projectName: live.project.name,
          },
          "live",
        );
      }
    }

    // 仅取已上传成功的 references(有 fileId 的)
    const validRefs = shared.references.value.filter((r) => !!r.fileId);
    // 与 createVideo 保持一致:无 references 时 ratio=adaptive 不合法
    const ratioArg: VideoRatio =
      validRefs.length === 0 && shared.ratio.value === "adaptive"
        ? "16:9"
        : shared.ratio.value;

    optimizingPrompt.value = true;
    // 优化请求是异步任务(h3_context_ir):polling 期间用 inflight 登记,
    // 不入 records 数组 —— 与 videoGen 行为一致,optimize 完成也不入历史。
    // 飞书上报直接用 record 副本(原 optimizeRec),无需入盘。
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // 归属来源与 submitGenerate 一致:抓素材时锁定的 CaptureContext 优先,否则实时活动工程。
    // 这之前直接 shared.projectInfo.value?.path 在多工程 + 切工程场景下会错位。
    const owner = await resolveSubmitOwner();
    const optimizeRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: shared.prompt.value,
      params: {
        model: shared.model.value,
        ratio: ratioArg,
        duration: shared.duration.value,
        resolution: "768P",
        provider: opts.currentProviderId.value,
      },
      references: [...validRefs],
      status: "pending",
      submittedAt: now,
      // 归属标记:与 videoGenerate 一致走 CaptureContext / 实时活动工程
      projectGuid: owner?.guid,
      projectPath: owner?.path,
    };

    const mini = new MiniMaxProvider();
    const r = await safeProviderCall(() =>
      mini.submitOptimizePrompt!({
        prompt: shared.prompt.value,
        duration: shared.duration.value,
        ratio: ratioArg,
        references: validRefs,
        apiKey: shared.apiKey.value,
      }),
    );
    if (!r.ok) {
      console.error("[webview] optimizePrompt failed:", r.error);
      opts.showToast(`优化失败: ${r.error.message}`);
      optimizingPrompt.value = false;
      return;
    }
    const task_id = r.data.taskId;
    // 不再 unshift 到 shared.records,避免触发 persistRecords 落盘;
    // 优化任务完成后只用 splice 删占位(已优化老表单也无需记录)。
    // inflight 登记仍保留,pollingActive / generating 派生信号源。
    const optimizeRunRec: GenerationRecord = {
      ...optimizeRec,
      taskId: task_id,
      status: "generating",
    };
    inflight.set(id, { record: optimizeRunRec, polling: true });
    polling_.start({
      taskId: task_id,
      apiKey: shared.apiKey.value,
      intervalMs: 3000, // IR 任务通常很快(秒级),3s 轮询体验更好
      onUpdate: (resp) => {
        commitInflight(id, { lastPolledAt: new Date().toISOString() });
      },
      onTerminal: (resp, err) => {
        // 所有分支(含提前 return)都要把该 id 从在飞表摘除
        try {
          if (err) {
            console.error("[webview] optimizePrompt poll error:", err);
            opts.showToast(`优化失败: ${err.message || err}`);
            return;
          }
          if (!resp) {
            opts.showToast("优化失败:查询无响应");
            return;
          }
          if (resp.status === "succeeded") {
            // 优化任务同样消耗额度,无论是否取到 content.prompt 都要上报。
            // 占位记录已被移除,这里带上 usage 供 UXP 端按 token 计费。
            opts.reportToFeishu(
              { ...optimizeRec, usage: resp.usage },
              REPORT_PURPOSE.PROMPT_OPT,
            );
            const optimized = resp.content?.prompt;
            // 落盘优化结果(同盘,不入 records 列表;前端不显示)。
            // 失败也记录(便于审计历史失败请求)。
            opts.recordPromptOptimization({
              originalPrompt: optimizeRec.prompt,
              optimizedPrompt: optimized,
              success: !!optimized,
              provider: opts.currentProviderId.value,
              references: optimizeRec.references,
              createdAt: new Date().toISOString(),
              usage: resp.usage
                ? {
                      total_tokens: resp.usage.total_tokens,
                      prompt_tokens: resp.usage.prompt_tokens,
                      completion_tokens: resp.usage.completion_tokens,
                    }
                  : undefined,
            });
            if (optimized) {
              shared.prompt.value = optimized;
              opts.showToast("提示词已优化");
            } else {
              opts.showToast("优化成功但响应缺 content.prompt");
            }
          } else if (resp.status === "failed" || resp.status === "cancelled") {
            opts.showToast(`优化失败: ${resp.error?.message || resp.status}`);
            // 失败也落盘(便于审计)
            opts.recordPromptOptimization({
              originalPrompt: optimizeRec.prompt,
              success: false,
              provider: opts.currentProviderId.value,
              references: optimizeRec.references,
              createdAt: new Date().toISOString(),
              error: resp.error?.message || resp.status,
            });
          }
          optimizingPrompt.value = false;
        } finally {
          inflight.delete(id);
        }
      },
    });
  }

  return {
    /** 状态 */
    optimizingPrompt,
    /** 行为 */
    submitGenerate,
    upgradeTo2K,
    optimizePrompt,
    resolveSubmitOwner,
  };
}