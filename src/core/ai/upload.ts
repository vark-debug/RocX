/**
 * MiniMax 文件上传（multipart/form-data）
 *
 * 实际实现已迁至 `providers/minimax/MiniMaxUxPProvider`，本文件保留
 * `uploadCore.uploadFile` shim 以兼容现有调用方。
 */
import { getUxPProvider } from "./providers/registry";

export const uploadCore = {
  /** 把 File token 上传到当前 provider（默认 minimax） */
  async uploadFile(args: {
    apiKey: string;
    fileToken: any;
    fileName: string;
    contentType?: string;
  }): Promise<{ ok: boolean; fileId?: string; error?: string }> {
    const provider = getUxPProvider(); // 默认 minimax；后续 api.ts 可传入 providerId
    return await provider.uploadFile({
      apiKey: args.apiKey,
      fileToken: args.fileToken,
      fileName: args.fileName,
      contentType: args.contentType,
    });
  },
};
