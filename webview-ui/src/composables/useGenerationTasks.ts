/**
 * 任务生命周期 composable：从 main-webview.vue 抽出
 * - 在飞任务登记表 inflight：与 records 数组解耦，切工程替换 records 时不丢在飞任务
 * - 当前轮询状态：generating / pollingActive（均由 inflight 派生，支持多工程并行）
 * - 提交：submitGenerate（含 __ROCX_DRY_RUN__ 分支；成功启动轮询）
 * - 升级：upgradeTo2K（按 provider + model.capability 决定）
 * - 重试：retryRecord（把 prompt / params / references 填回 UI；必要时重新上传 reference）
 * - 优化：optimizePrompt（IR 任务，复用 polling_ 单例）
 * - 其它：importToProject / deleteRecord
 *
 * 行为与原 main-webview.vue 完全一致。
 */
import { computed, ref, shallowReactive } from "vue";
import { bridge } from "../services/bridge";
import { MiniMaxAPI, MiniMaxError } from "../services/MiniMax";
import { usePolling } from "./usePolling";
import { getCaptureContext, resetCaptureContext } from "./useCaptureContext";
import {
  REPORT_PURPOSE,
  type GenerationRecord,
  type MiniMaxModel,
  type MiniMaxRatio,
  type MiniMaxResolution,
  type ReferenceItem,
  type ReportPurpose,
} from "@shared/messages";
import type { VideoGenCapability, ModelDescriptor } from "../providers/core/types";

// ---- 构建时常量：dry-run 调试开关（由 vite.config.ts 的 define 注入） ----
declare const __ROCX_DRY_RUN__: boolean;

type RefAny<T> = { value: T };

