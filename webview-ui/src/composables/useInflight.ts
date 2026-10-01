/**
 * 在飞任务登记表 composable
 *
 * 持有:
 * - inflight: recordId -> { record, polling },shallowReactive Map(切工程时不被替换)
 * - polling_: usePolling 单例(多任务并行,按 taskId 独立轮询)
 * - 派生:generating / pollingActive(均由 inflight 派生)
 *
 * 数据流(为什么 inflight 与 records 解耦):
 * - 切工程时 records 会被整体替换,旧工程记录可能已不在其中
 * - 在飞任务的权威状态必须保留在 inflight 里,与 records 是否还持有该记录无关
 * - commitInflight 先更新 inflight(权威),再尽力同步到 records
 *
 * 调用方:
 * - main-webview.vue 顶层创建一次 (单例 inflight + polling_)
 * - useGenerationState 通过回调(resumePolling / getInflightRecords)接入
 * - useSubmit 等 useSubmit 函数接收 polling_ 与 commitInflight 入参数消费
 *
 * 不做:toast / 上报。终端成功的回调由调用方传入 onTerminalSuccess,
 *       飞书上报逻辑放在 useFeishuReport,避免 useInflight 与 toast 状态耦合。
 */
import { computed, shallowReactive, inject } from "vue";
import { bridge } from "../services/bridge";
import { usePolling } from "./usePolling";
import { SharedRefsKey } from "../providers/state";
import type { GenerationRecord, ReportPurpose } from "@shared/messages";

type RefAny<T> = { value: T };

export interface ProjectInfo {
  path: string;
  guid: string;
  name: string;
}

/** polling start 选项(传给 usePolling().start) */
interface PollingStartOpts {
  taskId: string;
  apiKey: string;
  onUpdate: (resp: any) => void;
  onTerminal: (resp: any, err?: Error) => void;
  intervalMs?: number;
}

