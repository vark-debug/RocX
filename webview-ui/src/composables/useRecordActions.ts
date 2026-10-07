/**
 * 记录操作 composable（信息流版）：从 RecordsPanel.vue 抽出
 * - 选中状态维护（selectedId：缩略图点击跳转 / 外部 @select 用）
 * - 播放互斥（playingId：同一时间只允许一个块的视频在播）
 * - 状态展示（statusOf / 失败卡片 / errorTypeLabel，逐记录纯函数）
 * - 升级 2K 判定（canUpgradeTo2KOf，按 provider + model.capability 决定）
 * - 拖拽到 PR 时间线（按记录闭包）
 * - 生成中耗时（generatingElapsedOf，全局 1s tick 驱动）
 */
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { GenerationRecord } from "@shared/messages";
import {
  getProviderSync,
  DEFAULT_PROVIDER_ID,
} from "../providers/core/registry";
import type { VideoGenCapability } from "../providers/core/types";

// 注意：避免在 composable 公开 API 上硬编码 computed<T>，因为模板里只用 .value 读，
// 用宽松类型避免 Vue 的 WritableComputedRef / ComputedRef 类型推导差异。
type RefAny<T> = { value: T };

export interface ProjectInfo {
  path: string;
  guid: string;
  name?: string;
}

/** 记录是否属于其它工程（多工程并行时才有意义；无归属信息的历史记录不提示） */
export function isForeignRecord(
  rec: GenerationRecord,
  cur?: ProjectInfo | null,
): boolean {
  if (!cur) return false;
  if (rec.projectGuid && cur.guid) return rec.projectGuid !== cur.guid;
  if (rec.projectPath && cur.path) return rec.projectPath !== cur.path;
  return false;
}

