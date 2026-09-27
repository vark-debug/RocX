/**
 * MiniMax CDN 结果视频下载 → 生成工作目录
 *
 * 实际实现已迁至 `providers/minimax/MiniMaxUxPProvider`。
 * 下载逻辑是通用的（fetch URL + 落盘），URL 由 webview 端通过 provider 抽象路由到正确域名。
 */
import { getUxPProvider } from "./providers/registry";

export const downloadCore = {
  async downloadToWorkDir(args: {
    url: string;
    suggestedName: string;
  }): Promise<{ ok: boolean; localPath?: string; error?: string }> {
    const provider = getUxPProvider();
    return await provider.downloadToWorkDir({
      url: args.url,
      suggestedName: args.suggestedName,
    });
  },
};
