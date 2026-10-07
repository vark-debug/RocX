/**
 * 生成记录 JSON 读写
 * 主路径：<项目文件所在目录>/<项目名>.ai-gen.json
 * 降级：插件数据目录（path hash 命名）
 * 写入路由来自 data.projectPath（记录自身归属工程），而非「调用瞬间的活动工程」，
 * 避免多工程并行时把 A 工程的记录写进 B 工程的文件。
 * 归属 guid 校验仅在缺少 projectPath、需回退到活动工程路径时生效。
 */
import { uxp } from "../globals";
import type { ProjectRecords } from "@shared/messages";
import { projectCore } from "./project";
import { pathToFileUrl, getFs } from "./pathUtils";

const FILENAME_SUFFIX = ".ai-gen.json";
const FALLBACK_DIR = "ai-gen-records";

/** 简易字符串 hash（FNV-1a），用于降级文件名 */
function hashPath(p: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 从工程路径推导工程名（去掉目录与扩展名），用于拼接 <项目名>.ai-gen.json */
function projectNameFromPath(projectPath: string): string {
  const base = projectPath.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 把归属路径拆成「JSON 所在目录 + 文件名基址」。
 *
 * 归属是抓素材时锁定的工程文件绝对路径（/x/B.prproj），落盘位置由此唯一确定。
 * 目录形态（/x/B）曾来自「参考素材父级反推」，那条推断路径已随 resolveOwner 一起删除；
 * 末段无扩展名时仍按目录名兜底，以兼容历史 JSON 里可能残留的旧形态 projectPath。
 */
function splitProjectPath(p: string): { dir: string; base: string } {
  // 先剥掉尾部分隔符，否则「/x/B/」的 lastSeg 会是空串，产出 ".ai-gen.json"
  const norm = p.replace(/[\\/]+$/, "");
  const lastSeg = norm.split(/[\\/]/).pop() || "";
  const dot = lastSeg.lastIndexOf(".");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return {
    dir: idx >= 0 ? norm.slice(0, idx) : norm,
    // 有扩展名则去扩展名；无扩展名按目录名兜底（历史 JSON 里的 projectPath 可能是旧形态）
    base: dot > 0 ? lastSeg.slice(0, dot) : lastSeg,
  };
}

function buildPrimaryPath(projectPath: string, projectName: string): {
  url: string;
  filename: string;
} {
  const { dir, base } = splitProjectPath(projectPath);
  // 目录形态归属：直接用目录名做文件名；文件形态：优先用调用方给的工程名
  const name = projectName || base;
  const sep = /\\/.test(projectPath) && !/\//.test(projectPath) ? "\\" : "/";
  // base 为空只可能是根目录（"/"）这类病态输入，兜底用 records 避免无名文件
  const safeName = (name || "records").replace(/[\\/:*?"<>|]/g, "_");
  // dir 为空（根目录）时直接用分隔符起头，保持绝对路径
  const prefix = dir ? dir + sep : sep;
  return {
    url: pathToFileUrl(prefix + safeName + FILENAME_SUFFIX),
    filename: safeName + FILENAME_SUFFIX,
  };
}

async function tryWriteToPrimary(
  projectPath: string,
  projectName: string,
  data: ProjectRecords,
): Promise<{ ok: boolean; error?: string }> {
  if (!projectPath) return { ok: false, error: "项目未保存（path 为空）" };
  try {
    const { url, filename } = buildPrimaryPath(projectPath, projectName);
    console.log(`[records] tryWriteToPrimary url=${url} filename=${filename}`);
    const fs = getFs();
    let entry: any;
    try {
      entry = await fs.getEntryWithUrl(url);
    } catch (e) {
      entry = null;
    }
    if (!entry) {
      entry = await fs.createEntryWithUrl(url, { overwrite: true });
    }
    const json = JSON.stringify(data, null, 2);
    await entry.write(json);
    console.log(`[records] tryWriteToPrimary 写盘成功`);
    return { ok: true };
  } catch (e: any) {
    console.warn(`[records] tryWriteToPrimary 失败: ${String(e?.message || e)}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

async function tryReadFromPrimary(
  projectPath: string,
  projectName: string,
): Promise<{ ok: boolean; data: ProjectRecords | null; error?: string }> {
  if (!projectPath) return { ok: false, data: null, error: "项目未保存" };
  try {
    const { url } = buildPrimaryPath(projectPath, projectName);
    const entry = await getFs().getEntryWithUrl(url);
    if (!entry) return { ok: true, data: null };
    const txt = await entry.read();
    const data = JSON.parse(txt) as ProjectRecords;
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, data: null, error: String(e?.message || e) };
  }
}

async function writeFallback(
  projectPath: string,
  data: ProjectRecords,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const fs = getFs();
    const root = await fs.getDataFolder();
    let dir: any;
    try {
      dir = await root.getEntry(FALLBACK_DIR);
    } catch (e) {
      dir = null;
    }
    if (!dir) {
      dir = await root.createEntry(FALLBACK_DIR, { overwrite: false });
    }
    const filename = `${hashPath(projectPath)}.json`;
    let entry: any;
    try {
      entry = await dir.getEntry(filename);
    } catch (e) {
      entry = null;
    }
    if (!entry) {
      entry = await dir.createEntry(filename, { overwrite: true });
    }
    await entry.write(JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function readFallback(
  projectPath: string,
): Promise<{ ok: boolean; data: ProjectRecords | null; error?: string }> {
  try {
    const root = await getFs().getDataFolder();
    let dir: any;
    try {
      dir = await root.getEntry(FALLBACK_DIR);
    } catch (e) {
      return { ok: true, data: null };
    }
    const filename = `${hashPath(projectPath)}.json`;
    let entry: any;
    try {
      entry = await dir.getEntry(filename);
    } catch (e) {
      return { ok: true, data: null };
    }
    const txt = await entry.read();
    return { ok: true, data: JSON.parse(txt) as ProjectRecords };
  } catch (e: any) {
    return { ok: false, data: null, error: String(e?.message || e) };
  }
}

/**
 * 实时探针:试在 primary 路径下 createEntry + write + delete 一个临时小文件,
 * 确认当前 primary 路径实际可写。fallback(降级)路径不影响此判断。
 *
 * 用法:webview 端 onMounted / onProjectChanged 时调一次,刷新 storageMode 提示。
 * 比读盘 JSON 的 storageMode 更准确(不受历史残留影响)。
 */
async function probePrimaryForProject(
  projectPath: string,
): Promise<{ primaryAvailable: boolean; error?: string }> {
  if (!projectPath) return { primaryAvailable: false };
  try {
    const fs = getFs();
    const { dir } = splitProjectPath(projectPath);
    const sep = /\\/.test(projectPath) && !/\//.test(projectPath) ? "\\" : "/";
    // 探针文件名:仅占位(空 {} ),后缀 .probe 避免与真实记录冲突
    const probeName = ".ai-gen-probe.json";
    const probeUrl = pathToFileUrl(
      (dir ? dir + sep : sep) + probeName,
    );
    let entry: any;
    try {
      entry = await fs.createEntryWithUrl(probeUrl, { overwrite: true });
    } catch (e) {
      return { primaryAvailable: false, error: String((e as any)?.message || e) };
    }
    try {
      await entry.write("{}");
    } catch (e) {
      try { await entry.delete(); } catch {}
      return { primaryAvailable: false, error: String((e as any)?.message || e) };
    }
    try {
      await entry.delete();
    } catch {}
    return { primaryAvailable: true };
  } catch (e: any) {
    return { primaryAvailable: false, error: String(e?.message || e) };
  }
}

export const recordsCore = {
  /**
   * 实时探针:试在当前活动工程的 primary 路径下写一个临时小文件,
   * 返回当前 primary 路径实际可写性。
   * - primaryAvailable=true → storageMode 视为 "primary"
   * - primaryAvailable=false → storageMode 视为 "fallback"(⚠ 显示)
   */
  async probePrimary(target?: { projectPath?: string }): Promise<{
    ok: boolean;
    primaryAvailable: boolean;
    error?: string;
  }> {
    const live = await projectCore.getCurrent();
    const projectPath = target?.projectPath || live?.path || "";
    if (!projectPath) {
      return { ok: false, primaryAvailable: false, error: "无活动项目" };
    }
    const r = await probePrimaryForProject(projectPath);
    return { ok: true, primaryAvailable: r.primaryAvailable, error: r.error };
  },
  /**
   * 读取记录。
   * @param target 指定要读哪个工程。缺省读「实时活动工程」。
   *   多工程并行时 PR 的 getActiveProject() 可能滞后于 webview 已知的当前工程
   *   （尤其是宿主窗口焦点变化时），此时显式传入可保证读写指向同一工程。
   *   读取路由与 write() 对称：都由调用方给出归属，不再各自猜测。
   */
  async read(target?: { projectGuid?: string; projectPath?: string }): Promise<{
    ok: boolean;
    data: ProjectRecords | null;
    error?: string;
    fallbackPath?: string;
  }> {
    const live = await projectCore.getCurrent();
    // 归属用调用方指定的工程路径；guid 仅作返回信息，路径才是路由依据。
    const path = target?.projectPath || live?.path || "";
    if (!path) return { ok: false, data: null, error: "无活动项目" };
    const cur = {
      path,
      guid: target?.projectGuid || live?.guid || "",
      name: projectNameFromPath(path),
    };
    console.log(
      `[records][read] 指定工程 guid=${cur.guid || "-"} path=${cur.path} | 实时活动工程 guid=${live?.guid ?? "-"} path=${live?.path ?? "-"}`,
    );

    const primary = await tryReadFromPrimary(cur.path, cur.name);
    if (primary.ok) {
      if (primary.data) {
        primary.data.storageMode = "primary";
        return primary;
      }
      return {
        ok: true,
        data: {
          projectGuid: cur.guid,
          projectPath: cur.path,
          records: [],
          storageMode: "primary",
        },
      };
    }
    const fb = await readFallback(cur.path);
    if (fb.ok && fb.data) {
      fb.data.storageMode = "fallback";
      return fb;
    }
    // 两处都读不到（典型场景：当前工程从未生成过，还没有 records JSON）：
    // 仍必须返回 ok + 当前工程信息，调用方据此把 projectInfo 校正为当前活动工程。
    // 否则工程切换后若读盘失败，调用方会沿用上一个工程的身份，
    // 导致新生成的记录被写到上一个工程的 JSON 里。
    return {
      ok: true,
      data: {
        projectGuid: cur.guid,
        projectPath: cur.path,
        records: [],
        storageMode: "fallback",
      },
    };
  },

  async write(data: ProjectRecords): Promise<{
    ok: boolean;
    error?: string;
    storageMode: "primary" | "fallback";
  }> {
    const cur = await projectCore.getCurrent();

    // 落盘路由：优先用记录自身归属的 data.projectPath（多工程下 webview 端已按归属分组，
    // 每组带着自己的 projectPath 提交，这里按它写就是写回该记录真正所属的工程）
    const targetPath = data.projectPath || cur?.path || "";
    console.log(
      `[records][write] data.guid=${data.projectGuid || "-"} data.path=${data.projectPath || "-"} cur.guid=${cur?.guid ?? "-"} cur.path=${cur?.path ?? "-"} count=${data.records.length} -> target=${targetPath || "-"}`,
    );

    // 归属校验：只在「缺少 projectPath、只能回退到活动工程路径」时才需要。
    // 此时若归属 guid 与活动工程不符，说明调用期间工程已被切换，必须在文件操作前拒绝，
    // 否则会把记录写进错误工程的文件。
    // 有 projectPath 时不校验：它本身就是权威归属（多工程并行时活动工程可能是另一个）
    if (!data.projectPath && cur && data.projectGuid && data.projectGuid !== cur.guid) {
      console.warn(
        `[records] write 拒绝（guid 不匹配）record.projectGuid=${data.projectGuid} cur.guid=${cur.guid} cur.path=${cur.path}`,
      );
      return {
        ok: false,
        error: "工程已切换，记录未写入（归属 guid 不匹配）",
        storageMode: cur ? "primary" : "fallback",
      };
    }

    if (!targetPath) {
      console.warn("[records] write 失败：无活动项目且记录缺少 projectPath");
      return { ok: false, error: "无活动项目", storageMode: "primary" };
    }
    // 文件名基址:始终从 targetPath 推导(去扩展名),不用 cur.name。
    // 之前 cur && cur.path === targetPath 分支用 cur.name,在 PR Project API 下
    // 包含 .prproj 扩展名 → 产出 "B.prproj.ai-gen.json";而历史归属路径分支
    // 用 basename 去扩展名 → "B.ai-gen.json",两者不一致会同时写出两个文件。
    const targetName = splitProjectPath(targetPath).base;

    // 写盘前剥离 thumbDataUrl（base64 data URL 会让 JSON 膨胀到几 MB，
    // 视频缩略图在 webview 端按需通过 readAsDataUrl(workFile) 重新读取）。
    // 注意:不仅 records.references 需要剥离,promptOptimizations 数组内的
    // references 也必须同样处理 —— 否则 base64 进 JSON 会让 payload 过大,
    // tryWriteToPrimary 失败,自动 fallback 到 plugin-data 路径。
    const sanitizeRefs = (refs: any[]) =>
      refs.map((ref) => {
        const { thumbDataUrl: _omit, ...rest } = ref as any;
        return rest;
      });
    const sanitized: ProjectRecords = {
      ...data,
      records: data.records.map((r) => ({
        ...r,
        references: sanitizeRefs(r.references),
      })),
      promptOptimizations: (data.promptOptimizations ?? []).map((opt) => ({
        ...opt,
        references: sanitizeRefs(opt.references),
      })),
    };

    const primary = await tryWriteToPrimary(targetPath, targetName, sanitized);
    if (primary.ok) {
      console.log(
        `[records] write 成功 storageMode=primary target=${targetPath}`,
      );
      return { ok: true, storageMode: "primary" };
    }
    const fb = await writeFallback(targetPath, sanitized);
    if (fb.ok) {
      console.log(
        `[records] write 成功 storageMode=fallback target=${targetPath}`,
      );
      return { ok: true, storageMode: "fallback" };
    }
    return {
      ok: false,
      error: primary.error || fb.error || "写入失败",
      storageMode: "fallback",
    };
  },
};