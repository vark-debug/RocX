/**
 * UXP 端 Ark（火山方舟）provider：上传 no-op
 *
 * Ark 图片生成不走素材上传：参考图以 base64 data URI 直传 image 数组
 * （由 webview 侧提交链路读取本地文件内联），故 uploadFile 不发任何网络请求，
 * 仅返回标记性 fileId（inline:<fileName>）保持 ReferenceItem.uploadProvider 语义一致。
 *
 * download: 与其他 provider 相同的 fetch URL → 写盘策略（URL 由 webview 侧解析）
 */
import { downloadUrlToWorkDir } from "../common";
import type {
  UxPProvider,
  UxPProviderUploadRequest,
  UxPProviderUploadResult,
  UxPProviderDownloadRequest,
  UxPProviderDownloadResult,
} from "../types";

export class ArkUxPProvider implements UxPProvider {
  readonly providerId = "ark";

  async uploadFile(
    req: UxPProviderUploadRequest,
  ): Promise<UxPProviderUploadResult> {
    // no-op：Ark 提交时直接内联 base64，无需上传
    console.log(
      `[ark-upload] no-op（base64 直传，不上传） file="${req.fileName}"`,
    );
    return { ok: true, fileId: `inline:${req.fileName}` };
  }

  async downloadToWorkDir(
    req: UxPProviderDownloadRequest,
  ): Promise<UxPProviderDownloadResult> {
    return downloadUrlToWorkDir(req);
  }
}
