/**
 * MiniMax 文件上传（multipart/form-data）
 * UXP fetch + 手动拼接 multipart 报文，避免依赖 FormData/Blob 兼容性
 */
import { filesCore } from "../files";

const UPLOAD_URL = "https://api.minimax.cn/v1/files/upload";
const UPLOAD_PURPOSE = "video_generation_input";

function bytesToLatin1(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** 手动拼接 multipart/form-data 报文，避开 UXP 平台 FormData 兼容性问题 */
function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; fileName: string; data: ArrayBuffer; contentType?: string },
): { body: ArrayBuffer; contentType: string } {
  const boundary = "----MiniMaxFormBoundary" + Math.random().toString(36).slice(2);
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

export const uploadCore = {
  /** 把 File token 上传到 MiniMax */
  async uploadFile(args: {
    apiKey: string;
    fileToken: any;
    fileName: string;
    contentType?: string;
  }): Promise<{ ok: boolean; fileId?: string; error?: string }> {
    try {
      const ab = await filesCore.readFileBytes(args.fileToken);
      if (!ab) return { ok: false, error: "读取文件失败" };

      const { body, contentType } = buildMultipart(
        { purpose: UPLOAD_PURPOSE },
        {
          fieldName: "file",
          fileName: args.fileName,
          data: ab,
          contentType: args.contentType || guessContentType(args.fileName),
        },
      );

      const r = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          "Content-Type": contentType,
        },
        body,
      });

      if (!r.ok) {
        const txt = await safeText(r);
        return { ok: false, error: `HTTP ${r.status} ${txt.slice(0, 200)}` };
      }
      const json = (await r.json()) as {
        file?: { file_id?: string };
        base_resp?: { status_code?: number; status_msg?: string };
      };
      const statusCode = json?.base_resp?.status_code ?? 0;
      if (statusCode !== 0) {
        return {
          ok: false,
          error: json?.base_resp?.status_msg || `base_resp.status_code=${statusCode}`,
        };
      }
      const fileId = json?.file?.file_id;
      if (!fileId) return { ok: false, error: "响应缺少 file_id" };
      return { ok: true, fileId };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};

function guessContentType(fileName: string): string {
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

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}