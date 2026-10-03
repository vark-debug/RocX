/**
 * UXP 端 MiniMax provider：上传到 api.minimax.cn/v1/files/upload
 *
 * download 部分是通用 fetch + 落盘（URL 来自 webview 端的 queryTask.content.url，
 * 通过 provider 抽象由 webview 侧负责正确域名）。
 * multipart 拼装 / 下载落盘公共实现在 ../common。
 */
import { uxp } from "../../../../globals";
import {
  buildMultipart,
  downloadUrlToWorkDir,
  guessContentType,
  safeText,
} from "../common";
import type {
  UxPProvider,
  UxPProviderUploadRequest,
  UxPProviderUploadResult,
  UxPProviderDownloadRequest,
  UxPProviderDownloadResult,
} from "../types";

const UPLOAD_URL = "https://api.minimax.cn/v1/files/upload";
const UPLOAD_PURPOSE = "video_generation_input";

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
    return downloadUrlToWorkDir(req);
  }
}
