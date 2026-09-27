/**
 * 记录操作 composable：从 RecordsPanel.vue 抽出
 * - 状态展示（statusOf / failedCardClass / failedTitle / errorTypeLabel / canRetrySelected）
 * - 升级 2K 判定（canUpgradeTo2K，按 provider + model.capability 决定）
 * - 拖拽到 PR 时间线（onDragStart / onDragOver / onDragEnd）
 * - 生成中耗时（generatingElapsed）
 * - 选中状态维护
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

export interface RecordActionsApi {
  selectedId: RefAny<string | null>;
  selected: RefAny<GenerationRecord | null>;
  isPlaying: RefAny<boolean>;
  mainVideoRef: RefAny<HTMLVideoElement | null>;
  togglePlay: () => void;
  pick: (rec: GenerationRecord) => void;
  statusOf: (rec: GenerationRecord) => { label: string; color: string };
  failedCardClass: RefAny<string>;
  failedTitle: RefAny<string>;
  errorTypeLabel: RefAny<string>;
  canRetrySelected: RefAny<boolean>;
  canUpgradeTo2K: RefAny<boolean>;
  generatingElapsed: RefAny<string>;
  sortedRecords: RefAny<GenerationRecord[]>;
  /** 拖拽处理器（绑定到模板的 dragstart/dragover/dragend） */
  bindDragHandlers: () => {
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragEnd: (e: DragEvent) => void;
  };
  /** 主操作发射器（导入到工程 / 填入生成器 / 删除 / 升级 / 用作参考） */
  emitImportSelected: () => void;
  emitRetrySelected: () => void;
  emitDeleteSelected: () => void;
  emitUpgradeSelected: () => void;
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
  // ---- 选中状态 ----
  const selectedId = ref<string | null>(
    initialSelectedId || records()[0]?.id || null,
  );

  // 记录数组变化时若当前选中的记录丢失，自动跳到第一条
  watch(
    () => records(),
    (rs) => {
      if (!selectedId.value || !rs.find((r) => r.id === selectedId.value)) {
        selectedId.value = rs[0]?.id || null;
      }
    },
    { immediate: true },
  );

  const selected = computed(
    () => records().find((r) => r.id === selectedId.value) || null,
  );

  const sortedRecords = computed(() =>
    [...records()].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  );

  // ---- 视频播放控制 ----
  const mainVideoRef = ref<HTMLVideoElement | null>(null);
  const isPlaying = ref(false);
  function togglePlay() {
    const v = mainVideoRef.value;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }
  watch(selectedId, () => {
    isPlaying.value = false;
    const v = mainVideoRef.value;
    if (v && !v.paused) v.pause();
  });

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

  const failedCardClass = computed(() => {
    const t = selected.value?.error?.errorType;
    return ERROR_TYPE_LABELS[t || ""]?.cls || "failed-card-generic";
  });

  const failedTitle = computed(() => {
    const t = selected.value?.error?.errorType;
    if (t && ERROR_TYPE_LABELS[t]) return ERROR_TYPE_LABELS[t].title;
    if (selected.value?.error?.httpStatus === 402) return "💰 余额不足";
    if (selected.value?.error?.httpStatus === 401) return "🔑 鉴权失败";
    return "生成失败";
  });

  const errorTypeLabel = computed(() => {
    const t = selected.value?.error?.errorType;
    return t ? `错误类型: ${t}` : "";
  });

  const canRetrySelected = computed(() => {
    if (!selected.value) return false;
    return !!selected.value.workFile || !!selected.value.prompt;
  });

  // ---- 升级 2K 判定 ----
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
  const canUpgradeTo2K = computed(() => {
    const r = selected.value;
    if (!r) return false;
    if (r.status !== "generated" && r.status !== "imported") return false;
    if (r.params.resolution !== "768P") return false;
    if (!r.taskId) return false;
    // 按 provider + modelId 的 capability 判断
    const provider = getProviderSync(r.params.provider || DEFAULT_PROVIDER_ID);
    if (!provider) {
      // 没有对应 provider 实例：保留旧 hardcode 兼容（仅 MiniMax-H3）
      return r.params.model === "MiniMax-H3";
    }
    const model = provider.models.find((m) => m.modelId === r.params.model);
    if (!model) {
      return r.params.model === "MiniMax-H3";
    }
    return model.capabilities.includes("resolutionUpscale" as VideoGenCapability);
  });

  // ---- 生成中已耗时（每秒 tick 触发 reactive） ----
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
    () => selected.value?.status,
    (s) => {
      if (s === "generating") startTick();
      else stopTick();
    },
    { immediate: true },
  );
  onBeforeUnmount(stopTick);

  const generatingElapsed = computed(() => {
    const rec = selected.value;
    if (!rec?.submittedAt || rec.status !== "generating") return "";
    void tick.value;
    const ms = Date.now() - new Date(rec.submittedAt).getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m${sec % 60}s`;
  });

  // ---- 操作发射器 ----
  function pick(rec: GenerationRecord) {
    selectedId.value = rec.id;
    handlers.onSelect(rec);
  }
  function emitImportSelected() {
    if (selected.value) handlers.onImportToProject([selected.value.id]);
  }
  function emitRetrySelected() {
    if (selected.value) handlers.onRetry(selected.value);
  }
  function emitDeleteSelected() {
    if (selected.value) handlers.onDelete(selected.value.id);
  }
  function emitUpgradeSelected() {
    if (selected.value) handlers.onUpgrade(selected.value);
  }
  function emitUseAsReference(rec: GenerationRecord) {
    handlers.onUseAsReference(rec);
  }

  // ---- 拖拽到 PR 时间线 ----
  let dragStartedAt = 0;
  let dragDropEffect: string | null = null;

  function onDragStart(e: DragEvent) {
    if (!selected.value?.workFile) {
      e.preventDefault();
      return;
    }
    dragStartedAt = Date.now();
    dragDropEffect = null;
    const dt = e.dataTransfer;
    if (!dt) return;
    const nativePath = selected.value.workFile;
    const fileUrl = `file://${nativePath.replace(/ /g, "%20")}`;

    // 只传路径（仿 Finder 拖拽）
    dt.setData("text/uri-list", fileUrl);
    dt.setData("text/plain", fileUrl);
    dt.setData("text/x-rocx-record-id", selected.value.id);

    dt.effectAllowed = "copy";
    dt.dropEffect = "copy";
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragEnd(e: DragEvent) {
    dragDropEffect = e.dataTransfer?.dropEffect ?? null;
    if (!selected.value?.workFile) return;
    if (Date.now() - dragStartedAt < 120) return;
    const accepted = ["copy", "move", "link"].includes(dragDropEffect ?? "");
    if (!accepted) {
      // 拖拽未被 PR 时间线接收 → fallback 弹导入到工程
      const ok = confirm(
        `未拖到 PR 时间线。是否改为导入到工程（出现在 Project 面板，不插入时间线）？`,
      );
      if (ok && selected.value) {
        handlers.onImportToProject([selected.value.id]);
      }
    }
  }

  function bindDragHandlers() {
    return { onDragStart, onDragOver, onDragEnd };
  }

  return {
    selectedId,
    selected,
    isPlaying,
    mainVideoRef,
    togglePlay,
    pick,
    statusOf,
    failedCardClass,
    failedTitle,
    errorTypeLabel,
    canRetrySelected,
    canUpgradeTo2K,
    generatingElapsed,
    sortedRecords,
    bindDragHandlers,
    emitImportSelected,
    emitRetrySelected,
    emitDeleteSelected,
    emitUpgradeSelected,
    emitUseAsReference,
  };
}
