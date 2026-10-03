/**
 * UXP provider 公共工具：multipart 拼装 / 文件名→MIME / 下载落盘
 *
 * 从 MiniMaxUxPProvider 抽出，供各 provider 共享：
 * - buildMultipart: 手工拼 multipart/form-data（UXP 环境无标准 FormData 二进制支持）
 * - guessContentType: 按扩展名猜 MIME
 * - downloadUrlToWorkDir: fetch URL → 写入 plugin-data 工作目录（防重名递增）
 */
import { uxp } from "../../../globals";
import { filesCore, WORK_DIR_NAME } from "../../files";
import type {
  UxPProviderDownloadRequest,
  UxPProviderDownloadResult,
} from "./types";

export function bytesToLatin1(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

export function guessContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  return (
    {
      mp4: "video/mp4",
      mov: "video/quicktime",
      wav: "audio/wav",
      mp3: "audio/mpeg",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    }[ext] || "application/octet-stream"
  );
}

export function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; fileName: string; data: ArrayBuffer; contentType?: string },
): { body: ArrayBuffer; contentType: string } {
  const boundary = "----RocXFormBoundary" + Math.random().toString(36).slice(2);
  const parts: Uint8Array[] = [];
  const crlf = "\r\n";

  for (const [k, v] of Object.entries(fields)) {
    let chunk = `--${boundary}${crlf}`;
    chunk += `Content-Disposition: form-data; name="${k}"${crlf}${crlf}`;
    chunk += `${v}${crlf}`;
    parts.push(bytesToLatin1(chunk));
  }

  let fileHeader = `--${boundary}${crlf}`;
  fileHeader += `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"${crlf}`;
  fileHeader += `Content-Type: ${file.contentType || "application/octet-stream"}${crlf}${crlf}`;
  parts.push(bytesToLatin1(fileHeader));
  parts.push(new Uint8Array(file.data));
  parts.push(bytesToLatin1(crlf));

  const closing = `--${boundary}--${crlf}`;
  parts.push(bytesToLatin1(closing));

  let total = 0;
  for (const p of parts) total += p.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.byteLength;
  }

  return {
    body: merged.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * 通用下载落盘：fetch URL → 写入 plugin-data:/WORK_DIR_NAME（防重名自动递增）。
 * 各 provider 的 downloadToWorkDir 只是 endpoint 不同（URL 由 webview 侧解析），落盘策略一致。
 */
export async function downloadUrlToWorkDir(
  req: UxPProviderDownloadRequest,
): Promise<UxPProviderDownloadResult> {
  try {
    const fs: any = (uxp as any).storage.localFileSystem;
    const baseUrl = `plugin-data:/${WORK_DIR_NAME}`;

    const dir = await filesCore.ensureWorkDir();
    if (!dir) return { ok: false, error: "无法获取生成工作目录（plugin-data 不可访问？）" };
    if (!dir.isFolder) {
      return { ok: false, error: "工作目录被同名文件占用（AI-Generated-Media 不是文件夹），请检查后重试" };
    }

    const exists = async (name: string): Promise<boolean> => {
      try {
        const e = await fs.getEntryWithUrl(`${baseUrl}/${name}`);
        return !!e;
      } catch {
        return false;
      }
    };
    let name = req.suggestedName;
    let counter = 1;
    while (await exists(name)) {
      const dot = req.suggestedName.lastIndexOf(".");
      name =
        dot > 0
          ? `${req.suggestedName.slice(0, dot)}_${counter}${req.suggestedName.slice(dot)}`
          : `${req.suggestedName}_${counter}`;
      counter++;
    }

    const r = await fetch(req.url, { method: "GET" });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const ab = await r.arrayBuffer();
    if (!ab || ab.byteLength === 0) {
      return { ok: false, error: "下载内容为空" };
    }

    const entry = await fs.createEntryWithUrl(`${baseUrl}/${name}`, {
      type: (uxp.storage as any).types.file,
      overwrite: false,
    });
    await entry.write(ab, {
      format: (uxp.storage as any).formats.binary,
    });

    const localPath = entry.nativePath || (await fs.getNativePath(entry));
    return { ok: true, localPath };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