export function useInflight(opts: {
  /**
   * 任务进入终态 succeeded 时回调(用于飞书上报等副作用);非阻塞。
   * 不再传 resp 参数 —— 历史上把 VideoGenQueryResponse 当作 purpose 字符串传入导致
   * webhookCore 写出"purpose=整段 server response"的 bug(V2.7 修复)。
   */
  onTerminalSuccess?: (rec: GenerationRecord, purpose?: ReportPurpose) => void;
}) {
  const shared = inject(SharedRefsKey);
  if (!shared) {
    throw new Error("useInflight requires SharedRefs provider in main-webview");
  }
  const inflight = shallowReactive(
    new Map<string, { record: GenerationRecord; polling: boolean }>(),
  );
  const polling_ = usePolling();

  /** 记录是否属于指定工程:优先用 guid 判定,缺 guid 时退回 path */
  function belongsTo(
    rec: GenerationRecord,
    info: ProjectInfo | null,
  ): boolean {
    if (!info) return false;
    if (info.guid) return rec.projectGuid === info.guid;
    return rec.projectPath === info.path;
  }

  /** 在飞任务里是否已有该记录且仍在轮询(用于防重复 start 同一 taskId) */
  function isPolling(recordId: string): boolean {
    return inflight.get(recordId)?.polling === true;
  }

  /** 对外查询:当前所有在飞任务的记录副本(权威状态) */
  function getInflightRecords(): GenerationRecord[] {
    return Array.from(inflight.values()).map((e) => e.record);
  }

  /**
   * 把权威 record 副本同步进 records 数组。
   * 切工程时 records 数组会被整体替换,旧工程记录可能已不在其中 —— 此时静默跳过,
   * 权威状态仍保留在 inflight 里,不会丢。
   */
  function syncToRecords(next: GenerationRecord) {
    const idx = shared.records.value.findIndex((r) => r.id === next.id);
    if (idx < 0) return;
    const cur = shared.records.value[idx];
    // 同一 id 但归属工程不一致:防御性判断,避免误改别的工程的记录
    if (
      (cur.projectGuid ?? "") !== (next.projectGuid ?? "") ||
      (cur.projectPath ?? "") !== (next.projectPath ?? "")
    ) {
      return;
    }
    shared.records.value[idx] = { ...cur, ...next };
  }

  /** 更新在飞登记表里的权威 record 副本(先),再尽力同步到 records 数组(后) */
  function commitInflight(recId: string, patch: Partial<GenerationRecord>) {
    const entry = inflight.get(recId);
    if (!entry) return null;
    const next = { ...entry.record, ...patch };
    inflight.set(recId, { ...entry, record: next });
    syncToRecords(next);
    return next;
  }

  /**
   * 启动/重启一个 record 的轮询。
   * 防重复启动:同一 record.id 已在轮询就不再 start
   * (loadRecords 的故障恢复与 onTerminal 的 resumeNextGenerating 都会调进来)
   */
  function resumePolling(rec: GenerationRecord) {
    if (!rec.taskId || !shared.apiKey.value) return;
    if (isPolling(rec.id)) return;
    // 登记进在飞任务表(已存在则更新为最新 record 副本)
    const prev = inflight.get(rec.id);
    inflight.set(rec.id, {
      record: prev ? { ...prev.record, ...rec } : rec,
      polling: true,
    });

    const startOpts: PollingStartOpts = {
      taskId: rec.taskId,
      apiKey: shared.apiKey.value,
      onUpdate: (resp) => {
        commitInflight(rec.id, {
          lastPolledAt: new Date().toISOString(),
          usage: resp.usage,
        });
      },
      onTerminal: async (resp, err) => {
        // 终态只需执行一次:无论走哪个分支(含异常路径)都必须从在飞表摘除,
        // 否则该 record 会永远留在 inflight 里,pollingActive 永远为 true
        try {
          if (!resp) {
            commitInflight(rec.id, {
              status: "failed",
              error: { message: err?.message || "查询失败" },
            });
            return;
          }
          if (resp.status === "succeeded" && resp.content?.url) {
            // 先经 Comlink 桥调 UXP 端下载到 plugin-data 工作目录,成功后才更新 UI 状态
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
              // 上报飞书多维表格:fire-and-forget,不阻塞后续轮询恢复
              // 不传 purpose(由 UXP 端 webhookCore.reportGenerated 用 resolvePurpose
              // 推断:record.upgradedFromResolution 存在 → 分辨率升级,否则 → 视频生成)
              if (done) opts.onTerminalSuccess?.(done);
            } else {
              commitInflight(rec.id, {
                status: "failed",
                error: { message: `下载失败: ${dl.error}` },
              });
            }
          } else if (resp.status === "succeeded") {
            // 极端情况:任务成功但响应缺 url —— 明确标记失败,避免永远卡在 generating
            console.error(
              "[webview] succeeded 但缺少 content.url:",
              JSON.stringify(resp).slice(0, 300),
            );
            commitInflight(rec.id, {
              status: "failed",
              error: {
                message: "任务成功但响应缺少下载地址(content.url 为空)",
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
          // 本任务结束:把其余还处于 generating 的记录(可能属于别的工程)恢复轮询
          resumeNextGenerating();
        }
      },
    };
    polling_.start(startOpts);
  }

  /**
   * 对所有还处于 generating 且有 taskId 的任务各自恢复轮询(多任务并行,无排队)。
   *
   * 数据源必须是 inflight 表而不是 records 数组:切工程时 records 会被整体替换成
   * 新工程的记录,其它工程的在飞任务可能已不在其中,遍历 records 会漏掉它们,
   * 导致任务永久卡在 generating。inflight 里存的是权威副本,与 records 是否
   * 还持有该记录无关。
   */
  function resumeNextGenerating() {
    for (const rec of getInflightRecords()) {
      if (rec.status === "generating" && rec.taskId) resumePolling(rec);
    }
  }

  /**
   * 派生:当前活动工程里正在 generating 的那条在飞记录(状态面板用)。
   * 优先当前工程的,其次任意一条在飞记录。
   */
  const generating = computed<GenerationRecord | null>(() => {
    const list = getInflightRecords();
    const cur = shared.projectInfo.value;
    return (
      list.find((r) => r.status === "generating" && belongsTo(r, cur)) ??
      list.find((r) => r.status === "generating") ??
      null
    );
  });

  /** 派生:还有任意任务在轮询(= 在飞登记表非空) */
  const pollingActive = computed(() => inflight.size > 0);

  return {
    /** 在飞登记表 Map(底层 shallowReactive,谨慎整体替换) */
    inflight,
    /** usePolling 单例(多任务并行) */
    polling_,
    /** 派生 */
    generating,
    pollingActive,
    /** 工具 */
    belongsTo,
    isPolling,
    getInflightRecords,
    commitInflight,
    syncToRecords,
    /** 轮询管理 */
    resumePolling,
    resumeNextGenerating,
  };
}