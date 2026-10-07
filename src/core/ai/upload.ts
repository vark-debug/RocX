/**
 * MiniMax 文件上传（multipart/form-data）
 *
 * 实际实现已迁至 `providers/minimax/MiniMaxUxPProvider`，本文件保留
 * `uploadCore.uploadFile` shim 以兼容现有调用方。
 */
import { getUxPProvider } from "./providers/registry";

export const uploadCore = {
  /** 把 File token 上传到指定 provider 的文件接口（缺省回落默认 provider） */
  async uploadFile(args: {
    apiKey: string;
    fileToken: any;
    fileName: string;
    contentType?: string;
    /** 目标 provider id；缺省回落 DEFAULT_UXP_PROVIDER_ID（当前为 minimax） */
    providerId?: string;
  }): Promise<{ ok: boolean; fileId?: string; error?: string }> {
    const provider = getUxPProvider(args.providerId);
    return await provider.uploadFile({
      apiKey: args.apiKey,
      fileToken: args.fileToken,
      fileName: args.fileName,
      contentType: args.contentType,
    });
  },
};
