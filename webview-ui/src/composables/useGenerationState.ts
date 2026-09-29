/**
 * 全局生成状态 composable：从 main-webview.vue 抽出
 * - 派生（constraints / generatedCount）
 * - 模型约束（resolution / duration / ratio）随 model 变化的归一化
 * - records 防抖落盘 + onProjectChanged / onThemeChanged 回调挂载
 * - records 加载（故障恢复：扫描 generating 状态记录以恢复轮询）
 *
 * 状态 ref（apiKey / projectInfo / records / prompt / model / ratio / duration /
 * resolution / references / storageMode / settingsOpen）由主文件创建并传入，
 * 内部仅做派生 / 副作用 / 持久化，避免与 useGenerationTasks 产生循环依赖。
 *
 * 行为与原 main-webview.vue 完全一致。
 */
import { computed, watch, onBeforeUnmount } from "vue";
import * as webviewAPI from "../webview-api";
import { bridge } from "../services/bridge";
import { DEFAULT_PROVIDER_ID } from "../providers/core/registry";
import {
  MINIMAX_PARAM_CONSTRAINTS,
  type GenerationRecord,
  type MiniMaxModel,
  type MiniMaxRatio,
  type MiniMaxResolution,
  type MiniMaxParamConstraints,
  type ProjectRecords,
  type ReferenceItem,
} from "@shared/messages";

type RefAny<T> = { value: T };

export function useGenerationState(opts: {
  apiKey: RefAny<string | null>;
  projectInfo: RefAny<{ path: string; guid: string; name: string } | null>;
  records: RefAny<GenerationRecord[]>;
  storageMode: RefAny<"primary" | "fallback">;
  prompt: RefAny<string>;
  model: RefAny<MiniMaxModel>;
  ratio: RefAny<MiniMaxRatio>;
  duration: RefAny<number>;
  resolution: RefAny<MiniMaxResolution>;
  references: RefAny<ReferenceItem[]>;
  settingsOpen: RefAny<boolean>;
  /** 故障恢复时，扫描到 generating 记录就调它 */
  resumePolling: (rec: GenerationRecord) => void;
}) {
  const constraints = computed<MiniMaxParamConstraints>(
    () => MINIMAX_PARAM_CONSTRAINTS[opts.model.value],
  );

  // 限制 ratio/duration/resolution 在当前模型下合法
  watch(opts.model, () => {
    const c = constraints.value;
    if (!c.resolutions.includes(opts.resolution.value)) {
      opts.resolution.value = c.resolutions[0];
    }
    if (!c.durations.includes(opts.duration.value)) {
      opts.duration.value = c.durations[0];
    }
    if (opts.references.value.length === 0 && !c.ratioAdaptiveAllowed) {
      if (opts.ratio.value === "adaptive") opts.ratio.value = "16:9";
    }
  });

  const generatedCount = computed(
    () => opts.records.value.filter((r) => r.status === "generated").length,
  );

  // ---------- 记录加载/保存 ----------
  async function loadRecords() {
    const r = await bridge.recordsRead();
    if (r.ok && r.data) {
      opts.projectInfo.value = {
        path: r.data.projectPath,
        guid: r.data.projectGuid,
        name: "",
      };
      // 旧 records 兼容：缺省 provider = "minimax"（Task 4 之前写入的 record 没有 provider 字段）
      opts.records.value = r.data.records.map((rec) => ({
        ...rec,
        params: {
          ...rec.params,
          provider: rec.params.provider || DEFAULT_PROVIDER_ID,
        },
        // pendingUpload 是 webview session-only 标记，不应进入持久化层；
        // 这里显式清掉，避免历史 record 里残留误判（实际根本不会写盘，仅作防御）。
        references: rec.references.map((ref) => {
          const { pendingUpload: _ignored, ...rest } = ref as any;
          return rest;
        }),
      }));
      opts.storageMode.value = r.data.storageMode;
      // 故障恢复：扫描 generating 状态的记录
      for (const rec of opts.records.value) {
        if (rec.status === "generating" && rec.taskId) {
          opts.resumePolling(rec);
        }
      }
    } else {
      opts.records.value = [];
    }
  }

  let writeTimer: any = null;
  async function persistRecords() {
    if (!opts.projectInfo.value) return;
    // 防抖
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      const data: ProjectRecords = {
        projectGuid: opts.projectInfo.value!.guid,
        projectPath: opts.projectInfo.value!.path,
        records: opts.records.value,
        storageMode: opts.storageMode.value,
      };
      const w = await bridge.recordsWrite(data);
      if (w.ok) opts.storageMode.value = w.storageMode;
    }, 200);
  }

  watch(opts.records, () => persistRecords(), { deep: true });

  // ---------- 主题 / 项目变化 ----------
  webviewAPI.onProjectChanged((p) => {
    opts.projectInfo.value = p;
    loadRecords();
  });
  webviewAPI.onThemeChanged((v) => {
    console.log("theme changed", v.theme);
  });

  onBeforeUnmount(() => {
    if (writeTimer) clearTimeout(writeTimer);
  });

  return {
    constraints,
    generatedCount,
    loadRecords,
    persistRecords,
  };
}
