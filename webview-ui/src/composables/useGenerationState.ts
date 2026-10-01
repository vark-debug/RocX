/**
 * 全局生成状态 composable：从 main-webview.vue 抽出
 * - 派生（constraints / generatedCount，后者只统计当前工程的记录）
 * - 模型约束（resolution / duration / ratio）随 model 变化的归一化
 * - records 防抖落盘（按记录自带的 projectPath 分组，各写各的 JSON）+ onProjectChanged 回调挂载
 * - records 加载（读取当前活动工程的 JSON，合并在飞任务；故障恢复：扫描本工程 generating 记录以恢复轮询）
 *
 * 状态 ref（apiKey / projectInfo / records / prompt / model / ratio / duration /
 * resolution / references / storageMode / settingsOpen）由主文件创建并传入，
 * 内部仅做派生 / 副作用 / 持久化，避免与 useGenerationTasks 产生循环依赖。
 *
 * 行为与原 main-webview.vue 完全一致。
 */
import { computed, ref, watch, onBeforeUnmount, inject } from "vue";
import * as webviewAPI from "../webview-api";
import { bridge } from "../services/bridge";
import { DEFAULT_PROVIDER_ID } from "../providers/core/registry";
import { SharedRefsKey } from "../providers/state";
import {
  VIDEO_PARAM_CONSTRAINTS,
  type GenerationRecord,
  type VideoParamConstraints,
  type ProjectRecords,
} from "@shared/messages";

type RefAny<T> = { value: T };

