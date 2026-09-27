/**
 * UXP 端 MiniMax provider：上传到 api.minimax.cn/v1/files/upload
 *
 * download 部分是通用 fetch + 落盘（URL 来自 webview 端的 queryTask.content.url，
 * 通过 provider 抽象由 webview 侧负责正确域名）。
 */
import { uxp } from "../../../../globals";
import { filesCore, WORK_DIR_NAME } from "../../../files";
import type {
  UxPProvider,
  UxPProviderUploadRequest,
  UxPProviderUploadResult,
  UxPProviderDownloadRequest,
  UxPProviderDownloadResult,
} from "../types";

const UPLOAD_URL = "https://api.minimax.cn/v1/files/upload";
const UPLOAD_PURPOSE = "video_generation_input";

function bytesToLatin1(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

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

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

export class MiniMaxUxPProvider implements UxPProvider {
  readonly providerId = "minimax";

  async uploadFile(req: UxPProviderUploadRequest): Promise<UxPProviderUploadResult> {
    try {
      // 读 file token
      const ab = await req.fileToken.read({
        format: (uxp.storage as any).formats.binary,
      });
      if (!ab) return { ok: false, error: "读取文件失败" };

      const { body, contentType } = buildMultipart(
        { purpose: UPLOAD_PURPOSE },
        {
          fieldName: "file",
          fileName: req.fileName,
          data: ab as ArrayBuffer,
          contentType: req.contentType || guessContentType(req.fileName),
        },
      );

      const r = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
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
  }

  async downloadToWorkDir(
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
}