/** 其它工程的显示名：取 projectPath 的 basename（去掉扩展名） */
export function foreignProjectName(rec: GenerationRecord): string {
  const base = (rec.projectPath || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  return name || "未知工程";
}

export interface RecordActionsApi {
  selectedId: RefAny<string | null>;
  playingId: RefAny<string | null>;
  sortedRecords: RefAny<GenerationRecord[]>;
  /** 缩略图点击：设置选中 + 通知外部 */
  pick: (rec: GenerationRecord) => void;
  statusOf: (rec: GenerationRecord) => { label: string; color: string };
  failedCardClassOf: (rec: GenerationRecord) => string;
  failedTitleOf: (rec: GenerationRecord) => string;
  errorTypeLabelOf: (rec: GenerationRecord) => string;
  canRetryOf: (rec: GenerationRecord) => boolean;
  canUpgradeTo2KOf: (rec: GenerationRecord) => boolean;
  generatingElapsedOf: (rec: GenerationRecord) => string;
  /** 拖拽处理器（按记录闭包；绑定到该记录视频元素的 dragstart/dragover/dragend） */
  bindDragHandlers: (rec: GenerationRecord) => {
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragEnd: (e: DragEvent) => void;
  };
  emitImport: (rec: GenerationRecord) => void;
  emitRetry: (rec: GenerationRecord) => void;
  emitUpgrade: (rec: GenerationRecord) => void;
  emitUseAsReference: (rec: GenerationRecord) => void;
}

export function useRecordActions(
  records: () => GenerationRecord[],
  initialSelectedId: string | undefined,
  handlers: {
    onSelect: (rec: GenerationRecord) => void;
    onImportToProject: (ids: string[]) => void;
    onRetry: (rec: GenerationRecord) => void;
    onDelete: (id: string) => void;
    onUpgrade: (rec: GenerationRecord) => void;
    onUseAsReference: (rec: GenerationRecord) => void;
  },
): RecordActionsApi {
  // ---- 选中状态（缩略图跳转高亮 + 外部 @select 用；信息流不依赖它渲染详情） ----
  const selectedId = ref<string | null>(
    initialSelectedId || records()[0]?.id || null,
  );

  // 记录数组变化时若当前选中的记录丢失，自动回退到第一条
  watch(
    () => records(),
    (rs) => {
      if (selectedId.value && !rs.find((r) => r.id === selectedId.value)) {
        selectedId.value = rs[0]?.id || null;
      }
    },
    { immediate: true },
  );

  // ---- 播放互斥：一个块开始播放时，其它块收到 playingId 变化自行暂停 ----
  const playingId = ref<string | null>(null);

  const sortedRecords = computed(() =>
    [...records()].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  );

  // ---- 生成中已耗时：任一记录在生成时启动全局 1s tick（驱动所有块的耗时刷新） ----
  const tick = ref(0);
  let tickTimer: any = null;
  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      tick.value++;
    }, 1000);
  }
  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }
  watch(
    () => records().some((r) => r.status === "generating"),
    (anyGenerating) => {
      if (anyGenerating) startTick();
      else stopTick();
    },
    { immediate: true },
  );
  onBeforeUnmount(stopTick);

  // ---- 状态展示 ----
  function statusOf(rec: GenerationRecord): { label: string; color: string } {
    switch (rec.status) {
      case "pending":
        return { label: "排队", color: "#888" };
      case "generating":
        return { label: "生成中", color: "#4b9cf5" };
      case "generated":
        return { label: "已生成", color: "#5cb85c" };
      case "imported":
        return { label: "已导入", color: "#5cb85c" };
      case "failed":
        return { label: "失败", color: "#d9534f" };
      default:
        return { label: rec.status, color: "#888" };
    }
  }

  const ERROR_TYPE_LABELS: Record<
    string,
    { title: string; cls: string }
  > = {
    insufficient_balance_error: {
      title: "💰 余额不足",
      cls: "failed-card-balance",
    },
    authorized_error: { title: "🔑 鉴权失败", cls: "failed-card-auth" },
    rate_limit_error: {
      title: "⏱ 触发限流",
      cls: "failed-card-ratelimit",
    },
    unprocessable_entity_error: {
      title: "⚠️ 内容敏感",
      cls: "failed-card-content",
    },
    bad_request_error: {
      title: "❌ 参数错误",
      cls: "failed-card-param",
    },
    server_error: { title: "💥 服务端错误", cls: "failed-card-server" },
    network_error: { title: "🌐 网络错误", cls: "failed-card-network" },
    missing_task_id: {
      title: "❓ 响应异常",
      cls: "failed-card-unknown",
    },
  };

  function failedCardClassOf(rec: GenerationRecord): string {
    const t = rec.error?.errorType;
    return ERROR_TYPE_LABELS[t || ""]?.cls || "failed-card-generic";
  }

  function failedTitleOf(rec: GenerationRecord): string {
    const t = rec.error?.errorType;
    if (t && ERROR_TYPE_LABELS[t]) return ERROR_TYPE_LABELS[t].title;
    if (rec.error?.httpStatus === 402) return "💰 余额不足";
    if (rec.error?.httpStatus === 401) return "🔑 鉴权失败";
    return "生成失败";
  }

  function errorTypeLabelOf(rec: GenerationRecord): string {
    const t = rec.error?.errorType;
    return t ? `错误类型: ${t}` : "";
  }

  function canRetryOf(rec: GenerationRecord): boolean {
    return !!rec.workFile || !!rec.prompt;
  }

  // ---- 升级 2K 判定（逐记录） ----
  /**
   * 是否允许对此记录发起"像素提升到 2K"：
   *  - 模型必须具备 resolutionUpscale capability（按 provider + modelId 查）
   *  - 当前分辨率必须是 768P（业务规则：MiniMax video_regeneration 仅 768P → 2K；已是 2K 不需要升级）
   *  - 状态必须是已生成 / 已导入
   *  - 源任务必须已有 taskId
   *
   * Fallback 行为：若当前 record 没有 provider 字段（极旧数据），
   * 用 DEFAULT_PROVIDER_ID 兜底；保留 model === "MiniMax-H3" 作为兼容硬编码 fallback，
   * 避免破坏 Task 1-2 之前生成的极旧记录。
   */
  function canUpgradeTo2KOf(rec: GenerationRecord): boolean {
    if (rec.status !== "generated" && rec.status !== "imported") return false;
    if (rec.params.resolution !== "768P") return false;
    if (!rec.taskId) return false;
    // 按 provider + modelId 的 capability 判断
    const provider = getProviderSync(rec.params.provider || DEFAULT_PROVIDER_ID);
    if (!provider) {
      // 没有对应 provider 实例：保留旧 hardcode 兼容（仅 MiniMax-H3）
      return rec.params.model === "MiniMax-H3";
    }
    const model = provider.models.find((m) => m.modelId === rec.params.model);
    if (!model) {
      return rec.params.model === "MiniMax-H3";
    }
    return model.capabilities.includes("resolutionUpscale" as VideoGenCapability);
  }

  function generatingElapsedOf(rec: GenerationRecord): string {
    if (!rec?.submittedAt || rec.status !== "generating") return "";
    void tick.value; // 读取 tick 驱动模板重渲染
    const ms = Date.now() - new Date(rec.submittedAt).getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m${sec % 60}s`;
  }

  // ---- 拖拽到 PR 时间线（逐记录闭包） ----
  let dragStartedAt = 0;
  let dragDropEffect: string | null = null;

  function onDragStart(rec: GenerationRecord, e: DragEvent) {
    if (!rec.workFile) {
      e.preventDefault();
      return;
    }
    dragStartedAt = Date.now();
    dragDropEffect = null;
    const dt = e.dataTransfer;
    if (!dt) return;
    const nativePath = rec.workFile;
    const fileUrl = `file://${nativePath.replace(/ /g, "%20")}`;

    // 只传路径（仿 Finder 拖拽）
    dt.setData("text/uri-list", fileUrl);
    dt.setData("text/plain", fileUrl);
    dt.setData("text/x-rocx-record-id", rec.id);

    dt.effectAllowed = "copy";
    dt.dropEffect = "copy";
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragEnd(rec: GenerationRecord, e: DragEvent) {
    dragDropEffect = e.dataTransfer?.dropEffect ?? null;
    if (!rec.workFile) return;
    if (Date.now() - dragStartedAt < 120) return;
    const accepted = ["copy", "move", "link"].includes(dragDropEffect ?? "");
    if (!accepted) {
      // 拖拽未被 PR 时间线接收 → fallback 弹导入到工程
      const ok = confirm(
        `未拖到 PR 时间线。是否改为导入到工程（出现在 Project 面板，不插入时间线）？`,
      );
      if (ok) {
        handlers.onImportToProject([rec.id]);
      }
    }
  }

  function bindDragHandlers(rec: GenerationRecord) {
    return {
      onDragStart: (e: DragEvent) => onDragStart(rec, e),
      onDragOver,
      onDragEnd: (e: DragEvent) => onDragEnd(rec, e),
    };
  }

  // ---- 操作发射器（逐记录） ----
  function pick(rec: GenerationRecord) {
    selectedId.value = rec.id;
    handlers.onSelect(rec);
  }
  function emitImport(rec: GenerationRecord) {
    handlers.onImportToProject([rec.id]);
  }
  function emitRetry(rec: GenerationRecord) {
    handlers.onRetry(rec);
  }
  function emitUpgrade(rec: GenerationRecord) {
    handlers.onUpgrade(rec);
  }
  function emitUseAsReference(rec: GenerationRecord) {
    handlers.onUseAsReference(rec);
  }

  return {
    selectedId,
    playingId,
    sortedRecords,
    pick,
    statusOf,
    failedCardClassOf,
    failedTitleOf,
    errorTypeLabelOf,
    canRetryOf,
    canUpgradeTo2KOf,
    generatingElapsedOf,
    bindDragHandlers,
    emitImport,
    emitRetry,
    emitUpgrade,
    emitUseAsReference,
  };
}
