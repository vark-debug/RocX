/**
 * 抓帧 / 抓视频共享工具
 *
 * - ownerOf: 抓取瞬间从活动工程对象读出归属快照(防止后续切换工程导致读 A 写 B)
 * - arrayBufferToBase64: ArrayBuffer → base64 字符串,拼 data URL 用
 * - safeStr: 把任意值转成可读的字符串(避免直接 String(throw) 或 null 报错)
 * - getReferenceDir: 转调 workDirCore.ensureReferencesDir(项目旁 References 优先)
 * - pollForNewestFile: 通用落盘轮询(frames 抓帧 / captureVideo 抓视频)
 * - encodeDataUrlFromEntry: 把 UXP file entry 读成 base64 data URL
 * - uploadReferenceFile: 把本地参考文件上传到 provider
 *
 * frames.ts 与 captureVideo.ts 共用本模块。
 */
import { uxp } from "../globals";
import { filesCore } from "./files";
import { storage } from "./storage";
import { uploadCore } from "./ai/upload";
import type { CaptureOwner } from "@shared/messages";

/** 把任意值转成可读的字符串;用于错误日志拼接,避免 null/undefined 触发异常 */
export function safeStr(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 从抓取时拿到的活动工程对象读出归属快照。
 * 必须在抓取那一刻调用 —— 事后由 webview 端再查一次活动工程就是一次独立推断,
 * 会重新引入「读 A 写 B」的错位。
 */
export function ownerOf(project: any): CaptureOwner | null {
  if (!project?.path) return null;
  return {
    projectGuid: String(project.guid ?? ""),
    projectPath: project.path,
    projectName: project.name ?? undefined,
  };
}

/** ArrayBuffer → base64 字符串(拼 data URL 用) */
export async function arrayBufferToBase64(ab: ArrayBuffer): Promise<string> {
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
 * 把 UXP file entry 读成 base64 data URL,给 webview 直接 <video>/<img> 显示。
 *
 * @param entry UXP file entry
 * @param mime 如 "image/jpeg"、"video/mp4";由调用方根据业务场景决定
 * @returns data URL 字符串;读不到 bytes 返回 undefined
 */
export async function encodeDataUrlFromEntry(
  entry: any,
  mime: string,
): Promise<string | undefined> {
  if (!entry) return undefined;
  try {
    const { readFileBytes } = await import("./fileIO");
    const ab = await readFileBytes(entry);
    if (!ab) return undefined;
    const b64 = await arrayBufferToBase64(ab);
    return `data:${mime};base64,${b64}`;
  } catch (e) {
    console.warn("[captureBase] encodeDataUrlFromEntry failed", e);
    return undefined;
  }
}

/**
 * 参考素材目录:PR 项目旁 AI_Generated_Media/References/(与生成记录同位置、独立文件夹)。
 * 项目未保存或创建失败时降级 plugin-data:/AI-Generated-Media/References/。
 * (旧的"用户自选导出目录 + 持久 token"机制已废弃,token 逻辑仅保留在
 * uploadReferenceFile 里用于兼容历史素材。)
 */
export async function getReferenceDir(projectPath?: string): Promise<{
  ok: boolean;
  folder?: any;
  dirPath?: string;
  error?: string;
}> {
  return await filesCore.ensureReferencesDir(projectPath);
}

/**
 * 通用落盘轮询:在 folder 中按 predicate 过滤、按 sortBy 排序取第一个匹配项。
 *
 * 用于 exportSequenceFrame / encoder.exportSequence 后,等待文件真实落盘:
 * - frames: 抓帧按 capture-<timestamp>.jpg 模式 + 时间戳降序
 * - captureVideo: 抓视频按 baseName.* 模式 + 名字长度降序(短名 = 完整名)
 *
 * 行为:
 * - 默认 timeoutMs=1500 / intervalMs=100
 * - timeoutMs=0 时只查一次不轮询(captureVideo 的 findExportByName 等场景)
 * - excludeNames: 调用方传入"已有文件名集合",用于过滤本次新增的文件
 *   (frames captureOnly 路径下:避免把上一次抓的帧误认作本次结果)
 *
 * @returns 第一个匹配的 { entry, name } 或 null(超时/未找到)
 */
export async function pollForNewestFile(
  folder: any,
  opts: {
    predicate?: (entry: any) => boolean;
    sortBy?: (a: any, b: any) => number;
    timeoutMs?: number;
    intervalMs?: number;
    excludeNames?: Set<string>;
  } = {},
): Promise<{ entry: any; name: string } | null> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const intervalMs = opts.intervalMs ?? 100;
  const predicate = opts.predicate ?? (() => true);
  const sortBy = opts.sortBy ?? (() => 0);
  const excludeNames = opts.excludeNames;
  const startTs = Date.now();

  while (true) {
    try {
      const entries: any[] = (await folder.getEntries()) || [];
      const filtered = entries
        .filter((e: any) => !e.isFolder && predicate(e))
        .filter((e: any) => !excludeNames?.has(e.name))
        .sort(sortBy);
      if (filtered.length > 0) {
        return { entry: filtered[0], name: filtered[0].name };
      }
    } catch (e) {
      console.warn("[captureBase] poll list failed", e);
    }
    const elapsed = Date.now() - startTs;
    if (elapsed >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * 把本地参考文件上传到当前 provider(默认 minimax)。
 *
 * 1) 按路径特征自动分派(plugin-data 协议 URL / 项目旁 file://),
 *    覆盖新机制:References/(项目旁或 plugin-data 内)
 * 2) 兜底:历史素材在旧"用户自选导出目录",用持久 token 按文件名找
 *    (frames 用 [sourceFolderToken, exportFolderToken];captureVideo 用 [exportFolderToken])
 *
 * 成功时返回 { ok: true, fileId, uploadedAt }。
 */
export async function uploadReferenceFile(args: {
  filePath: string;
  fileName: string;
  /** 目标 provider id；缺省回落默认 provider */
  providerId?: string;
  /** 兜底 token key 列表;默认 ["MiniMax.exportFolderToken"] */
  fallbackTokenKeys?: string[];
}): Promise<{
  ok: boolean;
  fileId?: string;
  uploadedAt?: string;
  error?: string;
}> {
  try {
    const apiKey = await storage.getApiKey(args.providerId);
    if (!apiKey) return { ok: false, error: "未配置 API Key" };

    let file: any = await filesCore.getEntryAnyPath(args.filePath);
    if (!file) {
      const keys = args.fallbackTokenKeys ?? ["MiniMax.exportFolderToken"];
      for (const key of keys) {
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
          // 旧目录里没有新文件是常态,静默跳过
        }
      }
    }
    if (!file) return { ok: false, error: "本地文件不可访问" };

    const r = await uploadCore.uploadFile({
      apiKey,
      fileToken: file,
      fileName: args.fileName,
      providerId: args.providerId,
    });
    if (!r.ok || !r.fileId) return { ok: false, error: r.error };
    return {
      ok: true,
      fileId: r.fileId,
      uploadedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return { ok: false, error: safeStr((e as any)?.message || e) };
  }
}