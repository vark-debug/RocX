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
import {
  safeStr,
  ownerOf,
  getReferenceDir,
  pollForNewestFile,
  encodeDataUrlFromEntry,
  uploadReferenceFile,
} from "./captureBase";
import type { ReferenceItem, CaptureOwner } from "@shared/messages";

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
    owner?: CaptureOwner | null;
    error?: string;
  }> {
    console.log("[frames] captureOnlyAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const owner = ownerOf(project);
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

      // 先快照目录里已存在的 capture-* 文件名。
      // exportSequenceFrame 返回 true 只代表导出命令已下发,写盘是异步的;
      // 若不在此之前快照,第 2 次抓帧时轮询会立刻命中上一次的残留文件,
      // 导致把旧帧交给 Photoshop。
      const preExistingNames = new Set<string>();
      try {
        const preEntries: any[] = (await exportFolder.getEntries()) || [];
        for (const e of preEntries) {
          if (!e.isFolder && /^capture-\d+\./.test(e.name)) preExistingNames.add(e.name);
        }
      } catch (e) {
        console.warn("[frames] pre-export snapshot failed", e);
      }

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

      // 轮询等待**本次新增**的 capture-* 文件落盘
      // (不依赖 Adobe 25.3 给 .png/.jpg 加后缀的命名 bug)
      // Windows 上写盘有延迟,最多等 ~1.5s;macOS 几乎立即命中
      const captureRegex = /^capture-\d+\./;
      const found = await pollForNewestFile(exportFolder, {
        predicate: (e: any) => captureRegex.test(e.name),
        sortBy: (a: any, b: any) => {
          const ta = Number(a.name.match(/capture-(\d+)/)?.[1] || 0);
          const tb = Number(b.name.match(/capture-(\d+)/)?.[1] || 0);
          return tb - ta;
        },
        excludeNames: preExistingNames,
        timeoutMs: 1500,
        intervalMs: 100,
      });
      if (!found) {
        return {
          ok: false,
          error: `exportSequenceFrame 报成功但 1.5s 内目录里没有新增 capture-* 文件。检查目录: ${exportFolderPath}`,
        };
      }
      const { entry: actualFile, name: actualName } = found;
      const actualPath = `${exportFolderPath}/${actualName}`;
      console.log("[frames] actualPath:", actualPath);

      // 读成 data URL 给 Webview 直接显示
      let dataUrl: string | undefined;
      try {
        dataUrl = await encodeDataUrlFromEntry(actualFile, "image/jpeg");
        if (!dataUrl) console.warn("[frames] encodeDataUrlFromEntry returned empty");
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
      return { ok: true, reference: ref, owner };
    } catch (e: any) {
      console.error("[frames] captureOnly EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

  /**
   * 上传 reference 对应的本地文件到 MiniMax，返回 { fileId, uploadedAt }
   * 由 webview 端在拿到本地 reference 后异步调用，更新 fileId / uploadedAt
   *
   * 实际实现见 captureBase.uploadReferenceFile;
   * 这里 re-export 是为了 framesCore.uploadReferenceFile 公开签名不变。
   */
  async uploadReferenceFile(args: { filePath: string; fileName: string; providerId?: string }) {
    return uploadReferenceFile({
      filePath: args.filePath,
      fileName: args.fileName,
      providerId: args.providerId,
      // frames 的历史素材兜底:同时检查 sourceFolderToken + exportFolderToken
      fallbackTokenKeys: ["MiniMax.sourceFolderToken", "MiniMax.exportFolderToken"],
    });
  },

  /**
   * 抓取当前 playhead 帧 + 上传到 MiniMax，返回 ReferenceItem + dataUrl
   */
  async captureAndUploadAsReference(opts: {
    width?: number;
    height?: number;
    /** 目标 provider id；缺省回落默认 provider */
    providerId?: string;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem & { thumbDataUrl?: string };
    owner?: CaptureOwner | null;
    error?: string;
  }> {
    console.log("[frames] captureAndUploadAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const owner = ownerOf(project);
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

      // 用 Folder token 列出条目,找到 capture-* 最新的那个
      // (不依赖 Adobe 25.3 给 .png/.jpg 加后缀的命名 bug)
      // Windows 上 exportSequenceFrame 返回 true 后文件未必立即可见(写盘延迟),
      // 短轮询兜底,最多 ~1.5s(macOS 同步写盘,几乎立即命中)
      const captureRegex = /^capture-\d+\./;
      const found = await pollForNewestFile(exportFolder, {
        predicate: (e: any) => captureRegex.test(e.name),
        sortBy: (a: any, b: any) => {
          // 文件名 capture-<timestamp>.<ext>,timestamp 越大越新
          const ta = Number(a.name.match(/capture-(\d+)/)?.[1] || 0);
          const tb = Number(b.name.match(/capture-(\d+)/)?.[1] || 0);
          return tb - ta;
        },
        timeoutMs: 1500,
        intervalMs: 100,
      });
      if (!found) {
        return {
          ok: false,
          error: `exportSequenceFrame 报成功但目录里没有 capture-* 文件。检查目录: ${exportFolderPath}`,
        };
      }
      const { entry: actualFile, name: actualName } = found;
      const actualPath = `${exportFolderPath}/${actualName}`;
      console.log("[frames] found:", actualName);

      // 读成 data URL 给 Webview 直接显示
      let dataUrl: string | undefined;
      try {
        dataUrl = await encodeDataUrlFromEntry(actualFile, "image/jpeg");
        if (dataUrl) console.log("[frames] dataUrl length:", dataUrl.length);
      } catch (e) {
        console.warn("[frames] read frame as data URL failed", e);
      }

      // 上传到目标 provider（API Key 在 UXP 端读取 secureStorage）
      const apiKey = await storage.getApiKey(opts.providerId);
      if (!apiKey) {
        return { ok: false, error: "未配置 API Key" };
      }
      const up = await uploadCore.uploadFile({
        apiKey,
        fileToken: actualFile, // 直接用 token 传，避免再调 getFileByPath
        fileName: actualName,
        providerId: opts.providerId,
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
      return { ok: true, reference: ref, owner };
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