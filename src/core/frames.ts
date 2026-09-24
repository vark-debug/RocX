/**
 * 抓取当前 playhead 位置的帧（JPG）→ 上传到 MiniMax → 返回 ReferenceItem
 *
 * 关键：filepath 必须是用户通过 FilePicker 选过的 nativePath（不能是 plugin-data:/ URL）。
 * Adobe 官方 premiere-api 样本做法：getFolder() 拿一个用户授权的 Folder，把 nativePath
 * 直接传给 exportSequenceFrame 的 filepath 参数。
 *
 * 子文件访问：必须用 Folder token 的 getEntry()/getEntries()，不能用顶级 file:// URL
 * （沙箱权限隔离）。文件查找不依赖 Adobe 25.3 的命名 bug（.png 加 .png 后缀），而是列出
 * 目录后按 capture-<timestamp>.<ext> 正则匹配最新文件。
 */
import { premierepro, uxp } from "../globals";
import { filesCore, getFs } from "./files";
import { uploadCore } from "./ai/upload";
import { storage } from "./storage";
import type { ReferenceItem } from "./messages";

function safeStr(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function arrayBufferToBase64(ab: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(ab);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(bin);
}

/**
 * 参考素材目录：PR 项目旁 AI_Generated_Media/References/（与生成记录同位置、独立文件夹）。
 * 项目未保存或创建失败时降级 plugin-data:/AI-Generated-Media/References/。
 * （旧的"用户自选导出目录 + 持久 token"机制已废弃，token 逻辑仅保留在
 * uploadReferenceFile 里用于兼容历史素材。）
 */
async function getReferenceDir(projectPath?: string): Promise<{
  ok: boolean;
  folder?: any;
  dirPath?: string;
  error?: string;
}> {
  return await filesCore.ensureReferencesDir(projectPath);
}

export const framesCore = {
  /**
   * 只导出 + 读取缩略图，**不上传**（用于"立即显示 + 后台上传"的两阶段流程）
   * 返回 reference，fileId/uploadedAt 为 undefined
   */
  async captureOnlyAsReference(opts: {
    width?: number;
    height?: number;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    error?: string;
  }> {
    console.log("[frames] captureOnlyAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const sequence = await project.getActiveSequence();
      if (!sequence) return { ok: false, error: "无活动序列，请先激活一个序列" };

      const time = await sequence.getPlayerPosition();

      const dirR = await getReferenceDir(project.path);
      if (!dirR.ok || !dirR.folder || !dirR.dirPath) {
        return { ok: false, error: dirR.error || "无法创建参考素材目录" };
      }
      const exportFolder = dirR.folder;
      const exportFolderPath = dirR.dirPath;
      console.log("[frames] references dir:", exportFolderPath);

      // 取序列帧尺寸
      let width = opts.width ?? 640;
      let height = opts.height ?? 360;
      try {
        const frameSize: any = await (sequence as any).getFrameSize?.();
        if (frameSize) {
          if (typeof frameSize.width === "number") width = Math.round(frameSize.width);
          else if (typeof frameSize.right === "number" && typeof frameSize.left === "number") {
            width = Math.round(frameSize.right - frameSize.left);
          }
          if (typeof frameSize.height === "number") height = Math.round(frameSize.height);
          else if (typeof frameSize.bottom === "number" && typeof frameSize.top === "number") {
            height = Math.round(frameSize.bottom - frameSize.top);
          }
        }
      } catch (e) {
        console.warn("[frames] getFrameSize failed, using default", e);
      }
      console.log("[frames] output size:", width, "x", height);

      const filename = `capture-${Date.now()}.jpg`;
      const separator = exportFolderPath.includes("\\") ? "\\" : "/";
      const outputPath = exportFolderPath + separator + filename;

      // 按 Adobe premiere-api 样本调用 Exporter.exportSequenceFrame
      const Exporter: any = (premierepro as any).Exporter;
      console.log("[frames] calling Exporter.exportSequenceFrame...");
      let ok = false;
      try {
        ok = await Exporter.exportSequenceFrame(
          sequence,
          time,
          filename,
          exportFolderPath,
          width,
          height,
        );
      } catch (e) {
        console.warn("[frames] exportSequenceFrame threw:", e);
      }
      console.log("[frames] exportSequenceFrame returned:", ok);
      if (!ok) {
        return {
          ok: false,
          error:
            "exportSequenceFrame 返回 false。可能原因：playhead 不在视频 clip 内 / 序列无视频 / 文件名含特殊字符。",
        };
      }

      // 用 Folder token 列出条目，找到 capture-* 最新的那个
      // （不依赖 Adobe 25.3 给 .png/.jpg 加后缀的命名 bug）
      let actualFile: any = null;
      let actualName: string | null = null;
      try {
        const entries: any[] = (await exportFolder.getEntries()) || [];
        const captureFiles = entries
          .filter((e: any) => !e.isFolder && /^capture-\d+\./.test(e.name))
          .sort((a: any, b: any) => {
            const ta = Number(a.name.match(/capture-(\d+)/)?.[1] || 0);
            const tb = Number(b.name.match(/capture-(\d+)/)?.[1] || 0);
            return tb - ta;
          });
        if (captureFiles.length > 0) {
          actualFile = captureFiles[0];
          actualName = captureFiles[0].name;
        }
      } catch (e) {
        console.warn("[frames] list entries failed", e);
      }
      if (!actualFile || !actualName) {
        return {
          ok: false,
          error: `exportSequenceFrame 报成功但目录里没有 capture-* 文件。检查目录: ${exportFolderPath}`,
        };
      }
      const actualPath = `${exportFolderPath}/${actualName}`;
      console.log("[frames] actualPath:", actualPath);

      // 读成 data URL 给 Webview 直接显示
      let dataUrl: string | undefined;
      try {
        const ab = await filesCore.readFileBytes(actualFile);
        if (ab) {
          const b64 = await arrayBufferToBase64(ab);
          dataUrl = `data:image/jpeg;base64,${b64}`;
        }
      } catch (e) {
        console.warn("[frames] read frame as data URL failed", e);
      }

      const ref: ReferenceItem & { thumbDataUrl?: string } = {
        type: "reference_image",
        localPath: actualPath,
        fileName: actualName,
        sizeBytes: actualFile.size || 0,
        thumbDataUrl: dataUrl,
        // fileId / uploadedAt 暂不设置，等待后台 upload
      };
      return { ok: true, reference: ref };
    } catch (e: any) {
      console.error("[frames] captureOnly EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

  /**
   * 上传 reference 对应的本地文件到 MiniMax，返回 { fileId, uploadedAt }
   * 由 webview 端在拿到本地 reference 后异步调用，更新 fileId / uploadedAt
   */
  async uploadReferenceFile(args: {
    filePath: string;
    fileName: string;
  }): Promise<{
    ok: boolean;
    fileId?: string;
    uploadedAt?: string;
    error?: string;
  }> {
    try {
      const apiKey = await storage.getApiKey();
      if (!apiKey) return { ok: false, error: "未配置 MiniMax API Key" };

      // 1) 按路径特征自动分派（plugin-data 协议 URL / 项目旁 file://），
      //    覆盖新机制：References/（项目旁或 plugin-data 内）
      let file: any = await filesCore.getEntryAnyPath(args.filePath);
      // 2) 兜底：历史素材在旧"用户自选导出目录"，用持久 token 按文件名找
      if (!file) {
        const sourceTokenKey = "MiniMax.sourceFolderToken";
        const tryTokens = [sourceTokenKey, "MiniMax.exportFolderToken"];
        for (const key of tryTokens) {
          try {
            const token = localStorage.getItem(key);
            if (!token) continue;
            const fs: any = uxp.storage.localFileSystem;
            const folder = await fs.getEntryForPersistentToken(token);
            if (folder && folder.isFolder) {
              const f = await folder.getEntry(args.fileName);
              if (f && !f.isFolder) {
                file = f;
                break;
              }
            }
          } catch (e) {
            // 旧目录里没有新文件是常态，静默跳过
          }
        }
      }
      if (!file) {
        return { ok: false, error: "本地文件不可访问" };
      }

      const r = await uploadCore.uploadFile({
        apiKey,
        fileToken: file,
        fileName: args.fileName,
      });
      if (!r.ok || !r.fileId) return { ok: false, error: r.error };
      return {
        ok: true,
        fileId: r.fileId,
        uploadedAt: new Date().toISOString(),
      };
    } catch (e: any) {
      console.error("[frames] uploadReferenceFile EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

  /**
   * 抓取当前 playhead 帧 + 上传到 MiniMax，返回 ReferenceItem + dataUrl
   */
  async captureAndUploadAsReference(opts: {
    width?: number;
    height?: number;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem & { thumbDataUrl?: string };
    error?: string;
  }> {
    console.log("[frames] captureAndUploadAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const sequence = await project.getActiveSequence();
      if (!sequence) return { ok: false, error: "无活动序列，请先激活一个序列" };

      const time = await sequence.getPlayerPosition();
      console.log("[frames] player position (seconds):", time?.seconds);

      // 参考素材目录（项目旁 References，降级 plugin-data）
      const dirR = await getReferenceDir(project.path);
      if (!dirR.ok || !dirR.folder || !dirR.dirPath) {
        return { ok: false, error: dirR.error || "无法创建参考素材目录" };
      }
      const exportFolder = dirR.folder;
      const exportFolderPath = dirR.dirPath;
      console.log("[frames] references dir:", exportFolderPath);

      // 取序列帧尺寸（直接适配时间线，不缩放）
      let width = opts.width ?? 640;
      let height = opts.height ?? 360;
      try {
        const frameSize: any = await (sequence as any).getFrameSize?.();
        if (frameSize) {
          if (typeof frameSize.width === "number") width = Math.round(frameSize.width);
          else if (typeof frameSize.right === "number" && typeof frameSize.left === "number") {
            width = Math.round(frameSize.right - frameSize.left);
          }
          if (typeof frameSize.height === "number") height = Math.round(frameSize.height);
          else if (typeof frameSize.bottom === "number" && typeof frameSize.top === "number") {
            height = Math.round(frameSize.bottom - frameSize.top);
          }
        }
      } catch (e) {
        console.warn("[frames] getFrameSize failed, using default", e);
      }
      console.log("[frames] output size:", width, "x", height);

      const filename = `capture-${Date.now()}.jpg`;

      // 按 Adobe premiere-api 样本调用 exportSequenceFrame
      const Exporter: any = (premierepro as any).Exporter;
      console.log("[frames] calling Exporter.exportSequenceFrame...");
      const ok = await Exporter.exportSequenceFrame(
        sequence,
        time,
        filename,
        exportFolderPath,
        width,
        height,
      );
      console.log("[frames] exportSequenceFrame returned:", ok);
      if (!ok) {
        return {
          ok: false,
          error:
            "exportSequenceFrame 返回 false。可能原因：playhead 不在视频 clip 内 / 序列无视频 / 文件名含特殊字符。",
        };
      }

      // 用 Folder token 列出条目，找到 capture-* 最新的那个
      // （不依赖 Adobe 25.3 给 .png/.jpg 加后缀的命名 bug）
      let actualFile: any = null;
      let actualName: string | null = null;
      try {
        const entries: any[] = (await exportFolder.getEntries()) || [];
        const captureFiles = entries
          .filter((e) => !e.isFolder && /^capture-\d+\./.test(e.name))
          .sort((a, b) => {
            // 文件名 capture-<timestamp>.<ext>，timestamp 越大越新
            const ta = Number(a.name.match(/capture-(\d+)/)?.[1] || 0);
            const tb = Number(b.name.match(/capture-(\d+)/)?.[1] || 0);
            return tb - ta;
          });
        if (captureFiles.length > 0) {
          actualFile = captureFiles[0];
          actualName = actualFile.name;
        }
      } catch (e: any) {
        console.warn("[frames] list/parse entries failed", e?.message);
      }
      if (!actualFile || !actualName) {
        return {
          ok: false,
          error: `exportSequenceFrame 报成功但目录里没有 capture-* 文件。检查目录: ${exportFolderPath}`,
        };
      }
      const actualPath = `${exportFolderPath}/${actualName}`;
      console.log("[frames] found:", actualName);

      // 读成 data URL 给 Webview 直接显示
      let dataUrl: string | undefined;
      try {
        const ab = await filesCore.readFileBytes(actualFile);
        if (ab) {
          const b64 = await arrayBufferToBase64(ab);
          dataUrl = `data:image/jpeg;base64,${b64}`;
          console.log("[frames] dataUrl length:", dataUrl.length);
        }
      } catch (e) {
        console.warn("[frames] read frame as data URL failed", e);
      }

      // 上传到 MiniMax（API Key 在 UXP 端读取 secureStorage）
      const apiKey = await storage.getApiKey();
      if (!apiKey) {
        return { ok: false, error: "未配置 MiniMax API Key" };
      }
      const up = await uploadCore.uploadFile({
        apiKey,
        fileToken: actualFile, // 直接用 token 传，避免再调 getFileByPath
        fileName: actualName,
      });
      console.log("[frames] upload result:", { ok: up.ok, fileId: up.fileId, error: up.error });
      if (!up.ok || !up.fileId) {
        return { ok: false, error: `上传失败: ${up.error}` };
      }

      const ref: ReferenceItem & { thumbDataUrl?: string } = {
        type: "reference_image",
        localPath: actualPath,
        fileId: up.fileId,
        uploadedAt: new Date().toISOString(),
        fileName: actualName,
        sizeBytes: actualFile.size || 0,
        thumbDataUrl: dataUrl,
      };
      return { ok: true, reference: ref };
    } catch (e: any) {
      console.error("[frames] EXCEPTION:", e);
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 兼容旧接口：仅抓帧，不上传（不推荐，仅供调试）
   */
  async captureActiveFrame(opts: {
    width?: number;
    height?: number;
  } = {}): Promise<{
    ok: boolean;
    imagePath?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
    error?: string;
  }> {
    const r = await this.captureAndUploadAsReference(opts);
    if (!r.ok || !r.reference) {
      return { ok: false, error: r.error };
    }
    return {
      ok: true,
      imagePath: r.reference.localPath,
      dataUrl: r.reference.thumbDataUrl,
    };
  },
};