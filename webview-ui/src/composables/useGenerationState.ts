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
import { computed, ref, watch, onBeforeUnmount, inject, shallowRef } from "vue";
import * as webviewAPI from "../webview-api";
import { bridge } from "../services/bridge";
import { DEFAULT_PROVIDER_ID } from "../providers/core/registry";
import { SharedRefsKey } from "../providers/state";
import { deletedRecordIds } from "./useRecordEdit";
import {
  VIDEO_PARAM_CONSTRAINTS,
  type GenerationRecord,
  type VideoModel,
  type VideoParamConstraints,
  type ProjectRecords,
  type PromptOptimization,
} from "@shared/messages";

type RefAny<T> = { value: T };

export function useGenerationState(opts: {
  /** 不进 SharedRefs:storageMode 仅持久化层使用 */
  storageMode: RefAny<"primary" | "fallback">;
  /** 故障恢复时，扫描到 generating 记录就调它 */
  resumePolling: (rec: GenerationRecord) => void;
  /**
   * 取当前所有「可落盘」的在飞任务 record 副本（权威状态，已剔除优化占位等临时登记）。
   * 用途：
   * - 切工程时保留非本工程在飞任务（keepInflight）
   * - persistRecords 分组时并入落盘数据源（records 被整体替换后，
   *   还没写进磁盘的在飞任务从这里补齐，保证权威状态始终落盘）
   */
  getPersistableInflightRecords: () => GenerationRecord[];
}) {
  const sharedRaw = inject(SharedRefsKey);
  if (!sharedRaw) {
    throw new Error("useGenerationState requires SharedRefs provider in main-webview");
  }
  // 窄化别名：const 初始化取 rvalue 的窄化类型，闭包内不再 possibly undefined
  const shared = sharedRaw;
  const constraints = computed<VideoParamConstraints>(
    () => VIDEO_PARAM_CONSTRAINTS[shared.model.value as VideoModel],
  );

  /**
   * 提示词优化历史(同盘,不入 records 列表)。
   * 与 videoGenerate records 同 JSON 文件,落盘路由一致(主路径优先),
   * 共享 primary / fallback 切换;前端不显示在记录列表。
   */
  const promptOptimizations = ref<PromptOptimization[]>([]);

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
   *
   * 归属收养（adoption）：从磁盘读出的 records / 优化历史一律重打为当前工程
   * 的 guid/path —— guid 在拷贝/另存为副本后会变，不能做跨位置锚点；收养让
   * 「整个项目目录拷给别人 → 打开即见全部生成记录」成立（详见 fromDisk 注释）。
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
        // 归属收养（adoption）：磁盘读出的记录一律重打为当前工程的 guid/path。
        // PR 的 project.guid 在「另存为副本 / 拷贝 .prproj 到其它目录」后会变化
        // （实测），guid 不能作跨位置的身份锚点；读取路由本就按「同目录 + 同名
        // JSON」命中（宿主侧不校验 guid）。收养后，整个项目目录拷贝给别人，
        // 打开即拥有全部生成记录：◈ 角标 / generatedCount / 故障恢复 /
        // keepInflight / syncToRecords 防御 / 落盘分组全部随新归属自洽。
        // 幂等：guid 一致时重打为相同值（无操作）；不一致时（拷贝/接收）统一
        // 改为当前工程，下一次 persist 把整个 JSON 收敛为接收者的归属。
        projectGuid: cur.guid,
        projectPath: cur.path,
      }));
      // 保留「不属于当前工程、但仍在轮询」的在飞任务：
      // inflight 里的 record 副本是权威状态，不能被磁盘数据覆盖，
      // 否则切工程时在飞任务从数组消失 → 轮询回调找不到落点 → 永久卡在 generating。
      // 其它工程的已完成记录不保留：切回该工程时从它自己的 JSON 重新读取。
      const keepInflight = opts.getPersistableInflightRecords().filter((rec) => {
        if (cur.guid) return rec.projectGuid !== cur.guid;
        return rec.projectPath !== cur.path;
      });
      shared.records.value = [...fromDisk, ...keepInflight];
      // 注意:不再覆盖 opts.storageMode —— 现在 storageMode 靠实时 probePrimary()
      // (main-webview mount + onProjectChanged 时跑)刷新,JSON 里的 storageMode 字段
      // 仍保留以便 migrate 历史数据,但不参与 UI 显示判断。
      // 提示词优化历史(不入 records,独立字段;若盘上缺省为空数组)
      // 只替换「归属当前工程」的那部分:其它工程的优化项继续留在内存,
      // 它们各自写回自己工程的 JSON。若一并替换掉,写回时(见 persistRecords)
      // 旧工程分组会拿到空数组,把它 JSON 里已有的优化历史覆盖掉。
      const fromOtherProjects = promptOptimizations.value.filter(
        (o) => (o.projectPath ?? cur.path) !== cur.path,
      );
      promptOptimizations.value = [
        ...fromOtherProjects,
        // 归属收养：与 records 同语义，磁盘读出的优化历史重打为当前工程。
        // 否则拷贝目录后 persist 会把它们按旧绝对路径分组，在新机器上写出
        // 指向不存在目录的幽灵组（primary 失败 → 落到 fallback path-hash）。
        ...(data.promptOptimizations ?? []).map((o) => ({
          ...o,
          projectGuid: cur.guid,
          projectPath: cur.path,
        })),
      ];
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
      const keepInflight = opts.getPersistableInflightRecords().filter((rec) => {
        if (!cur) return true;
        if (cur.guid) return rec.projectGuid !== cur.guid;
        return rec.projectPath !== cur.path;
      });
      shared.records.value = [...keepInflight];
    }
  }

  let writeTimer: any = null;
  /** doPersist 重入保护:并行任务连续终态时,前一次写盘(含逐组 await)可能未结束 */
  let persistRunning = false;
  function schedulePersist(delay = 200) {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void doPersist();
    }, delay);
  }
  async function doPersist() {
    // 重入保护:上一次写盘未结束时,顺延调度而不是并发读写同一批 JSON
    if (persistRunning) {
      schedulePersist(300);
      return;
    }
    persistRunning = true;
    try {
      await doPersistInner();
    } finally {
      persistRunning = false;
    }
  }
  async function doPersistInner() {
    // 切工程加载期间 records 此刻是加载中间态，不能落盘；
    // 但不能丢弃这次写入 —— 延后重试（冻结窗口内的变更原实现会被永久吞掉）。
    if (switching.value) {
      schedulePersist(300);
      return;
    }
    // 按归属工程分组：多工程并行时每组单独写一个 JSON，
    // 否则会把所有工程的记录混进「当前活动工程」的文件里。
    // 优化历史与 records 同盘同路由，按各自自带的归属入组。
    const groups = new Map<
      string,
      {
        projectGuid: string;
        projectPath: string;
        records: GenerationRecord[];
        optimizations: PromptOptimization[];
      }
    >();
    const cur = shared.projectInfo.value;
    const ensureGroup = (guid: string, path: string) => {
      const key = guid || path;
      let g = groups.get(key);
      if (!g) {
        g = { projectGuid: guid, projectPath: path, records: [], optimizations: [] };
        groups.set(key, g);
      }
      return g;
    };
    // 落盘数据源 = records + inflight 权威副本（按 id 去重补齐）：
    // 切工程时 records 被整体替换（fromDisk + keepInflight），还没写进磁盘的
    // 在飞任务可能两个来源都不含 —— 此前它只留在 inflight，落盘层读不到，
    // 任务完成后凭空蒸发。这里从 inflight 补齐，保证权威状态始终落盘。
    const known = new Set(shared.records.value.map((r) => r.id));
    const inflightExtras = opts
      .getPersistableInflightRecords()
      .filter((r) => !known.has(r.id));
    for (const r of [...shared.records.value, ...inflightExtras]) {
      // 墓碑排除:已删记录(即使仍在飞)不再入组,否则合并时会复活
      if (deletedRecordIds.has(r.id)) continue;
      // 缺归属字段的历史记录归入当前工程（与读取时的补齐逻辑一致）
      const guid = r.projectGuid ?? cur?.guid ?? "";
      const path = r.projectPath ?? cur?.path ?? "";
      // 无路径归属：无法路由落盘，跳过
      if (!path) continue;
      ensureGroup(guid, path).records.push(r);
    }
    for (const opt of promptOptimizations.value) {
      // 优化历史同样按自身归属入组：归属在优化完成那刻已由 CaptureContext 锁定，
      // 之后切工程不会改变它。缺归属的旧数据归入当前工程。
      const guid = opt.projectGuid ?? cur?.guid ?? "";
      const path = opt.projectPath ?? cur?.path ?? "";
      if (!path) continue;
      ensureGroup(guid, path).optimizations.push(opt);
    }
    // 逐组写入；storageMode 只回写「当前工程」那一组的状态
    console.log(
      `[gen][persist] 分组数=${groups.size} currentGuid=${cur?.guid ?? "-"} currentPath=${cur?.path ?? "-"}`,
      [...groups.values()].map((g) => ({
        guid: g.projectGuid || "-",
        path: g.projectPath,
        count: g.records.length,
        promptOpts: g.optimizations.length,
      })),
    );
    for (const g of groups.values()) {
      // ---- 写前合并（防回退的核心）----
      // 内存对非活动工程只有 inflight 子集（loadRecords 切工程时故意不保留
      // 其它工程的已完成记录），若按内存全量覆盖，会把盘上该工程的已完成
      // 记录抹掉（JSON 回退）。因此每组写盘前先读盘上现有内容做并集：
      // - 内存有的以内存为准（轮询推进的最新状态）
      // - 仅盘上有的保留（切工程丢掉的、其它会话写入的）
      // - 命中墓碑的盘上记录排除（deleteRecord 的显式删除语义）
      // 读盘失败（非"文件不存在"）时保守跳过该组：宁可不写也不能盲覆盖。
      const disk = await bridge.recordsRead({ projectPath: g.projectPath });
      if (!disk.ok) {
        console.warn(
          `[gen][persist] 跳过写入（读盘失败，避免盲覆盖） path=${g.projectPath} err=${disk.error ?? "-"}`,
        );
        continue;
      }
      const diskData = disk.data;
      const memIds = new Set(g.records.map((r) => r.id));
      const diskOnly = (diskData?.records ?? []).filter(
        (r) => !memIds.has(r.id) && !deletedRecordIds.has(r.id),
      );
      const mergedRecords = [...g.records, ...diskOnly];
      const optKey = (o: PromptOptimization) =>
        `${o.createdAt}|${o.originalPrompt}`;
      const memOptKeys = new Set(g.optimizations.map(optKey));
      const mergedOpts = [
        ...g.optimizations,
        ...(diskData?.promptOptimizations ?? []).filter(
          (o) => !memOptKeys.has(optKey(o)),
        ),
      ];
      // promptOptimizations 与 records 同盘、同路由：
      // 每组只写自己归属的优化历史，不会把别的工程的历史覆盖成空数组。
      const data: ProjectRecords = {
        projectGuid: g.projectGuid,
        projectPath: g.projectPath,
        records: mergedRecords,
        storageMode: opts.storageMode.value,
        promptOptimizations: mergedOpts,
      };
      const w = await bridge.recordsWrite(data);
      console.log(
        `[gen][persist] 写入完成 path=${g.projectPath} count=${mergedRecords.length}(mem=${g.records.length}+disk=${diskOnly.length}) promptOpts=${mergedOpts.length} ok=${w.ok} mode=${w.storageMode ?? "-"} err=${w.error ?? "-"}`,
      );
      // 注意:写盘后不再用 w.storageMode 覆盖 opts.storageMode —— 该 ref 由实时
      // probePrimary() 驱动(mount + onProjectChanged),保证 UI 与当前可写性一致。
    }
  }

  /** 落盘入口（200ms 防抖）：由 records / promptOptimizations 的 deep watch 触发 */
  function persistRecords() {
    schedulePersist(200);
  }

  /**
   * 终态直通落盘:跳过 200ms 防抖立即写盘。
   * 任务终态时 inflight 副本已被摘除,records 是唯一内存副本;若此刻恰逢
   * 切工程/刷新(reloadRecords 会清防抖 timer),这次写入被取消且记录从
   * 内存消失 → 永不落盘。所以终态 commit 后必须由 useInflight 回调此函数,
   * 在防抖窗口开启前就把终态写进磁盘。
   */
  function persistNow() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    void doPersist();
  }

  watch(
    [shared.records, promptOptimizations],
    () => persistRecords(),
    { deep: true },
  );

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

  /** 把一次提示词优化结果 push 进 promptOptimizations 数组。
   * 不入 records 列表(UI 不显示);落入 records 同盘(共享 primary / fallback 路由),
   * 与 videoGen 落盘行为统一。
   */
  function recordPromptOptimization(opt: PromptOptimization) {
    promptOptimizations.value.push(opt);
  }

  return {
    constraints,
    generatedCount,
    loadRecords,
    /** 切工程 / 手动刷新共用的加载入口：清理挂起写入 + 冻结落盘 */
    reloadRecords,
    persistRecords,
    recordPromptOptimization,
    /** 终态直通落盘(跳过防抖,useInflight onTerminal 回调) */
    persistNow,
    promptOptimizations,
  };
}
