/**
 * UXP 端 provider 抽象
 *
 * 每个 provider 自包含：
 * - 上传 URL / multipart 拼装 / 鉴权头
 * - 下载落盘策略（其实下载都 fetch URL，所以只是 endpoint routing）
 */
import type { FileKind } from "@shared/messages";

export interface UxPProviderUploadRequest {
  apiKey: string;
  fileToken: any;        // UXP file entry token
  fileName: string;
  contentType?: string;
}

export interface UxPProviderUploadResult {
  ok: boolean;
  fileId?: string;
  error?: string;
}

export interface UxPProviderDownloadRequest {
  url: string;
  suggestedName: string;
}

export interface UxPProviderDownloadResult {
  ok: boolean;
  localPath?: string;
  error?: string;
}

export interface UxPProvider {
  readonly providerId: string;
  uploadFile(req: UxPProviderUploadRequest): Promise<UxPProviderUploadResult>;
  downloadToWorkDir(req: UxPProviderDownloadRequest): Promise<UxPProviderDownloadResult>;
}

/** 默认 provider id */
export const DEFAULT_UXP_PROVIDER_ID = "minimax";
