/**
 * 文件 IO:FilePicker / 校验 / 读字节 / 复制到项目旁 / 移动 / 落盘就绪轮询
 *
 * 提供:
 * - 文件类型识别 (detectFileKind)
 * - FilePicker + 扩展名与大小校验 (pickAndValidate)
 * - 读字节 (readFileBytes)
 * - 复制到 PR 项目旁子目录 (copyToProject / _getOrPickProjectFolder / _getSourceFileToken)
 * - 移动到目标目录 (moveFileToDir,两阶段原子)
 * - 等待文件落盘就绪 (waitForFileReady / waitForFileReadyInFolder)
 *
 * 路径 / URL 转换从 pathUtils 取;目录与常量从 workDir 取;不在本模块依赖 psLauncher / previewUrl。
 */
import { uxp } from "../globals";
import { getFs, getEntryAnyPath, extOf } from "./pathUtils";
import {
  WORK_DIR_NAME,
  PROJECT_IMPORT_SUBDIR,
  SUPPORTED_EXTS,
  SIZE_LIMITS,
} from "./workDir";
import type { FileKind } from "@shared/messages";

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

export const fileIOCore = {
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

  /**
   * 等待文件落盘就绪：轮询 getEntryAnyPath 直到文件存在。
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
        const f = await getEntryAnyPath(p, { pluginDataDirName: WORK_DIR_NAME });
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

  /** 把文件移动到目标目录。采用 copyTo + delete 两阶段原子流程，避免 moveTo 的 fire-and-forget race。 */
  async moveFileToDir(
    filePath: string,
    destFolder: any,
    fileName: string,
  ): Promise<{ ok: boolean; newPath?: string; error?: string }> {
    try {
      // plugin-data 容器内必须走协议 URL，file:// 会被沙箱拒绝 → 用 getEntryAnyPath
      const file = await getEntryAnyPath(filePath, {
        pluginDataDirName: WORK_DIR_NAME,
      });
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
      const verify = await this.waitForFileReadyInFolder(
        destFolder,
        finalName,
        3000,
      );
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

/** 顶层 export 的 readFileBytes(供 previewUrl 等模块单独调用) */
export const readFileBytes = fileIOCore.readFileBytes;