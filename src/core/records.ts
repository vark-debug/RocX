/**
 * 生成记录 JSON 读写
 * 主路径：<项目文件所在目录>/<项目名>.ai-gen.json
 * 降级：插件数据目录（path hash 命名）
 */
import { uxp } from "../globals";
import type { ProjectRecords } from "./messages";
import { projectCore } from "./project";

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

function pathToFileUrl(p: string): string {
  if (p.startsWith("file://")) return p;
  // UXP getEntryWithUrl 内部自行百分号编码；预编码（含空格->%20）会被二次编码导致找不到
  return "file://" + p;
}

function getFs(): any {
  return uxp.storage.localFileSystem;
}

function buildPrimaryPath(projectPath: string, projectName: string): {
  url: string;
  filename: string;
} {
  const sep = "/";
  const idx = projectPath.lastIndexOf(sep);
  const dir = idx >= 0 ? projectPath.slice(0, idx) : projectPath;
  const safeName = projectName.replace(/[\\/:*?"<>|]/g, "_");
  return {
    url: pathToFileUrl(dir + sep + safeName + FILENAME_SUFFIX),
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
    const { url } = buildPrimaryPath(projectPath, projectName);
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
    return { ok: true };
  } catch (e: any) {
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

export const recordsCore = {
  async read(): Promise<{
    ok: boolean;
    data: ProjectRecords | null;
    error?: string;
    fallbackPath?: string;
  }> {
    const cur = await projectCore.getCurrent();
    if (!cur) return { ok: false, data: null, error: "无活动项目" };

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
    return {
      ok: false,
      data: null,
      error: primary.error || fb.error || "读取失败",
    };
  },

  async write(data: ProjectRecords): Promise<{
    ok: boolean;
    error?: string;
    storageMode: "primary" | "fallback";
  }> {
    const cur = await projectCore.getCurrent();
    if (!cur) return { ok: false, error: "无活动项目", storageMode: "primary" };

    // 写盘前剥离 thumbDataUrl（base64 data URL 会让 JSON 膨胀到几 MB，
    // 视频缩略图在 webview 端按需通过 readAsDataUrl(workFile) 重新读取）
    const sanitized: ProjectRecords = {
      ...data,
      records: data.records.map((r) => ({
        ...r,
        references: r.references.map((ref) => {
          const { thumbDataUrl: _omit, ...rest } = ref as any;
          return rest;
        }),
      })),
    };

    const primary = await tryWriteToPrimary(cur.path, cur.name, sanitized);
    if (primary.ok) return { ok: true, storageMode: "primary" };
    const fb = await writeFallback(cur.path, sanitized);
    if (fb.ok) return { ok: true, storageMode: "fallback" };
    return {
      ok: false,
      error: primary.error || fb.error || "写入失败",
      storageMode: "fallback",
    };
  },
};