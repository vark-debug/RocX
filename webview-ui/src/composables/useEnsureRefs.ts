/**
 * 参考素材按目标 provider 补传（useSubmit / useImageSubmit 共享）
 *
 * fileId 与 provider 绑定：提交时若素材的 uploadProvider 不是目标 provider
 * （如视频模式抓的图切到图片模式提交），本地文件还在就现场补传，
 * 失败则跳过该素材 —— 避免把 A 平台的 fileId 传给 B 平台。
 */
import { bridge } from "../services/bridge";
import { DEFAULT_PROVIDER_ID } from "../providers/core/registry";
import type { ReferenceItem } from "@shared/messages";

export async function ensureRefsForProvider(
  refs: ReferenceItem[],
  providerId: string,
): Promise<{ refs: ReferenceItem[]; skipped: number }> {
  const out: ReferenceItem[] = [];
  let skipped = 0;
  for (const r of refs) {
    if (!r.fileId) {
      skipped++;
      continue;
    }
    const belongs =
      r.uploadProvider === providerId ||
      (!r.uploadProvider && providerId === DEFAULT_PROVIDER_ID);
    if (belongs) {
      out.push(r);
      continue;
    }
    const up = await bridge.uploadReferenceFile({
      filePath: r.localPath,
      fileName: r.fileName,
      providerId,
    });
    if (up.ok && up.fileId) {
      out.push({
        ...r,
        fileId: up.fileId,
        uploadedAt: up.uploadedAt,
        uploadProvider: providerId,
      });
    } else {
      console.warn(
        `[refs] 换 provider(${providerId}) 补传参考素材失败: ${up.error}`,
      );
      skipped++;
    }
  }
  return { refs: out, skipped };
}
