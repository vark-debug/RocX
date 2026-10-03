/**
 * UXP 端 RunningHub provider：素材二进制上传
 *
 * 上传: POST https://www.runninghub.cn/openapi/v2/media/upload/binary
 *   - Authorization: Bearer <apiKey>
 *   - multipart/form-data，单字段 file（无额外业务字段）
 *   - 成功响应 { code: 0, data: { download_url, fileName, size } }
 *     → fileId 语义为 RH 侧可引用的 download_url（图生图请求直接作为参考图 URL）
 *
 * download: 与 MiniMax 相同的 fetch URL → 写盘策略（URL 由 webview 侧解析）
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

const UPLOAD_URL = "https://www.runninghub.cn/openapi/v2/media/upload/binary";

export class RunningHubUxPProvider implements UxPProvider {
  readonly providerId = "runninghub";

  async uploadFile(req: UxPProviderUploadRequest): Promise<UxPProviderUploadResult> {
    try {
      const ab = await req.fileToken.read({
        format: (uxp.storage as any).formats.binary,
      });
      if (!ab) return { ok: false, error: "读取文件失败" };

      console.log(
        `[runninghub-upload] POST ${UPLOAD_URL} file="${req.fileName}" bytes=${ab.byteLength}`,
      );

      const { body, contentType } = buildMultipart(
        {},
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

      const txt = await safeText(r);
      console.log(
        `[runninghub-upload] HTTP ${r.status} resp=${txt.slice(0, 1000)}`,
      );

      if (!r.ok) {
        return { ok: false, error: `HTTP ${r.status} ${txt.slice(0, 200)}` };
      }
      let json: {
        code?: number;
        message?: string;
        data?: { download_url?: string; fileName?: string; msg?: string };
      };
      try {
        json = JSON.parse(txt);
      } catch {
        return { ok: false, error: `响应非 JSON: ${txt.slice(0, 200)}` };
      }
      if (json.code !== 0) {
        const err = json.message || json.data?.msg || `code=${json.code}`;
        console.warn(`[runninghub-upload] 业务失败: ${err}`);
        return { ok: false, error: err };
      }
      const downloadUrl = json.data?.download_url;
      const fileName = json.data?.fileName;
      if (!downloadUrl || !fileName) {
        console.warn("[runninghub-upload] 响应缺少 data.download_url/fileName");
        return { ok: false, error: "响应缺少 data.download_url/fileName" };
      }
      // fileId 存 fileName（如 "openapi/xxx.png"）而非 download_url：
      // 图生图 imageUrls 用 RH input 纯文件名引用（ComfyUI 原生格式，不受 24h 签名过期限制）；
      // COS 预签名直链会触发「图片链接无效或无法识别」，download_url 仅记录在日志供人工取用
      console.log(
        `[runninghub-upload] ✅ 上传成功 fileName=${fileName} download_url=${downloadUrl}`,
      );
      return { ok: true, fileId: fileName };
    } catch (e: any) {
      console.error("[runninghub-upload] 异常:", e);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async downloadToWorkDir(
    req: UxPProviderDownloadRequest,
  ): Promise<UxPProviderDownloadResult> {
    return downloadUrlToWorkDir(req);
  }
}
