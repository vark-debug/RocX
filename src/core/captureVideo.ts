/**
 * 抓取当前序列工作区（in/out）→ 导出为视频 → 上传到 MiniMax → 返回 ReferenceItem
 *
 * 流程参考 vark-debug/jianming-adobePremierePro-Smart-Export：
 *   encoder.exportSequence(sequence, IMMEDIATELY, outputPath, presetFile, exportFull)
 *   - exportFull=false (默认) → 按序列 in/out 工作区导出
 *   - exportFull=true → 导出整个序列
 *
 * 预设文件：从 public/epr/ 打包进 ccx，用 plugin:/epr/h264匹配帧10mbps.epr 读取
 */
import { premierepro, uxp } from "../globals";
import { filesCore } from "./files";
import { uploadCore } from "./ai/upload";
import { storage } from "./storage";
import type { ReferenceItem } from "./messages";

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

function safeStr(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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

/**
 * 拿到打包在 ccx 里的 .epr 预设（plugin-data 读不出 binary 文件，
 * 但 plugin:/ 协议可以读取 ccx 内置的资源文件）。
 */
async function getPresetFile(): Promise<any | null> {
  const fs: any = uxp.storage.localFileSystem;
  for (const url of [
    "plugin:/epr/h264匹配帧10mbps.epr",
    "plugin:/epr/ProRes 422.epr",
  ]) {
    try {
      const f = await fs.getEntryWithUrl(url);
      if (f && (f.isFile || f.name)) return f;
    } catch (e) {
      console.warn(`[captureVideo] preset ${url} not accessible:`, safeStr((e as any)?.message || e));
    }
  }
  return null;
}

async function findExportByName(
  folder: any,
  filename: string,
): Promise<{ entry: any; name: string } | null> {
  try {
    const entries = await folder.getEntries();
    const baseName = filename.split(".")[0];
    const candidates = entries
      .filter((e: any) => !e.isFolder && e.name.startsWith(baseName))
      .sort((a: any, b: any) => b.name.length - a.name.length);
    if (candidates.length > 0) {
      return { entry: candidates[0], name: candidates[0].name };
    }
  } catch (e) {
    console.warn("[captureVideo] list entries failed", e);
  }
  return null;
}

export const captureVideoCore = {
  /**
   * 只导出 + 读取缩略图，**不上传**
   * 返回 reference（fileId/uploadedAt 未设置），用于"立即显示 + 后台上传"
   */
  async captureWorkAreaOnlyAsReference(opts: {
    exportFull?: boolean;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    inSec?: number;
    outSec?: number;
    durationSec?: number;
    error?: string;
  }> {
    console.log("[captureVideo] captureWorkAreaOnlyAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const sequence = await project.getActiveSequence();
      if (!sequence) return { ok: false, error: "无活动序列" };

      let inSec = 0;
      let outSec = 0;
      try {
        const inPt = await sequence.getInPoint();
        const outPt = await sequence.getOutPoint();
        inSec = inPt?.seconds ?? 0;
        outSec = outPt?.seconds ?? 0;
      } catch (e) {
        console.warn("[captureVideo] getIn/OutPoint failed", e);
      }
      const durationSec = Math.max(0, outSec - inSec);
      if (durationSec <= 0) {
        return {
          ok: false,
          error:
            "工作区 in/out 无效。请在 PR 中用 I / O 键设置工作区。",
          inSec,
          outSec,
          durationSec,
        };
      }

      // 参考素材目录（项目旁 References，降级 plugin-data）
      const dirR = await getReferenceDir(project.path);
      if (!dirR.ok || !dirR.folder || !dirR.dirPath) {
        return { ok: false, error: dirR.error || "无法创建参考素材目录" };
      }
      const exportFolder = dirR.folder;
      const exportFolderPath = dirR.dirPath;
      console.log("[captureVideo] references dir:", exportFolderPath);

      const filename = `clip-${Date.now()}.mp4`;
      const separator = exportFolderPath.includes("\\") ? "\\" : "/";
      const outputPath = exportFolderPath + separator + filename;

      const encoder: any = await (premierepro as any).EncoderManager.getManager();
      const presetFile = await getPresetFile();
      const presetPath = presetFile?.nativePath;

      console.log("[captureVideo] calling encoder.exportSequence...");
      const ok = await encoder.exportSequence(
        sequence,
        (premierepro as any).Constants.ExportType.IMMEDIATELY,
        outputPath,
        presetPath,
        !!opts.exportFull,
      );
      console.log("[captureVideo] exportSequence returned:", ok);
      if (!ok) {
        return {
          ok: false,
          error: presetPath
            ? "导出失败（encoder.exportSequence 返回 false）"
            : "导出失败（encoder.exportSequence 返回 false）。",
          inSec,
          outSec,
          durationSec,
        };
      }

      const found = await findExportByName(exportFolder, filename);
      if (!found) {
        return {
          ok: false,
          error: `导出报成功但目录里没找到 ${filename}。检查目录: ${exportFolderPath}`,
          inSec,
          outSec,
          durationSec,
        };
      }
      const actualPath = exportFolderPath + separator + found.name;
      console.log("[captureVideo] actual file:", actualPath);

      // 读成 data URL
      let dataUrl: string | undefined;
      try {
        const ab = await found.entry.read({ format: (uxp.storage as any).formats.binary });
        if (ab) {
          const b64 = await arrayBufferToBase64(ab);
          dataUrl = `data:video/mp4;base64,${b64}`;
        }
      } catch (e) {
        console.warn("[captureVideo] read for dataUrl failed", e);
      }

      const ref: ReferenceItem & { thumbDataUrl?: string } = {
        type: "reference_video",
        localPath: actualPath,
        fileName: found.name,
        sizeBytes: found.entry.size || 0,
        durationSec,
        thumbDataUrl: dataUrl,
      };
      return {
        ok: true,
        reference: ref,
        inSec,
        outSec,
        durationSec,
      };
    } catch (e: any) {
      console.error("[captureVideo] captureOnly EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

  /**
   * 上传 reference 对应的本地视频到 MiniMax
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

      // 1) 按路径特征自动分派（plugin-data 协议 URL / 项目旁 file://）
      let file: any = await filesCore.getEntryAnyPath(args.filePath);
      // 2) 兜底：历史素材在旧"用户自选导出目录"，用持久 token 按文件名找
      if (!file) {
        try {
          const token = localStorage.getItem("MiniMax.exportFolderToken");
          if (token) {
            const fs: any = uxp.storage.localFileSystem;
            const folder = await fs.getEntryForPersistentToken(token);
            if (folder && folder.isFolder) {
              const f = await folder.getEntry(args.fileName);
              if (f && !f.isFolder) file = f;
            }
          }
        } catch (e) {
          // 旧目录里没有新文件是常态，静默跳过
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
      console.error("[captureVideo] uploadReferenceFile EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

  /**
   * 抓取当前序列工作区 → 导出视频 → 上传 MiniMax → 返回 ReferenceItem
   */
  async captureWorkAreaAndUploadAsReference(opts: {
    exportFull?: boolean;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    inSec?: number;
    outSec?: number;
    durationSec?: number;
    error?: string;
  }> {
    console.log("[captureVideo] start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const sequence = await project.getActiveSequence();
      if (!sequence) return { ok: false, error: "无活动序列" };

      // in/out 时间
      let inSec = 0;
      let outSec = 0;
      try {
        const inPt = await sequence.getInPoint();
        const outPt = await sequence.getOutPoint();
        inSec = inPt?.seconds ?? 0;
        outSec = outPt?.seconds ?? 0;
        console.log(`[captureVideo] in/out: ${inSec.toFixed(2)}s - ${outSec.toFixed(2)}s`);
      } catch (e) {
        console.warn("[captureVideo] getIn/OutPoint failed", e);
      }
      const durationSec = Math.max(0, outSec - inSec);
      if (durationSec <= 0) {
        return {
          ok: false,
          error:
            "工作区 in/out 无效。请在 PR 中用 I / O 键设置工作区（默认导出整个序列时通常无问题）。",
          inSec,
          outSec,
          durationSec,
        };
      }

      const exportFolder = await getExportFolder();
      if (!exportFolder) return { ok: false, error: "未选择导出目录" };
      const exportFolderPath = exportFolder.nativePath;

      const filename = `clip-${Date.now()}.mp4`;
      const separator = exportFolderPath.includes("\\") ? "\\" : "/";
      const outputPath = exportFolderPath + separator + filename;

      const encoder: any = await (premierepro as any).EncoderManager.getManager();
      const presetFile = await getPresetFile();
      const presetPath = presetFile?.nativePath;

      console.log("[captureVideo] calling encoder.exportSequence...");
      console.log("  output:", outputPath);
      console.log("  preset:", presetPath || "(none)");
      console.log("  exportFull:", !!opts.exportFull);

      const ok = await encoder.exportSequence(
        sequence,
        (premierepro as any).Constants.ExportType.IMMEDIATELY,
        outputPath,
        presetPath,
        !!opts.exportFull,
      );
      console.log("[captureVideo] exportSequence returned:", ok);
      if (!ok) {
        return {
          ok: false,
          error: presetPath
            ? "导出失败（encoder.exportSequence 返回 false），请检查 preset 是否适配当前序列"
            : "导出失败（encoder.exportSequence 返回 false）。",
          inSec,
          outSec,
          durationSec,
        };
      }

      // 找实际写出的文件
      const found = await findExportByName(exportFolder, filename);
      if (!found) {
        return {
          ok: false,
          error: `导出报成功但目录里没找到 ${filename}。检查目录: ${exportFolderPath}`,
          inSec,
          outSec,
          durationSec,
        };
      }
      const actualPath = exportFolderPath + separator + found.name;
      console.log("[captureVideo] actual file:", actualPath);

      // 读成 data URL
      let dataUrl: string | undefined;
      try {
        const ab = await found.entry.read({ format: (uxp.storage as any).formats.binary });
        if (ab) {
          const b64 = await arrayBufferToBase64(ab);
          dataUrl = `data:video/mp4;base64,${b64}`;
        }
      } catch (e) {
        console.warn("[captureVideo] read for dataUrl failed", e);
      }

      // 上传到 MiniMax
      const apiKey = await storage.getApiKey();
      if (!apiKey) {
        return { ok: false, error: "未配置 MiniMax API Key" };
      }
      const up = await uploadCore.uploadFile({
        apiKey,
        fileToken: found.entry,
        fileName: found.name,
      });
      if (!up.ok || !up.fileId) {
        return { ok: false, error: `上传失败: ${up.error}`, inSec, outSec, durationSec };
      }

      const ref: ReferenceItem = {
        type: "reference_video",
        localPath: actualPath,
        fileId: up.fileId,
        uploadedAt: new Date().toISOString(),
        fileName: found.name,
        sizeBytes: found.entry.size || 0,
        durationSec,
        thumbDataUrl: dataUrl,
      };
      return {
        ok: true,
        reference: ref,
        inSec,
        outSec,
        durationSec,
      };
    } catch (e: any) {
      console.error("[captureVideo] EXCEPTION:", e);
      return { ok: false, error: safeStr(e?.message || e) };
    }
  },
};