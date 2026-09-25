/**
 * 文件 IO：FilePicker、目录创建、文件拷贝、本地路径分桶
 *
 * 使用 uxp.storage.localFileSystem + getEntryWithUrl/createEntryWithUrl (file:// URL)
 * 要求 manifest 中 localFileSystem: "fullAccess"
 */
import { uxp } from "../globals";
import type { FileKind, ReferenceItem } from "@shared/messages";

export const WORK_DIR_NAME = "AI-Generated-Media";
export const PROJECT_IMPORT_SUBDIR = "AI_Generated_Media";

const SUPPORTED_EXTS: Record<FileKind, string[]> = {
  video: ["mp4", "mov"],
  audio: ["wav", "mp3"],
  image: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
};

const SIZE_LIMITS: Record<FileKind, number> = {
  video: 50 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
  image: 30 * 1024 * 1024,
};

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}

function pathToFileUrl(p: string): string {
  if (p.startsWith("file://")) return p;
  // 注意：UXP getEntryWithUrl/createEntryWithUrl 内部会自行做百分号编码，
  // 这里必须传未编码原始路径；预编码会被二次编码（% -> %25）导致找不到路径
  return "file://" + p;
}

function getFs(): any {
  return uxp.storage.localFileSystem;
}
export { getFs };

async function getEntry(url: string): Promise<any | null> {
  try {
    return await getFs().getEntryWithUrl(url);
  } catch (e) {
    return null;
  }
}

async function getFolder(url: string): Promise<any | null> {
  try {
    return await getFs().getEntryWithUrl(url);
  } catch (e) {
    return null;
  }
}