export function useGenerationState(opts: {
  /** 不进 SharedRefs:storageMode 仅持久化层使用 */
  storageMode: RefAny<"primary" | "fallback">;
  /** 故障恢复时，扫描到 generating 记录就调它 */
  resumePolling: (rec: GenerationRecord) => void;
  /** 取当前所有在飞任务的 record 副本（权威状态），用于切工程时保留非本工程在飞任务 */
  getInflightRecords: () => GenerationRecord[];
}) {
  const shared = inject(SharedRefsKey);
  if (!shared) {
    throw new Error("useGenerationState requires SharedRefs provider in main-webview");
  }
  const constraints = computed<VideoParamConstraints>(
    () => VIDEO_PARAM_CONSTRAINTS[shared.model.value],
  );

  // 限制 ratio/duration/resolution 在当前模型下合法
  watch(shared.model, () => {
    const c = constraints.value;
    if (!c.resolutions.includes(shared.resolution.value)) {
      shared.resolution.value = c.resolutions[0];
    }
    if (!c.durations.includes(shared.duration.value)) {
      shared.duration.value = c.durations[0];
    }
    if (shared.references.value.length === 0 && !c.ratioAdaptiveAllowed) {
      if (shared.ratio.value === "adaptive") shared.ratio.value = "16:9";
    }
  });

  // 已生成计数：只统计属于当前活动工程的记录（多工程并行时其它工程的记录不计入）
  const generatedCount = computed(() => {
    const cur = shared.projectInfo.value;
    return shared.records.value.filter(
      (r) => r.status === "generated" && (cur?.guid ? r.projectGuid === cur.guid : true),
    ).length;
  });

  // ---------- 切工程加载中：冻结落盘 ----------
  // 切换工程/重新加载记录期间为 true：期间不落盘。切工程时 records 会被整体替换成
  // 新工程的记录 + 其它工程的在飞记录，此时落盘会把旧工程文件覆盖成只剩在飞子集。
  const switching = ref(false);

  // ---------- 记录加载/保存 ----------
  /**
   * 加载当前工程的记录。
   *
   * 读取目标由「当前活动工程」唯一确定，不再做归属推断 —— 写入侧按每条记录
   * 自带的 projectPath 路由（归属在抓素材时已锁定并写进记录），读取侧则是
   * 「当前面板该显示哪个工程的记录」，两者语义本就不同。
   * 切换事件的 payload 在多工程同进程下不可靠（实测出现过事件报 B、
   * 而 getActiveProject() 报 A），因此只把它当作「需要重新加载」的信号。
   */
  async function loadRecords() {
    const live = await bridge.queryProjectState();
    if (!live.project?.path) {
      shared.projectInfo.value = null;
      shared.records.value = [];
      return;
    }
    const project = {
      path: live.project.path,
      guid: String(live.project.guid ?? ""),
      name: live.project.name ?? "",
    };
    shared.projectInfo.value = project;
    const r = await bridge.recordsRead({
      projectGuid: project.guid,
      projectPath: project.path,
    });
    console.log(
      `[gen][load] 实时活动工程 guid=${project.guid} path=${project.path} | readOk=${r.ok} readGuid=${r.data?.projectGuid ?? "-"} readCount=${r.data?.records.length ?? "-"}`,
    );
    if (r.ok && r.data) {
      // 取出 data 局部变量：r.data 的非空收窄在 map 回调内会丢失
      const data = r.data;
      const cur = project;
      shared.projectInfo.value = cur;
      // 旧 records 兼容：缺省 provider = "minimax"（Task 4 之前写入的 record 没有 provider 字段）
      const fromDisk: GenerationRecord[] = data.records.map((rec) => ({
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
        // 归属字段补齐：历史 record 没有 projectGuid/projectPath，用外层同名字段兜底
        projectGuid: rec.projectGuid ?? data.projectGuid,
        projectPath: rec.projectPath ?? data.projectPath,
      }));
      // 保留「不属于当前工程、但仍在轮询」的在飞任务：
      // inflight 里的 record 副本是权威状态，不能被磁盘数据覆盖，
      // 否则切工程时在飞任务从数组消失 → 轮询回调找不到落点 → 永久卡在 generating。
      // 其它工程的已完成记录不保留：切回该工程时从它自己的 JSON 重新读取。
      const keepInflight = opts.getInflightRecords().filter((rec) => {
        if (cur.guid) return rec.projectGuid !== cur.guid;
        return rec.projectPath !== cur.path;
      });
      shared.records.value = [...fromDisk, ...keepInflight];
      opts.storageMode.value = data.storageMode;
      // 故障恢复：只对本工程的 generating 记录恢复轮询（resumePolling 内部有防重复判断）
      for (const rec of shared.records.value) {
        const isCur = cur.guid
          ? rec.projectGuid === cur.guid
          : rec.projectPath === cur.path;
        if (isCur && rec.status === "generating" && rec.taskId) {
          opts.resumePolling(rec);
        }
      }
    } else {
      // 读取彻底失败（无活动工程）：仍保留其它工程在飞任务，避免卡在 generating。
      // 注意：这里不能沿用旧的 projectInfo —— 没有活动工程时若还挂着上一个工程的身份，
      // 后续生成会把记录写进那个工程的 JSON。无活动工程时直接置空，让 submitGenerate 的
      // 「无活动 PR 项目」守卫拦住提交。
      if (!r.ok && r.error === "无活动项目") {
        shared.projectInfo.value = null;
      }
      const cur = shared.projectInfo.value;
      const keepInflight = opts.getInflightRecords().filter((rec) => {
        if (!cur) return true;
        if (cur.guid) return rec.projectGuid !== cur.guid;
        return rec.projectPath !== cur.path;
      });
      shared.records.value = [...keepInflight];
    }
  }

  let writeTimer: any = null;
  async function persistRecords() {
    // 防抖
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      // 切工程加载期间不落盘：records 此刻是加载中间态
      if (switching.value) return;
      // 按记录的归属工程分组：多工程并行时每组单独写一个 JSON，
      // 否则会把所有工程的记录混进「当前活动工程」的文件里
      const groups = new Map<
        string,
        { projectGuid: string; projectPath: string; records: GenerationRecord[] }
      >();
      const cur = shared.projectInfo.value;
      for (const r of shared.records.value) {
        // 缺归属字段的历史记录归入当前工程（与读取时的补齐逻辑一致）
        const guid = r.projectGuid ?? cur?.guid ?? "";
        const path = r.projectPath ?? cur?.path ?? "";
        // 无路径归属：无法路由落盘，跳过
        if (!path) continue;
        const key = guid || path;
        if (!groups.has(key)) {
          groups.set(key, { projectGuid: guid, projectPath: path, records: [] });
        }
        groups.get(key)!.records.push(r);
      }
      // 逐组写入；storageMode 只回写「当前工程」那一组的状态
      console.log(
        `[gen][persist] 分组数=${groups.size} currentGuid=${cur?.guid ?? "-"} currentPath=${cur?.path ?? "-"}`,
        [...groups.values()].map((g) => ({
          guid: g.projectGuid || "-",
          path: g.projectPath,
          count: g.records.length,
        })),
      );
      for (const g of groups.values()) {
        const data: ProjectRecords = { ...g, storageMode: opts.storageMode.value };
        const w = await bridge.recordsWrite(data);
        console.log(
          `[gen][persist] 写入完成 path=${g.projectPath} count=${g.records.length} ok=${w.ok} mode=${w.storageMode ?? "-"} err=${w.error ?? "-"}`,
        );
        if (w.ok && g.projectPath === cur?.path) opts.storageMode.value = w.storageMode;
      }
    }, 200);
  }

  watch(opts.records, () => persistRecords(), { deep: true });

  // ---------- 主题 / 项目变化 ----------
  /**
   * 重新加载当前工程的记录（切工程 / 手动刷新 / 首屏共用）：
   * 先取消挂起的防抖写入，再冻结落盘直到加载完成，
   * 避免把旧工程的记录写进新工程路径、或把加载中间态落盘。
   */
  function reloadRecords() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    switching.value = true;
    return loadRecords().finally(() => {
      switching.value = false;
    });
  }

  // 切换事件只作为「需要重新加载」的信号：它的 payload 在多工程同进程下不可靠，
  // 真正的当前工程由 loadRecords 内部的实时查询决定。
  webviewAPI.onProjectChanged(() => {
    void reloadRecords();
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
    /** 切工程 / 手动刷新共用的加载入口：清理挂起写入 + 冻结落盘 */
    reloadRecords,
    persistRecords,
  };
}