export function useGenerationTasks(opts: {
  apiKey: RefAny<string | null>;
  records: RefAny<GenerationRecord[]>;
  prompt: RefAny<string>;
  model: RefAny<MiniMaxModel>;
  ratio: RefAny<MiniMaxRatio>;
  duration: RefAny<number>;
  resolution: RefAny<MiniMaxResolution>;
  references: RefAny<ReferenceItem[]>;
  projectInfo: RefAny<{ path: string; guid: string; name: string } | null>;
  currentProviderId: RefAny<string>;
  /** 选中记录（retryRecord 切焦点用） */
  selectedRecordId: RefAny<string | null>;
  /** provider 中性查找 model 描述 */
  findModelDescriptor: (modelId: string, providerId?: string) => ModelDescriptor | null;
  /** toast */
  showToast: (msg: string | unknown) => void;
}) {
  const optimizingPrompt = ref(false);

  /**
   * 在飞任务登记表：recordId -> 归属信息。与 records 数组解耦，
   * 切工程导致 records 被替换时不影响这里的任务追踪。
   * shallowReactive：set/delete 会触发下面的 computed 重算（普通 Map 变更不被追踪）。
   */
  const inflight = shallowReactive(
    new Map<string, { record: GenerationRecord; polling: boolean }>(),
  );

  const polling_ = usePolling();

  /** 记录是否属于指定工程：优先用 guid 判定，缺 guid 时退回 path */
  function belongsTo(
    rec: GenerationRecord,
    info: { path: string; guid: string } | null,
  ): boolean {
    if (!info) return false;
    if (info.guid) return rec.projectGuid === info.guid;
    return rec.projectPath === info.path;
  }

  /** 在飞任务里是否已有该记录且仍在轮询（用于防重复 start 同一 taskId） */
  function isPolling(recordId: string): boolean {
    return inflight.get(recordId)?.polling === true;
  }

  /** 对外查询：当前所有在飞任务的记录副本（权威状态） */
  function getInflightRecords(): GenerationRecord[] {
    return Array.from(inflight.values()).map((e) => e.record);
  }

  /**
   * 派生：当前活动工程里正在 generating 的那条在飞记录（状态面板用）。
   * 优先当前工程的，其次任意一条在飞记录。
   */
  const generating = computed<GenerationRecord | null>(() => {
    const list = getInflightRecords();
    const cur = opts.projectInfo.value;
    return (
      list.find((r) => r.status === "generating" && belongsTo(r, cur)) ??
      list.find((r) => r.status === "generating") ??
      null
    );
  });

  /** 派生：还有任意任务在轮询（= 在飞登记表非空） */
  const pollingActive = computed(() => inflight.size > 0);

  // ---------- 错误归一化 ----------
  function toRecordError(e: any) {
    if (e instanceof MiniMaxError) {
      return {
        message: e.message,
        requestId: e.requestId,
        httpStatus: e.httpStatus,
        errorType: e.errorType,
      };
    }
    return { message: String(e?.message || e) };
  }

  // ---------- 飞书多维表格上报 ----------
  /**
   * 把已生成记录推送到飞书多维表格。
   * 全程不阻塞：桥调用 / 限流重试都在后台完成，失败仅 toast 提示。
   * purpose 缺省时由 UXP 端按记录推断（升级任务带 upgradedFromResolution）。
   */
  function reportToFeishu(rec: GenerationRecord, purpose?: ReportPurpose) {
    bridge
      .reportGenerated(rec, purpose)
      .then((r) => {
        // skipped = 未配置 webhook 地址，属于正常情况，静默
        if (!r.ok && !r.skipped) opts.showToast(`飞书上报失败: ${r.error}`);
      })
      .catch((e: any) => {
        opts.showToast(`飞书上报失败（桥调用异常）: ${e?.message || e}`);
      });
  }

  // ---------- 轮询 ----------
  /**
   * 把权威 record 副本同步进 records 数组。
   * 切工程时 records 数组会被整体替换，旧工程记录可能已不在其中 —— 此时静默跳过，
   * 权威状态仍保留在 inflight 里，不会丢。
   */
  function syncToRecords(next: GenerationRecord) {
    const idx = opts.records.value.findIndex((r) => r.id === next.id);
    if (idx < 0) return;
    const cur = opts.records.value[idx];
    // 同一 id 但归属工程不一致：防御性判断，避免误改别的工程的记录
    if (
      (cur.projectGuid ?? "") !== (next.projectGuid ?? "") ||
      (cur.projectPath ?? "") !== (next.projectPath ?? "")
    ) {
      return;
    }
    opts.records.value[idx] = { ...cur, ...next };
  }

  /** 更新在飞登记表里的权威 record 副本（先），再尽力同步到 records 数组（后） */
  function commitInflight(recId: string, patch: Partial<GenerationRecord>) {
    const entry = inflight.get(recId);
    if (!entry) return null;
    const next = { ...entry.record, ...patch };
    inflight.set(recId, { ...entry, record: next });
    syncToRecords(next);
    return next;
  }

  function resumePolling(rec: GenerationRecord) {
    if (!rec.taskId || !opts.apiKey.value) return;
    // 防重复启动：同一 taskId 已在轮询就不再 start
    // （loadRecords 的故障恢复与 onTerminal 的 resumeNextGenerating 都会调进来）
    if (isPolling(rec.id)) return;
    // 登记进在飞任务表（已存在则更新为最新 record 副本）
    const prev = inflight.get(rec.id);
    inflight.set(rec.id, {
      record: prev ? { ...prev.record, ...rec } : rec,
      polling: true,
    });
    polling_
      .start({
        taskId: rec.taskId,
        apiKey: opts.apiKey.value,
        onUpdate: (resp) => {
          commitInflight(rec.id, {
            lastPolledAt: new Date().toISOString(),
            usage: resp.usage,
          });
        },
        onTerminal: async (resp, err) => {
          // 终态只需执行一次：无论走哪个分支（含异常路径）都必须从在飞表摘除，
          // 否则该 record 会永远留在 inflight 里，pollingActive 永远为 true
          try {
            if (!resp) {
              commitInflight(rec.id, {
                status: "failed",
                error: { message: err?.message || "查询失败" },
              });
              return;
            }
            if (resp.status === "succeeded" && resp.content?.url) {
              // 先经 Comlink 桥调 UXP 端下载到 plugin-data 工作目录，成功后才更新 UI 状态
              const fileName = `${rec.id}.mp4`;
              const dl = await bridge.downloadFile({
                url: resp.content.url,
                suggestedName: fileName,
                recordId: rec.id,
              });
              if (dl.ok && dl.localPath) {
                const done = commitInflight(rec.id, {
                  status: "generated",
                  workFile: dl.localPath,
                  usage: resp.usage,
                });
                // 上报飞书多维表格：fire-and-forget，不阻塞后续轮询恢复
                if (done) reportToFeishu(done);
              } else {
                commitInflight(rec.id, {
                  status: "failed",
                  error: { message: `下载失败: ${dl.error}` },
                });
              }
            } else if (resp.status === "succeeded") {
              // 极端情况：任务成功但响应缺 url —— 明确标记失败，避免永远卡在 generating
              console.error(
                "[webview] succeeded 但缺少 content.url:",
                JSON.stringify(resp).slice(0, 300),
              );
              commitInflight(rec.id, {
                status: "failed",
                error: {
                  message: "任务成功但响应缺少下载地址（content.url 为空）",
                  requestId: resp.request_id,
                },
              });
            } else if (resp.status === "failed" || resp.status === "cancelled") {
              commitInflight(rec.id, {
                status: "failed",
                error: {
                  message: resp.error?.message || "生成失败",
                  requestId: resp.request_id,
                },
              });
            }
          } finally {
            inflight.delete(rec.id);
            // 本任务结束：把其余还处于 generating 的记录（可能属于别的工程）恢复轮询
            resumeNextGenerating();
          }
        },
      });
  }

  /**
   * 对所有还处于 generating 且有 taskId 的任务各自恢复轮询（多任务并行，无排队）。
   *
   * 数据源必须是 inflight 表而不是 records 数组：切工程时 records 会被整体替换成
   * 新工程的记录，其它工程的在飞任务可能已不在其中，遍历 records 会漏掉它们，
   * 导致任务永久卡在 generating。inflight 里存的是权威副本，与 records 是否
   * 还持有该记录无关。
   */
  function resumeNextGenerating() {
    for (const rec of getInflightRecords()) {
      if (rec.status === "generating" && rec.taskId) resumePolling(rec);
    }
  }

  // ---------- 工程归属：消费抓素材时锁定的 CaptureContext ----------
  /**
   * 取本次提交应归属的工程。
   *
   * 归属是「赋值」而非「推断」：只要抓过素材，锁定值就在 CaptureContext 里，
   * 一直保持到用户点生成 —— 期间切到哪个工程都不改变它。
   * 纯文生视频（从未抓素材，context 为空）才回落到实时活动工程。
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
    // 纯文生视频：没有锁定值，用点击瞬间的实时活动工程
    const live = await bridge.queryProjectState();
    if (live.project?.path) {
      console.log(`[gen] 无锁定归属（纯文生视频），用实时活动工程: ${live.project.path}`);
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
    if (!opts.apiKey.value) return;
    const owner = await resolveSubmitOwner();
    if (!owner || !owner.path) {
      opts.showToast("无活动 PR 项目，无法记录生成历史");
      return;
    }
    // 按 capability 校验当前模型是否支持视频生成（provider 抽象）
    const currentModelDesc = opts.findModelDescriptor(
      opts.model.value,
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
    // 抓帧→PS 路径下，pendingUpload=true 的 ref 还差 fileId（用户没点修改完成），
    // 不能直接进 MiniMax createVideo（wireFormat 会 throw）。提交前先过滤并 toast 提示。
    const refsForSubmit = opts.references.value.filter((r) => !r.pendingUpload);
    if (refsForSubmit.length < opts.references.value.length) {
      const skipped = opts.references.value.length - refsForSubmit.length;
      opts.showToast(
        `已跳过 ${skipped} 张「✏ PS 中」的参考素材，请先点「修改完成」再生成`,
      );
    }
    const newRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: opts.prompt.value,
      params: {
        model: opts.model.value,
        ratio: opts.ratio.value,
        duration: opts.duration.value,
        resolution: opts.resolution.value,
        provider: opts.currentProviderId.value,
      },
      references: [...refsForSubmit],
      status: "pending",
      submittedAt: now,
      // 归属标记：抓素材时锁定（纯文生视频为点击瞬间的实时活动工程），
      // 任务完成后按此落盘，不受后续切换影响
      projectGuid: owner.guid,
      projectPath: owner.path,
    };
    opts.records.value.unshift(newRec);
    console.log(
      `[gen][submit] 提交生成: record.guid=${newRec.projectGuid || "-"} record.path=${newRec.projectPath || "-"} 归属来源=${getCaptureContext() ? "抓素材锁定" : "实时活动工程"}`,
    );
    opts.prompt.value = "";
    // 一次提交 = 一次完整的输入清空:参考素材 UI 同步置空,
    // 避免下一轮生成误带上本次的参考图/参考视频。
    // 磁盘上的原始文件不受影响(本地路径由 UXP 端管理)。
    opts.references.value = [];
    // 素材列表变空 = 一批素材的边界结束，释放归属锁定。
    // 下一批抓素材会重新锁定（不跨批次继承）。
    resetCaptureContext();
    // 提交成功后 ratio=adaptive 在无 references 时不合法,自动回退到 16:9,
    // 让用户在继续输入 prompt 后「生成」按钮可立即可点。
    if (opts.ratio.value === "adaptive") {
      opts.ratio.value = "16:9";
    }

    try {
      const mini = new MiniMaxAPI(opts.apiKey.value);
      const reqPayload = {
        model: opts.model.value,
        prompt: newRec.prompt,
        ratio: opts.ratio.value,
        duration: opts.duration.value,
        resolution: opts.resolution.value,
        references: newRec.references,
      };
      if (__ROCX_DRY_RUN__) {
        // 调试模式：仅打印请求，不实际发送
        const { task_id, payload } = await mini.createVideoDryRun(reqPayload);
        const idx = opts.records.value.findIndex((r) => r.id === id);
        if (idx >= 0) {
          opts.records.value[idx] = {
            ...opts.records.value[idx],
            taskId: task_id,
            status: "generating",
            // @ts-ignore
            dryRunPayload: payload,
          };
        }
        console.log(
          "[MiniMax dry-run] 已写入 record.taskId =",
          task_id,
          "（dry-run 不会真正创建任务，不会启动轮询）",
        );
      } else {
        // 实发模式
        const { task_id } = await mini.createVideo(reqPayload);
        const idx = opts.records.value.findIndex((r) => r.id === id);
        if (idx >= 0) {
          opts.records.value[idx] = {
            ...opts.records.value[idx],
            taskId: task_id,
            status: "generating",
          };
        }
        resumePolling({ ...newRec, taskId: task_id, status: "generating" });
      }
    } catch (e: any) {
      const idx = opts.records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        opts.records.value[idx] = {
          ...opts.records.value[idx],
          status: "failed",
          error: toRecordError(e),
        };
      }
    }
  }

  // ---------- 升级到 2K ----------
  /**
   * 像素提升：把已生成的 H3 768P 视频提交到 video_regeneration 升级为 2K
   * - 限制：仅 H3 模型 + 768P 可升级（H3-Max 不支持 / 2K 已为最高档）
   * - 实现：创建一条新 record（保留原 768P 不动），记录 parentTaskId + upgradedFromResolution
   * - 复用 resumePolling，等下载完成后再让用户选择导入到工程
   */
  async function upgradeTo2K(rec: GenerationRecord) {
    if (!opts.apiKey.value) {
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
    // 按 provider + model 的 capability 判断（不再硬编码 MiniMax-H3）
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
    // 业务规则保留：分辨率升级是 MiniMax 业务规则（768P → 2K）
    if (rec.params.resolution !== "768P") {
      opts.showToast("仅 768P 分辨率可升级到 2K");
      return;
    }
    // 防重复：已经升级过（按 parentTaskId 查）
    const dup = opts.records.value.find(
      (r) => r.parentTaskId === rec.taskId && r.status !== "failed",
    );
    if (dup) {
      opts.showToast("该视频已存在升级任务，正在记录列表中");
      opts.selectedRecordId.value = dup.id;
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
      // 归属标记：跟随被升级的原记录。
      // 原记录可能属于其它工程（在飞任务切工程后仍会完成），
      // 此时不应把升级任务记到当前活动工程下。
      projectGuid: rec.projectGuid ?? opts.projectInfo.value?.guid,
      projectPath: rec.projectPath ?? opts.projectInfo.value?.path,
    };
    opts.records.value.unshift(upgradeRec);

    try {
      const mini = new MiniMaxAPI(opts.apiKey.value);
      const { task_id } = await mini.regenerateVideo({
        sourceTaskId: rec.taskId,
        resolution: "2K",
      });
      const idx = opts.records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        opts.records.value[idx] = {
          ...opts.records.value[idx],
          taskId: task_id,
          status: "generating",
        };
      }
      resumePolling({ ...upgradeRec, taskId: task_id, status: "generating" });
    } catch (e: any) {
      const idx = opts.records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        opts.records.value[idx] = {
          ...opts.records.value[idx],
          status: "failed",
          error: toRecordError(e),
        };
      }
    }
  }

  // ---------- 重试 ----------
  async function retryRecord(rec: GenerationRecord) {
    if (!opts.apiKey.value) return;
    const idx = opts.records.value.findIndex((r) => r.id === rec.id);
    if (idx < 0) return;
    // 以这条记录为底子：把 prompt / params / references 全部填回生成逻辑 UI
    opts.prompt.value = rec.prompt;
    opts.model.value = rec.params.model;
    opts.ratio.value = rec.params.ratio;
    opts.duration.value = rec.params.duration;
    opts.resolution.value = rec.params.resolution;

    // 检查 reference file_id 过期，必要时重新上传拿新 file_id
    let newRefs = rec.references;
    if (newRefs.length > 0) {
      const refreshed: ReferenceItem[] = [];
      for (const ref of newRefs) {
        if (ref.fileId && ref.uploadedAt) {
          const age = Date.now() - new Date(ref.uploadedAt).getTime();
          if (age > 6 * 24 * 3600 * 1000) {
            const r = await bridge.reuploadReference({
              type: ref.type,
              localPath: ref.localPath,
              fileName: ref.fileName,
            });
            if (r.ok && r.fileId) {
              refreshed.push({
                ...ref,
                fileId: r.fileId,
                uploadedAt: new Date().toISOString(),
              });
            } else {
              refreshed.push(ref);
            }
          } else {
            refreshed.push(ref);
          }
        } else {
          refreshed.push(ref);
        }
      }
      newRefs = refreshed;
    }
    opts.references.value = newRefs;

    // 不自动提交，让用户看着填好的 prompt + references 后手动点「生成」
    // 但把记录状态从 failed 还原成 pending，方便观察
    if (idx >= 0) {
      opts.records.value[idx] = {
        ...opts.records.value[idx],
        references: newRefs,
        status:
          opts.records.value[idx].status === "failed"
            ? "pending"
            : opts.records.value[idx].status,
      };
    }
    // 把焦点切到这条记录（提示词输入框自动滚动到视图中）
    opts.selectedRecordId.value = rec.id;
    // 滚到顶部让用户看到 prompt 输入框
    const promptEl = document.querySelector(".prompt-section textarea");
    if (promptEl) (promptEl as HTMLTextAreaElement)?.focus?.();
  }

  // ---------- 优化提示词 ----------
  /**
   * 提示词优化（h3_context_ir）
   * - 官方接口是异步任务：POST 返回 { task_id }，需 queryTask 轮询，
   *   succeeded 后从 task.content.prompt 取优化后字符串
   * - 限制：仅 H3 模型；prompt 非空；references 中若仍有未上传的 fileId 会被忽略
   * - 行为：成功时直接覆盖填入 prompt 输入框（不创建 record，不计费入库）
   * - ratio：与 createVideo 一致，无 references 时 'adaptive' 不合法，自动回退到 '16:9'
   * - 复用现有 usePolling，与视频生成的轮询代码路径同源（共享 polling_ 实例与在飞登记表）
   */
  async function optimizePrompt() {
    if (!opts.apiKey.value) {
      opts.showToast("请先在设置里填写 API Key");
      return;
    }
    if (!opts.prompt.value.trim()) {
      opts.showToast("请先填写提示词");
      return;
    }
    // 按 provider + model 的 capability 判断（不再硬编码 MiniMax-H3）
    const optimizeModelDesc = opts.findModelDescriptor(
      opts.model.value,
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
    // 优化任务与视频生成共用在飞登记表：已有任务在飞时拒绝并发提交
    if (pollingActive.value) {
      opts.showToast("有视频生成正在轮询，请稍候再试");
      return;
    }

    // 仅取已上传成功的 references（有 fileId 的）
    const validRefs = opts.references.value.filter((r) => !!r.fileId);
    // 与 createVideo 保持一致：无 references 时 ratio=adaptive 不合法
    const ratioArg: MiniMaxRatio =
      validRefs.length === 0 && opts.ratio.value === "adaptive"
        ? "16:9"
        : opts.ratio.value;

    optimizingPrompt.value = true;
    // 优化请求是异步任务（h3_context_ir）：用一个临时 record 占位，
    // 让 polling_ 的状态机正常运转；完成后把 prompt.content 写回 UI。
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimizeRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: opts.prompt.value,
      params: {
        model: opts.model.value,
        ratio: ratioArg,
        duration: opts.duration.value,
        resolution: "768P",
        provider: opts.currentProviderId.value,
      },
      references: [...validRefs],
      status: "pending",
      submittedAt: now,
      // 归属标记：占位 record 同样带上，落盘按归属路由
      projectGuid: opts.projectInfo.value?.guid,
      projectPath: opts.projectInfo.value?.path,
    };

    try {
      const mini = new MiniMaxAPI(opts.apiKey.value);
      const { task_id } = await mini.submitOptimizePrompt({
        prompt: opts.prompt.value,
        duration: opts.duration.value,
        ratio: ratioArg,
        references: validRefs,
      });
      // 占位 record 写入 records，便于统一走 polling 流；status 始终为 'generating'
      const optimizeRunRec: GenerationRecord = {
        ...optimizeRec,
        taskId: task_id,
        status: "generating",
      };
      opts.records.value.unshift(optimizeRunRec);
      // 登记进在飞任务表（generating / pollingActive 由它派生）
      inflight.set(id, { record: optimizeRunRec, polling: true });
      polling_.start({
        taskId: task_id,
        apiKey: opts.apiKey.value,
        intervalMs: 3000, // IR 任务通常很快（秒级），3s 轮询体验更好
        onUpdate: (resp) => {
          commitInflight(id, { lastPolledAt: new Date().toISOString() });
        },
        onTerminal: (resp, err) => {
          // 所有分支（含提前 return）都要把该 id 从在飞表摘除
          try {
            const idx = opts.records.value.findIndex((r) => r.id === id);
            if (idx >= 0) {
              // 删除占位 record（用户不需要在历史里看到一条"优化任务"）
              opts.records.value.splice(idx, 1);
            }
            if (err) {
              console.error("[webview] optimizePrompt poll error:", err);
              opts.showToast(`优化失败: ${err.message || err}`);
              return;
            }
            if (!resp) {
              opts.showToast("优化失败：查询无响应");
              return;
            }
            if (resp.status === "succeeded") {
              // 优化任务同样消耗额度，无论是否取到 content.prompt 都要上报。
              // 占位记录已被移除，这里带上 usage 供 UXP 端按 token 计费。
              reportToFeishu(
                { ...optimizeRec, usage: resp.usage },
                REPORT_PURPOSE.PROMPT_OPT,
              );
              const optimized = resp.content?.prompt;
              if (optimized) {
                opts.prompt.value = optimized;
                opts.showToast("提示词已优化");
              } else {
                opts.showToast("优化成功但响应缺 content.prompt");
              }
            } else if (resp.status === "failed" || resp.status === "cancelled") {
              opts.showToast(`优化失败: ${resp.error?.message || resp.status}`);
            }
            optimizingPrompt.value = false;
          } finally {
            inflight.delete(id);
          }
        },
      });
    } catch (e: any) {
      console.error("[webview] optimizePrompt failed:", e);
      opts.showToast(`优化失败: ${e?.message || e}`);
      optimizingPrompt.value = false;
    }
  }

  // ---------- 导入到工程 ----------
  async function importToProject(ids: string[]) {
    let r: any;
    try {
      r = await bridge.importToProject({ recordIds: ids });
    } catch (e: any) {
      console.error("[webview] importToProject bridge error:", e);
      opts.showToast(`导入到工程失败（桥调用异常）: ${e?.message || e}`);
      return;
    }
    if (r.ok) {
      // 导入前生成结果已被移动到项目旁 Imports/，同步新路径到本地记录
      // （主进程已持久化 records.json，这里更新 UI 状态保持一致，深 watch 会自动落盘相同数据）
      if (r.moved?.length) {
        for (const m of r.moved) {
          const idx = opts.records.value.findIndex((x) => x.id === m.recordId);
          if (idx >= 0 && opts.records.value[idx].workFile !== m.newPath) {
            opts.records.value[idx] = {
              ...opts.records.value[idx],
              workFile: m.newPath,
            };
          }
        }
      }
      const movedCount = r.moved?.length || 0;
      const totalCount = r.imported?.length || 0;
      opts.showToast(
        movedCount > 0
          ? `已导入到 PR 项目 ${totalCount} 个视频（其中 ${movedCount} 个已从生成目录移动到 Imports/）`
          : `已导入到 PR 项目 ${totalCount} 个视频（文件已在 Imports/，无需重复移动）`,
      );
    } else {
      opts.showToast(`导入到工程失败: ${r.error}`);
    }
  }

  // ---------- 删除记录 ----------
  async function deleteRecord(id: string) {
    opts.records.value = opts.records.value.filter((r) => r.id !== id);
  }

  return {
    // 状态（均由 inflight 在飞任务表派生）
    generating,
    pollingActive,
    optimizingPrompt,
    // 行为
    resumePolling,
    resumeNextGenerating,
    // 在飞任务查询（切工程时保留非当前工程的在飞任务，避免卡在 generating）
    getInflightRecords,
    isInflight: (recordId: string) => inflight.has(recordId),
    submitGenerate,
    upgradeTo2K,
    retryRecord,
    optimizePrompt,
    importToProject,
    deleteRecord,
  };
}