async function ensureFolder(url: string): Promise<any | null> {
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

async function pickFileByKind(kind: FileKind): Promise<any | null> {
  const exts = SUPPORTED_EXTS[kind];
  const filters = exts.map((e) => ({ name: e.toUpperCase(), extensions: [e] }));
  try {
    const file = await getFs().getFileForOpening({
      allowMultiple: false,
      types: filters,
    });
    return file || null;
  } catch (e: any) {
    if (String(e?.message || e).toLowerCase().includes("cancel")) return null;
    throw e;
  }
}

export function detectFileKind(filePath: string): FileKind | null {
  const ext = extOf(filePath);
  if (SUPPORTED_EXTS.video.includes(ext)) return "video";
  if (SUPPORTED_EXTS.audio.includes(ext)) return "audio";
  if (SUPPORTED_EXTS.image.includes(ext)) return "image";
  return null;
}

export const filesCore = {
  async pickAndValidate(kind: FileKind): Promise<{
    ok: boolean;
    file?: any;
    fileName?: string;
    nativePath?: string;
    sizeBytes?: number;
    error?: string;
  }> {
    try {
      const file = await pickFileByKind(kind);
      if (!file) return { ok: false, error: "用户取消选择" };
      const size = file.size || 0;
      const ext = extOf(file.name || "");
      if (!SUPPORTED_EXTS[kind].includes(ext)) {
        return { ok: false, error: `不支持的格式 .${ext}` };
      }
      if (size > SIZE_LIMITS[kind]) {
        return {
          ok: false,
          error: `文件大小超限（${(size / 1024 / 1024).toFixed(1)}MB > ${SIZE_LIMITS[kind] / 1024 / 1024}MB）`,
        };
      }
      return {
        ok: true,
        file,
        fileName: file.name,
        nativePath: file.nativePath || (await getFs().getNativePath(file)),
        sizeBytes: size,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

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

  async readFileBytes(file: any): Promise<ArrayBuffer | null> {
    try {
      const data = await file.read({ format: uxp.storage.formats.binary });
      return data as ArrayBuffer;
    } catch (e) {
      console.warn("readFileBytes fallback", e);
      try {
        return await file.read();
      } catch (e2) {
        console.error("readFileBytes failed", e2);
        return null;
      }
    }
  },

  /** 复制到 PR 项目旁子目录 */
  async copyToProject(
    fileOrPath: any | string,
    projectDir: string,
  ): Promise<{ ok: boolean; destPath?: string; error?: string }> {
    try {
      const fs = getFs();
      const destFolder = await this._getOrPickProjectFolder(projectDir);
      if (!destFolder) {
        return { ok: false, error: "无法访问 PR 项目目录（请在设置中选择）" };
      }

      const fileName =
        typeof fileOrPath === "string"
          ? fileOrPath.split("/").pop() || "import.mp4"
          : fileOrPath.name;
      let name = fileName;
      let counter = 1;
      while (await destFolder.getEntry(name)) {
        const dot = fileName.lastIndexOf(".");
        name =
          dot > 0
            ? `${fileName.slice(0, dot)}_${counter}${fileName.slice(dot)}`
            : `${fileName}_${counter}`;
        counter++;
      }
      // 创建/获取目标子目录 AI_Generated_Media
      let subDir: any;
      try {
        subDir = await destFolder.getEntry(PROJECT_IMPORT_SUBDIR);
      } catch (e) {
        subDir = null;
      }
      if (!subDir) {
        subDir = await destFolder.createEntry(PROJECT_IMPORT_SUBDIR, {
          overwrite: false,
        });
      }
      if (!subDir || subDir.isFile) {
        return { ok: false, error: "无法创建项目旁 AI_Generated_Media 子目录" };
      }

      let fileToken: any;
      if (typeof fileOrPath === "string") {
        // 源文件：通过 source token 或者 Folder token 拿
        const srcFile = await this._getSourceFileToken(fileOrPath);
        if (!srcFile) return { ok: false, error: "无法访问源文件" };
        fileToken = srcFile;
      } else {
        fileToken = fileOrPath;
      }
      const copied = await fileToken.copyTo(subDir, name, { overwrite: false });
      const destPath = copied.nativePath || (await fs.getNativePath(copied));
      return { ok: true, destPath };
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 已忽略用户取消
      if (msg.toLowerCase().includes("cancel")) {
        return { ok: false, error: "用户取消" };
      }
      return { ok: false, error: msg };
    }
  },

  /**
   * 拿到 PR 项目根目录的 Folder token。
   * 优先用持久化 token（用户在设置里选过的），没有就让用户现场选一次。
   */
  async _getOrPickProjectFolder(projectDir: string): Promise<any | null> {
    const fs = getFs();
    // 1) 用持久化 token
    try {
      const token = localStorage.getItem("MiniMax.projectFolderToken");
      if (token) {
        const folder = await fs.getEntryForPersistentToken(token);
        if (folder && folder.isFolder) {
          const np = folder.nativePath || (await fs.getNativePath(folder));
          if (np === projectDir) return folder;
        }
      }
    } catch (e) {
      localStorage.removeItem("MiniMax.projectFolderToken");
    }
    // 2) 让用户选一次 PR 项目根目录
    try {
      const folder = await fs.getFolder();
      if (folder && folder.isFolder) {
        const np = folder.nativePath || (await fs.getNativePath(folder));
        if (np !== projectDir) {
          console.warn(
            "[files] user-selected folder != project dir:",
            np,
            "vs",
            projectDir,
          );
        }
        try {
          const token = await fs.createPersistentToken(folder);
          localStorage.setItem("MiniMax.projectFolderToken", token);
        } catch (e) {
          console.warn("[files] createPersistentToken failed", e);
        }
        return folder;
      }
    } catch (e: any) {
      const msg = String(e?.message || e).toLowerCase();
      if (!msg.includes("cancel")) console.warn("[files] getFolder failed", e);
    }
    return null;
  },

  /**
   * 拿到源文件 Folder token。源文件可能在工作目录（已通过 getExportFolder 持久化），
   * 也可能在 PR 项目旁（已通过 projectFolderToken 持久化），也可能完全是任意路径（用户选的）。
   */
  async _getSourceFileToken(nativePath: string): Promise<any | null> {
    const fs = getFs();
    // 1) 已经在 exportFolder token 里？
    try {
      const token = localStorage.getItem("MiniMax.exportFolderToken");
      if (token) {
        const folder = await fs.getEntryForPersistentToken(token);
        if (folder && folder.isFolder) {
          try {
            const file = folder.getEntry
              ? await folder.getEntry(nativePath.split("/").pop() || "")
              : null;
            if (file && !file.isFolder) return file;
          } catch (e) {
            // 文件名匹配失败
          }
        }
      }
    } catch (e) {
      // ignore
    }
    // 2) 在 projectFolder token 里？
    try {
      const token = localStorage.getItem("MiniMax.projectFolderToken");
      if (token) {
        const folder = await fs.getEntryForPersistentToken(token);
        if (folder && folder.isFolder) {
          try {
            const file = await folder.getEntry(
              nativePath.split("/").pop() || "",
            );
            if (file && !file.isFolder) return file;
          } catch (e) {
            // not found
          }
          // 也找 AI_Generated_Media 子目录
          try {
            const sub = await folder.getEntry(PROJECT_IMPORT_SUBDIR);
            if (sub && sub.isFolder) {
              const file = await sub.getEntry(
                nativePath.split("/").pop() || "",
              );
              if (file && !file.isFolder) return file;
            }
          } catch (e) {
            // not found
          }
        }
      }
    } catch (e) {
      // ignore
    }
    // 3) 退路：让用户选一次源文件
    try {
      const file = await fs.getFileForOpening({ allowMultiple: false });
      if (file && file.isFile) {
        return file;
      }
    } catch (e) {
      console.warn("[files] getFileForOpening failed", e);
    }
    return null;
  },

  async toLocalFileUrl(localPath: string): Promise<string> {
    if (!localPath) return "";
    if (localPath.startsWith("file://")) return localPath;
    const plainUrl = "file://" + localPath.replace(/ /g, "%20");
    const normalized = String(localPath).replace(/\\/g, "/");
    // webview(WKWebView) 只能加载插件容器内的本地资源；项目旁 Imports/References
    // 等用户目录的 file:// 会被拒绝（Not allowed to load local resource）
    // → 复制到 plugin-data 预览缓存（按文件名幂等），返回容器内 file:// URL
    const inContainer =
      /PluginData\//.test(normalized) || /PluginsStorage\//.test(normalized);
    if (inContainer) return plainUrl;
    try {
      const fs = getFs();
      const src = await this.getEntryAnyPath(localPath);
      if (!src || src.isFolder) return plainUrl;
      let dir: any = null;
      try {
        dir = await fs.getEntryWithUrl("plugin-data:/preview-cache");
      } catch (e) {
        dir = null;
      }
      if (!dir) {
        dir = await fs.createEntryWithUrl("plugin-data:/preview-cache", {
          type: uxp.storage.types.folder,
          overwrite: false,
        });
      }
      if (!dir) return plainUrl;
      const name = normalized.split("/").pop() || `file-${Date.now()}`;
      let dest: any = null;
      try {
        dest = await dir.getEntry(name);
      } catch (e) {
        dest = null;
      }
      if (!dest) {
        try {
          dest = await src.copyTo(dir, name, { overwrite: false });
        } catch (e) {
          // 并发/重名兜底：再查一次
          try {
            dest = await dir.getEntry(name);
          } catch (e2) {
            dest = null;
          }
        }
      }
      if (!dest) return plainUrl;
      const np = dest.nativePath || (await fs.getNativePath(dest));
      return "file://" + String(np).replace(/ /g, "%20");
    } catch (e) {
      return plainUrl;
    }
  },

  /**
   * 把视频 / 图片读成 base64 data URL，让 WebView 直接 <video>/<img src=""> 显示
   * 避免 file:// 被 WebView 拦截。
   */
  async readAsDataUrl(fileOrPath: any | string): Promise<{
    ok: boolean;
    dataUrl?: string;
    mime?: string;
    size?: number;
    error?: string;
  }> {
    try {
      let file = fileOrPath;
      if (typeof fileOrPath === "string") {
        file = await this.getFileByPath(fileOrPath);
        if (!file) return { ok: false, error: "无法访问文件" };
      }
      const ab = await this.readFileBytes(file);
      if (!ab) return { ok: false, error: "读取为空" };

      const bytes = new Uint8Array(ab);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const sub = bytes.subarray(i, i + CHUNK);
        bin += String.fromCharCode.apply(null, Array.from(sub));
      }
      const b64 = btoa(bin);

      // 根据扩展名推断 mime
      const name: string = file?.name || fileOrPath || "";
      const ext = extOf(name).toLowerCase();
      const mime =
        ext === "mp4"
          ? "video/mp4"
          : ext === "webm" || ext === "mov"
          ? "video/" + ext
          : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "png"
          ? "image/png"
          : ext === "gif"
          ? "image/gif"
          : ext === "webp"
          ? "image/webp"
          : "application/octet-stream";

      return {
        ok: true,
        dataUrl: `data:${mime};base64,${b64}`,
        mime,
        size: bytes.length,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  async getFileByPath(p: string): Promise<any | null> {
    return await getEntry(pathToFileUrl(p));
  },

  /**
   * 按路径特征自动分派的通用文件查找：
   * 1) plugin-data 工作目录内（AI-Generated-Media/...）→ plugin-data:/ 协议 URL
   *    （关键：plugin-data 容器内不能用顶级 file:// URL，会被沙箱拒绝）
   * 2) 其它路径 → file:// 直连（PR 项目旁等用户可见目录）
   */
  async getEntryAnyPath(p: string): Promise<any | null> {
    const fs = getFs();
    const normalized = String(p || "").replace(/\\/g, "/");
    // 只有真正的 plugin-data 容器路径才走协议 URL；
    // 用户目录下的 AI-Generated-Media（项目旁）不能误派到 plugin-data
    const isPluginData =
      /PluginData\//.test(normalized) || /PluginsStorage\//.test(normalized);
    if (isPluginData) {
      const marker = `/${WORK_DIR_NAME}/`;
      const idx = normalized.lastIndexOf(marker);
      if (idx >= 0) {
        const rel = normalized.slice(idx + marker.length);
        for (const proto of ["plugin-data", "plugin-temp"]) {
          try {
            const f = await fs.getEntryWithUrl(
              `${proto}:/${WORK_DIR_NAME}/${rel}`,
            );
            if (f && !f.isFolder) return f;
          } catch (e) {
            // try next
          }
        }
      }
    }
    try {
      const f = await this.getFileByPath(p);
      if (f && !f.isFolder) return f;
    } catch (e) {
      // ignore
    }
    return null;
  },

  /**
   * 等待文件落盘就绪：轮询 getEntryAnyPath 直到文件存在且 size>0。
   * UXP 的 moveTo/copy Promise resolve 只代表"操作已提交"，
   * PR 的 importFiles 直接读磁盘路径，必须等文件真实可见后再导入（时序竞争防御）。
   */
  async waitForFileReady(
    p: string,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      try {
        const f = await this.getEntryAnyPath(p);
        if (f && !f.isFolder) {
          // 注意：部分 UXP 版本 entry.size 可能为 undefined/0（未 stat），
          // 移动是原子操作不存在半写文件，存在即视为就绪，size 仅作参考
          if (attempts <= 2) {
            console.log(
              `[files] waitForFileReady 命中(${attempts}): size=${f.size} ${p}`,
            );
          }
          return { ok: true, size: f.size };
        }
        if (attempts === 1) {
          console.warn(
            `[files] waitForFileReady 未找到文件，继续轮询: ${p}`,
          );
        }
      } catch (e) {
        // not ready yet, keep polling
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { ok: false, error: `导入前文件未就绪（等待超时）: ${p}` };
  },

  /**
   * 在已知 Folder entry 内等待文件落盘就绪（首选方式）：
   * folder.getEntry 直接查子文件，不走 URL、不依赖 size 可靠性。
   */
  async waitForFileReadyInFolder(
    folder: any,
    fileName: string,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    if (!folder) return { ok: false, error: "目标目录 entry 无效" };
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastErr = "";
    while (Date.now() < deadline) {
      attempts++;
      try {
        const f = await folder.getEntry(fileName);
        if (f && !f.isFolder) {
          if (attempts <= 2) {
            console.log(
              `[files] waitForFileReadyInFolder 命中(${attempts}): size=${f.size} ${fileName}`,
            );
          }
          return { ok: true, size: f.size };
        }
        lastErr = "entry 为空";
      } catch (e: any) {
        lastErr = String(e?.message || e);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      ok: false,
      error: `导入前文件未就绪（等待超时）: ${fileName}（${lastErr || "始终未出现在目标目录"}）`,
    };
  },

  async getFolderByPath(p: string): Promise<any | null> {
    return await getFolder(pathToFileUrl(p));
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

  /** 把文件移动到目标目录。采用 copyTo + delete 两阶段原子流程，避免 moveTo 的 fire-and-forget race。 */
  async moveFileToDir(
    filePath: string,
    destFolder: any,
    fileName: string,
  ): Promise<{ ok: boolean; newPath?: string; error?: string }> {
    try {
      // plugin-data 容器内必须走协议 URL，file:// 会被沙箱拒绝 → 用 getEntryAnyPath
      const file = await this.getEntryAnyPath(filePath);
      if (!file) {
        // 源不可访问：兜底检查目标目录是否已有同名文件（上次移动残留）→ 自愈使用
        try {
          const d = await destFolder.getEntry(fileName);
          if (d && !d.isFolder) {
            const np = d.nativePath || (await getFs().getNativePath(d));
            console.log(
              `[files] 源不可访问但目标目录已有同名文件，自愈使用: ${np}`,
            );
            return { ok: true, newPath: np };
          }
        } catch (e) {
          // 目标也没有，真正失败
        }
        return { ok: false, error: `源文件不可访问: ${filePath}` };
      }

      // 目标已存在 → 生成 _1 / _2 后缀（保持现有重名策略）
      let finalName = fileName;
      let counter = 1;
      while (true) {
        let exists = false;
        try {
          const d = await destFolder.getEntry(finalName);
          if (d && !d.isFolder) exists = true;
        } catch (e) {
          // not found
        }
        if (!exists) break;
        const dot = fileName.lastIndexOf(".");
        finalName =
          dot > 0
            ? `${fileName.slice(0, dot)}_${counter}${fileName.slice(dot)}`
            : `${fileName}_${counter}`;
        counter++;
      }

      // 两阶段原子：copyTo + 校验落盘 + delete
      const copied = await file.copyTo(destFolder, finalName, {
        overwrite: false,
      });
      const newPath = copied.nativePath || (await getFs().getNativePath(copied));

      // 校验目标文件已真实可见
      const verify = await this.waitForFileReadyInFolder(destFolder, finalName, 3000);
      if (!verify.ok) {
        return { ok: false, error: `复制后目标文件未就绪: ${verify.error}` };
      }

      // 删除源
      try {
        await file.delete();
      } catch (e) {
        console.warn("[files] 源文件删除失败（保留副本，不影响功能）:", e);
      }

      return { ok: true, newPath };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};