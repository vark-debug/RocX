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
import {
  safeStr,
  ownerOf,
  getReferenceDir,
  pollForNewestFile,
  encodeDataUrlFromEntry,
  uploadReferenceFile,
} from "./captureBase";
import type { ReferenceItem, CaptureOwner } from "@shared/messages";

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
  const baseName = filename.split(".")[0];
  // 抓视频的 export 完成后通常文件已落盘,timeoutMs=0 表示只查一次不轮询
  // 名字匹配:baseName.* 的所有候选项按"名字长度降序"取最短匹配(完整文件名优于 .tmp/.partial)
  return await pollForNewestFile(folder, {
    predicate: (e: any) => !e.isFolder && e.name.startsWith(baseName),
    sortBy: (a: any, b: any) => a.name.length - b.name.length,
    timeoutMs: 0,
  });
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
    width?: number;
    height?: number;
    owner?: CaptureOwner | null;
    error?: string;
  }> {
    console.log("[captureVideo] captureWorkAreaOnlyAsReference start", opts);
    try {
      const project = await premierepro.Project.getActiveProject();
      if (!project) return { ok: false, error: "无活动项目" };
      const owner = ownerOf(project);
      const sequence = await project.getActiveSequence();
      if (!sequence) return { ok: false, error: "无活动序列" };

      // 取序列帧尺寸（用于按比例自动填写）
      let width: number | undefined;
      let height: number | undefined;
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
        console.warn("[captureVideo] getFrameSize failed", e);
      }
      console.log("[captureVideo] frame size:", width, "x", height);

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
      let ok = false;
      try {
        ok = await encoder.exportSequence(
          sequence,
          (premierepro as any).Constants.ExportType.IMMEDIATELY,
          outputPath,
          presetPath,
          !!opts.exportFull,
        );
      } catch (e: any) {
        // UXP 在 AME 未安装时直接抛 "Internal error : AME is not installed"，
        // 原文对用户不友好，翻译成明确的安装引导
        const msg = safeStr((e as any)?.message || e);
        console.warn("[captureVideo] exportSequence threw:", msg);
        if (/AME is not installed/i.test(msg)) {
          return {
            ok: false,
            error:
              "抓视频失败：Adobe Media Encoder (AME) 未安装。EncoderManager 依赖 AME。请安装 AME 后重试（PR 安装包通常会带，可通过 Creative Cloud 单独安装）。",
            inSec,
            outSec,
            durationSec,
          };
        }
        return {
          ok: false,
          error: `抓视频失败: ${msg}`,
          inSec,
          outSec,
          durationSec,
        };
      }
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
        dataUrl = await encodeDataUrlFromEntry(found.entry, "video/mp4");
        if (!dataUrl) console.warn("[captureVideo] encodeDataUrlFromEntry returned empty");
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
        width,
        height,
        owner,
      };
    } catch (e: any) {
      console.error("[captureVideo] captureOnly EXCEPTION:", e);
      return { ok: false, error: safeStr((e as any)?.message || e) };
    }
  },

/**
   * 上传 reference 对应的本地视频到 MiniMax
   *
   * 实际实现见 captureBase.uploadReferenceFile;
   * 这里 re-export 是为了 captureVideoCore.uploadReferenceFile 公开签名不变。
   * 视频历史素材兜底只检查 exportFolderToken(无 sourceFolderToken)。
   */
  async uploadReferenceFile(args: { filePath: string; fileName: string; providerId?: string }) {
    return uploadReferenceFile({
      filePath: args.filePath,
      fileName: args.fileName,
      providerId: args.providerId,
      fallbackTokenKeys: ["MiniMax.exportFolderToken"],
    });
  },

  /**
   * 抓取当前序列工作区 → 导出视频 → 上传 MiniMax → 返回 ReferenceItem
   *
   * 注意：此方法已废弃，被两阶段流程取代：
   *   captureWorkAreaOnlyAsReference() + uploadReferenceFile()
   * 保留仅为历史兼容。Webview 业务代码已不再调用。
   * （早期实现依赖未定义的 getExportFolder；如需恢复请重新实现。）
   */
  async captureWorkAreaAndUploadAsReference(_opts: {
    exportFull?: boolean;
  } = {}): Promise<{
    ok: boolean;
    reference?: ReferenceItem;
    inSec?: number;
    outSec?: number;
    durationSec?: number;
    error?: string;
  }> {
    return {
      ok: false,
      error:
        "captureWorkAreaAndUploadAsReference 已废弃，请改用 captureWorkAreaOnlyAsReference + uploadReferenceFile 两阶段流程",
    };
  },
};