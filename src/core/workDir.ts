/**
 * 工作目录 / 子目录管理 + 文件大小与扩展名限制常量
 *
 * 提供:
 * - 模块常量 (WORK_DIR_NAME / PROJECT_IMPORT_SUBDIR / SUPPORTED_EXTS / SIZE_LIMITS)
 * - 工作目录 plugin-data:/AI-Generated-Media/ 的创建与打开
 * - 项目旁 AI_Generated_Media/Imports 或 AI_Generated_Media/References 子目录创建
 * - 文件复制到工作目录(saveFileToWorkDir)
 *
 * 不依赖 fileIO / psLauncher;路径/URL 转换从 pathUtils 取。
 */
import { uxp } from "../globals";
import { getFs, pathToFileUrl } from "./pathUtils";
import type { FileKind } from "@shared/messages";

export const WORK_DIR_NAME = "AI-Generated-Media";
export const PROJECT_IMPORT_SUBDIR = "AI_Generated_Media";

export const SUPPORTED_EXTS: Record<FileKind, string[]> = {
  video: ["mp4", "mov"],
  audio: ["wav", "mp3"],
  image: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
};

export const SIZE_LIMITS: Record<FileKind, number> = {
  video: 50 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
  image: 30 * 1024 * 1024,
};

export const workDirCore = {
  /** 确保插件数据目录下的 AI-Generated-Media 子目录存在（且真的是文件夹） */
  async ensureWorkDir(): Promise<any | null> {
    const fs = getFs();
    const url = "plugin-data:/" + WORK_DIR_NAME;
    let dir: any = null;
    try {
      // 直接用 getEntryWithUrl（不会跨 Comlink 边界序列化 Folder）
      dir = await fs.getEntryWithUrl(url);
    } catch {
      dir = null;
    }
    if (dir && dir.isFolder) return dir;
    // 历史遗留：同名"文件"占了工作目录位置 → 删掉重建为文件夹
    if (dir && dir.isFile) {
      try {
        await dir.delete();
      } catch (e) {
        console.warn("[files] 移除损坏的工作目录条目失败", e);
      }
    }
    try {
      return await fs.createEntryWithUrl(url, {
        type: uxp.storage.types.folder, // 注意：types 在 uxp.storage 上，不在 localFileSystem 上
        overwrite: false,
      });
    } catch (e) {
      console.warn("ensureWorkDir failed", e);
      return null;
    }
  },

  /**
   * 获取 plugin-data:/AI-Generated-Media/ 的 token
   * （如果不存在则创建；这是 Adobe 官方推荐的、Premiere API 也能写入的位置）
   */
  async ensureWorkDirAsDataUrl(): Promise<any | null> {
    try {
      const fs = getFs();
      // 先尝试 plugin-data:/AI-Generated-Media/
      let dir: any = null;
      try {
        dir = await fs.getEntryWithUrl("plugin-data:/AI-Generated-Media");
      } catch (e) {
        dir = null;
      }
      if (!dir) {
        dir = await fs.createEntryWithUrl("plugin-data:/AI-Generated-Media", {
          type: uxp.storage.types.folder,
          overwrite: false,
        });
      }
      return dir;
    } catch (e) {
      console.warn("ensureWorkDirAsDataUrl failed", e);
      return null;
    }
  },

  /** 返回生成工作目录的 nativePath */
  async getWorkDirPath(): Promise<string> {
    try {
      const dir = await this.ensureWorkDir();
      if (!dir) return `<plugin-data>/${WORK_DIR_NAME}`;
      const p = await getFs().getNativePath(dir);
      return p || `<plugin-data>/${WORK_DIR_NAME}`;
    } catch (e) {
      return `<plugin-data>/${WORK_DIR_NAME}`;
    }
  },

  /** 用系统文件管理器打开工作目录 */
  async openWorkDir(): Promise<{ ok: boolean; error?: string }> {
    try {
      const dir = await this.ensureWorkDir();
      if (!dir) return { ok: false, error: "无法获取工作目录" };
      const uxpAny: any = require("uxp");
      const nativePath = await getFs().getNativePath(dir);
      await uxpAny.shell.openPath(nativePath);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /** 把 File token 复制到生成工作目录 */
  async saveFileToWorkDir(
    file: any,
    suggestedName: string,
  ): Promise<{ ok: boolean; nativePath?: string; error?: string }> {
    try {
      const dir = await this.ensureWorkDir();
      if (!dir) return { ok: false, error: "无法获取工作目录" };
      let name = suggestedName;
      let counter = 1;
      while (await dir.getEntry(name)) {
        const dot = suggestedName.lastIndexOf(".");
        name =
          dot > 0
            ? `${suggestedName.slice(0, dot)}_${counter}${suggestedName.slice(dot)}`
            : `${suggestedName}_${counter}`;
        counter++;
      }
      const copied = await file.copyTo(dir, name, { overwrite: false });
      const nativePath = copied.nativePath || (await getFs().getNativePath(copied));
      return { ok: true, nativePath };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 在指定目录下逐级创建/获取子目录（支持 "a/b" 多级）。
   * 返回 Folder entry 与其 nativePath。
   */
  async ensureProjectSubdir(
    projectDir: string,
    sub: string,
  ): Promise<{ ok: boolean; folder?: any; dirPath?: string; error?: string }> {
    try {
      if (!projectDir) return { ok: false, error: "项目目录为空" };
      const fs = getFs();
      const sep = projectDir.includes("\\") ? "\\" : "/";
      const segs = sub.split("/").filter(Boolean);
      let curPath = projectDir;
      let curFolder: any = null;
      for (const seg of segs) {
        curPath = curPath + sep + seg;
        const url = pathToFileUrl(curPath);
        console.log(`[files] ensureProjectSubdir 查询: ${url}`);
        let f: any = null;
        try {
          f = await fs.getEntryWithUrl(url);
          console.log(`[files] ensureProjectSubdir getEntry 结果: ${f ? "命中" : "未命中"}`);
        } catch (e: any) {
          console.log(`[files] ensureProjectSubdir getEntry 异常: ${String(e?.message || e)}`);
          f = null;
        }
        if (!f) {
          try {
            console.log(`[files] ensureProjectSubdir 尝试创建: ${url}`);
            f = await fs.createEntryWithUrl(url, {
              type: uxp.storage.types.folder,
              overwrite: false,
            });
            console.log(`[files] ensureProjectSubdir 创建成功`);
          } catch (e: any) {
            console.log(`[files] ensureProjectSubdir 创建失败: ${String(e?.message || e)}`);
            return { ok: false, error: `无法创建目录 ${curPath}: ${String(e?.message || e)}` };
          }
        }
        if (!f || !f.isFolder) {
          return { ok: false, error: `同名文件占用了目录位置: ${curPath}` };
        }
        curFolder = f;
      }
      const nativePath =
        curFolder.nativePath || (await fs.getNativePath(curFolder)) || curPath;
      return { ok: true, folder: curFolder, dirPath: nativePath };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 参考素材（截图/抓视频）目录：
   * 优先 PR 项目旁 AI_Generated_Media/References/（与生成记录同位置、独立文件夹）；
   * 项目未保存或创建失败时降级 plugin-data:/AI-Generated-Media/References/。
   */
  async ensureReferencesDir(projectPath?: string): Promise<{
    ok: boolean;
    folder?: any;
    dirPath?: string;
    error?: string;
  }> {
    if (projectPath) {
      const projectDir = projectPath.replace(/[\\/][^\\/]+$/, "");
      if (projectDir) {
        const r = await this.ensureProjectSubdir(
          projectDir,
          `${WORK_DIR_NAME}/References`,
        );
        if (r.ok) return r;
        console.warn("[files] 项目旁 References 目录创建失败，降级 plugin-data:", r.error);
      }
    }
    // 降级：plugin-data:/AI-Generated-Media/References/
    const workDir = await this.ensureWorkDir();
    if (!workDir) return { ok: false, error: "无法创建参考素材目录（plugin-data 不可访问）" };
    try {
      let sub: any = null;
      try {
        sub = await workDir.getEntry("References");
      } catch (e) {
        sub = null;
      }
      if (!sub) {
        sub = await workDir.createEntry("References", { overwrite: false });
      }
      if (!sub || !sub.isFolder) {
        return { ok: false, error: "References 被同名文件占用" };
      }
      const fs = getFs();
      const nativePath = sub.nativePath || (await fs.getNativePath(sub));
      return { ok: true, folder: sub, dirPath: nativePath };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};