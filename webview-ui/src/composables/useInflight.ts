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
 * - useGenerationState 通过回调(resumePolling / getPersistableInflightRecords)接入
 * - useSubmit 等 useSubmit 函数接收 polling_ 与 commitInflight 入参数消费
 *
 * 不做:toast / 上报。终端成功的回调由调用方传入 onTerminalSuccess,
 *       飞书上报逻辑放在 useFeishuReport,避免 useInflight 与 toast 状态耦合。
 */
import { computed, shallowReactive, inject } from "vue";
import { bridge } from "../services/bridge";
import { usePolling } from "./usePolling";
import { DEFAULT_PROVIDER_ID, DEFAULT_IMAGE_PROVIDER_ID } from "../providers/core/registry";
import { SharedRefsKey } from "../providers/state";
import { REPORT_PURPOSE } from "@shared/messages";
import type { GenerationRecord, ReportPurpose } from "@shared/messages";
import { deletedRecordIds } from "./useRecordEdit";

export interface ProjectInfo {
  path: string;
  guid: string;
  name: string;
}

/** polling start 选项(传给 usePolling().start) */
interface PollingStartOpts {
  taskId: string;
  /** 该任务提交时锁定的 provider id */
  providerId: string;
  /** provider 表类型：video（默认）或 image */
  providerKind?: "video" | "image";
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
  /**
   * 任务终态 commit 后回调(接线到 persistNow 直通落盘)。
   * 终态时 inflight 副本已摘除,records 是唯一内存副本,而常规落盘有 200ms 防抖;
   * 若防抖窗口内发生切工程/刷新(timer 被清),记录将永不落盘 —— 终态必须立即写。
   */
  onTerminalCommit?: () => void;
}) {
  const sharedRaw = inject(SharedRefsKey);
  if (!sharedRaw) {
    throw new Error("useInflight requires SharedRefs provider in main-webview");
  }
  // 窄化别名：const 初始化取 rvalue 的窄化类型，闭包内不再 possibly undefined
  const shared = sharedRaw;
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

  /**
   * 「临时在飞」登记表(如提示词优化占位):不进 records 列表、不参与落盘分组。
   * 与 videoGen 记录走同一 inflight 表(共享 pollingActive 派生),但持久化/UI 语义不同,
   * 用 id 集合区分,persistRecords / loadRecords 的 keepInflight 一律走
   * getPersistableInflightRecords() 过滤。
   */
  const transientIds = new Set<string>();

  /** 临时在飞登记(优化占位等):只进 inflight,不进 records、不落盘 */
  function registerTransient(rec: GenerationRecord) {
    transientIds.add(rec.id);
    inflight.set(rec.id, { record: rec, polling: true });
  }

  /** 摘除临时在飞登记(与 registerTransient 成对;普通任务走 inflight.delete 即可) */
  function removeTransient(recId: string) {
    transientIds.delete(recId);
    inflight.delete(recId);
  }

  /** 对外查询:当前所有在飞任务的记录副本(权威状态,含临时登记) */
  function getInflightRecords(): GenerationRecord[] {
    return Array.from(inflight.values()).map((e) => e.record);
  }

  /** 可落盘的在飞记录副本:剔除临时登记,并惰性清理已结束任务的残留 id */
  function getPersistableInflightRecords(): GenerationRecord[] {
    for (const id of Array.from(transientIds)) {
      if (!inflight.has(id)) transientIds.delete(id);
    }
    return getInflightRecords().filter((r) => !transientIds.has(r.id));
  }

  /**
   * 把权威 record 副本同步进 records 数组。
   * 记录不在 records 时(典型:切工程整体替换,该任务还没写进磁盘,
   * fromDisk 与 keepInflight 都不含它)补插回去 —— 否则权威副本只留在 inflight,
   * UI 看不见、persistRecords 的分组(shared.records)也读不到,
   * 任务完成后记录凭空蒸发、永不落盘。
   * 临时登记(优化占位)仍按设计不进 records;无归属路径的记录无法路由落盘,同样跳过。
   */
  function syncToRecords(next: GenerationRecord) {
    // 墓碑排除:已删记录(即使仍在轮询)不补插回 records,否则删除后被复活
    if (deletedRecordIds.has(next.id)) return;
    const idx = shared.records.value.findIndex((r) => r.id === next.id);
    if (idx < 0) {
      if (transientIds.has(next.id) || !next.projectPath) return;
      shared.records.value.unshift(next);
      return;
    }
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
   *
   * kind 感知:
   * - video:用 shared.apiKey(当前 provider 的 key);成功后经 bridge.downloadFile 落盘
   * - image:按记录的 provider 取 per-provider key;成功后只记 resultUrl(预览,不下载)
   */
  async function resumePolling(rec: GenerationRecord) {
    if (!rec.taskId) return;
    const isImage = rec.kind === "image";
    // video 沿用旧守卫:当前 provider 无 key 直接不启动
    if (!isImage && !shared.apiKey.value) return;
    // 防重复启动的登记必须先于任何 await(同步执行),避免并发重入双启
    if (isPolling(rec.id)) return;
    // 登记进在飞任务表(已存在则更新为最新 record 副本)
    const prev = inflight.get(rec.id);
    inflight.set(rec.id, {
      record: prev ? { ...prev.record, ...rec } : rec,
      polling: true,
    });

    // image:按记录锁定的 provider 取 per-provider key(存储层回落 legacy 默认 key)
    const apiKey = isImage
      ? await bridge.getApiKey(rec.params.provider || DEFAULT_IMAGE_PROVIDER_ID)
      : shared.apiKey.value;
    if (!apiKey) {
        if (isImage) {
          // 先 commit(同步进 records)再从在飞表摘除
          commitInflight(rec.id, {
            status: "failed",
            error: { message: "RunningHub API Key 缺失，无法查询任务状态" },
          });
        }
        inflight.delete(rec.id);
        // 终态(失败)同样直通落盘,避免防抖窗口内刷新丢记录
        opts.onTerminalCommit?.();
        return;
      }

    const startOpts: PollingStartOpts = {
      taskId: rec.taskId,
      // 锁定提交时的 provider（老记录缺 provider 时回落默认）
      providerId: isImage
        ? rec.params.provider || DEFAULT_IMAGE_PROVIDER_ID
        : rec.params.provider || DEFAULT_PROVIDER_ID,
      providerKind: isImage ? "image" : "video",
      apiKey,
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
          if (isImage) {
            // 图片:成功记 resultUrl 供预览,并立即下载落盘
            // （导入/用作参考依赖本地文件;RH 结果 URL 仅 24h 有效,落盘越早越好。
            //   下载失败不标 failed —— 图已生成,预览仍可用,只是暂无 workFile）
            if (resp.status === "succeeded" && resp.content?.url) {
              const ext =
                rec.imageParams?.outputFormat === "jpeg"
                  ? "jpg"
                  : rec.imageParams?.outputFormat || "png";
              const dl = await bridge.downloadFile({
                url: resp.content.url,
                suggestedName: `${rec.id}.${ext}`,
                recordId: rec.id,
              });
              if (!dl.ok || !dl.localPath) {
                console.warn(
                  "[inflight] 图片结果落盘失败（预览仍可用）:",
                  dl.error,
                );
              }
              const done = commitInflight(rec.id, {
                status: "generated",
                resultUrl: resp.content.url,
                usage: resp.usage,
                ...(dl.ok && dl.localPath ? { workFile: dl.localPath } : {}),
              });
              if (done) opts.onTerminalSuccess?.(done, REPORT_PURPOSE.IMAGE_GEN);
            } else if (resp.status === "succeeded") {
              commitInflight(rec.id, {
                status: "failed",
                error: { message: "任务成功但响应缺少图片地址(content.url 为空)" },
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
          // 终态直通落盘:records 是该记录唯一内存副本,必须抢在防抖窗口前写盘
          opts.onTerminalCommit?.();
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
    /** 可落盘子集(剔除优化占位等临时登记) */
    getPersistableInflightRecords,
    /** 临时在飞登记(不进 records、不落盘) */
    registerTransient,
    removeTransient,
    commitInflight,
    syncToRecords,
    /** 轮询管理 */
    resumePolling,
    resumeNextGenerating,
  };
}