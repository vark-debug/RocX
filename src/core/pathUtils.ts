/**
 * 路径 / URL / UXP 文件系统基础抽象
 *
 * 提供:
 * - 扩展名工具
 * - nativePath <-> file:// URL 转换
 * - getEntryWithUrl / createEntryWithUrl 薄包装
 * - 按路径特征自动分派的 entry 查询(plugin-data 协议 URL / file:// 直连)
 *
 * 不依赖任何 core 模块;业务语义(marker、文件大小限制等)在 workDir / fileIO 中组合。
 */
import { uxp } from "../globals";

/** 取文件扩展名,小写无点 */
export function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}

/**
 * 把 nativePath 转成 UXP getEntryWithUrl 接受的 URL。
 *
 * 注意:UXP getEntryWithUrl/createEntryWithUrl 内部会自行做百分号编码,
 * 这里必须传未编码原始路径;预编码会被二次编码(% -> %25)导致找不到路径
 * Windows 绝对路径形如 "C:\...",必须用 file:///C:/...(三斜杠),
 * 否则 UXP 会把 "C:" 当作 host 之前的部分而解析失败(macOS 以 / 开头天然三斜杠,无需处理)
 * Windows 上 UXP 的 project.path 常带 "\\?\" 扩展长度前缀,需先去掉再拼 URL;
 * 不去的话 UXP 会把 "\\?\C:\" 当 host 处理,找不到条目(macOS 不存在此前缀)
 */
export function pathToFileUrl(p: string): string {
  if (p.startsWith("file://")) return p;
  const normalized = /^\\\\\?\\/.test(p) ? p.slice(4) : p;
  if (/^[A-Za-z]:[\\/]/.test(normalized)) return "file:///" + normalized;
  return "file://" + normalized;
}

/** 拿到 UXP localFileSystem(返回 any,调用方自行收窄) */
export function getFs(): any {
  return uxp.storage.localFileSystem;
}

async function getEntryInternal(url: string): Promise<any | null> {
  try {
    return await getFs().getEntryWithUrl(url);
  } catch (e) {
    return null;
  }
}

/** getEntryWithUrl 包装:失败返回 null 而不抛 */
export async function getEntry(url: string): Promise<any | null> {
  return await getEntryInternal(url);
}

/** getFolder 等价;UXP 端 file/folder 都走 getEntryWithUrl,仅靠 isFolder 区分 */
export async function getFolder(url: string): Promise<any | null> {
  return await getEntryInternal(url);
}

/** 已存在则返回,不存在则创建为 folder。失败返回 null */
export async function ensureFolder(url: string): Promise<any | null> {
  try {
    const existing = await getFs().getEntryWithUrl(url);
    if (existing) return existing;
    return await getFs().createEntryWithUrl(url, {
      type: uxp.storage.types.folder,
      overwrite: false,
    });
  } catch (e) {
    console.warn("ensureFolder failed", url, e);
    return null;
  }
}

/** 按 nativePath 拿 file entry */
export async function getFileByPath(p: string): Promise<any | null> {
  return await getEntry(pathToFileUrl(p));
}

/** 按 nativePath 拿 folder entry */
export async function getFolderByPath(p: string): Promise<any | null> {
  return await getFolder(pathToFileUrl(p));
}

/**
 * 按路径特征自动分派的通用文件查找:
 * 1) plugin-data 工作目录内(如 "<WORK_DIR_NAME>/...") -> plugin-data:/ / plugin-temp:/ 协议 URL
 *    (关键:plugin-data 容器内不能用顶级 file:// URL,会被沙箱拒绝)
 * 2) 其它路径 -> file:// 直连(PR 项目旁等用户可见目录)
 *
 * @param p 任意 nativePath
 * @param opts.pluginDataDirName 启用 plugin-data 分发的目录名(如 "AI-Generated-Media");
 *   不传则只走 file:// 分发,跳过 plugin-data 协议分支。
 */
export async function getEntryAnyPath(
  p: string,
  opts?: { pluginDataDirName?: string },
): Promise<any | null> {
  const fs = getFs();
  const normalized = String(p || "").replace(/\\/g, "/");
  // 只有真正的 plugin-data 容器路径才走协议 URL;
  // 用户目录下的 AI-Generated-Media(项目旁)不能误派到 plugin-data
  const isPluginData =
    /PluginData\//.test(normalized) || /PluginsStorage\//.test(normalized);
  if (isPluginData && opts?.pluginDataDirName) {
    const marker = `/${opts.pluginDataDirName}/`;
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const rel = normalized.slice(idx + marker.length);
      for (const proto of ["plugin-data", "plugin-temp"]) {
        try {
          const f = await fs.getEntryWithUrl(
            `${proto}:/${opts.pluginDataDirName}/${rel}`,
          );
          if (f && !f.isFolder) return f;
        } catch (e) {
          // try next
        }
      }
    }
  }
  try {
    const f = await getFileByPath(p);
    if (f && !f.isFolder) return f;
  } catch (e) {
    // ignore
  }
  return null;
}