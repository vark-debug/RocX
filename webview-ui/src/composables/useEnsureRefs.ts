/**
 * 参考素材按目标 provider 补传（useSubmit / useImageSubmit 共享）
 *
 * fileId 与 provider 绑定：提交时若素材的 uploadProvider 不是目标 provider
 * （如视频模式抓的图切到图片模式提交），本地文件还在就现场补传，
 * 失败则跳过该素材 —— 避免把 A 平台的 fileId 传给 B 平台。
 */
import { bridge } from "../services/bridge";
import { DEFAULT_PROVIDER_ID } from "../providers/core/registry";
import { KLING_PROVIDER_ID } from "@shared/messages";
import type { ReferenceItem } from "@shared/messages";
import { ensureKlingUrls } from "../providers/kling/klingPreUpload";

export async function ensureRefsForProvider(
  refs: ReferenceItem[],
  providerId: string,
): Promise<{ refs: ReferenceItem[]; skipped: number }> {
  // 可灵走 CLI：参考图 / 参考视频直接传本地路径，CLI 自己上传到可灵（resolveFileUrl 自动 upload），
  // 不存在「先传自家再换 fileId」这一说。音频参考可灵暂不支持（omni 的 audio_N 槽位先不接）。
  //
  // 注：素材可能是在别的 provider 模式下抓的，fileId 属于那个平台
  // （minimax 的 file_id 是 int64，运行时可能是 number）。
  // 这里原样保留 —— 可灵侧 referenceSource 已做类型守卫；
  // 切回原 provider 时同一个 fileId 还要继续用（mm_file://<数字> 是合法的）。
  if (providerId === KLING_PROVIDER_ID) {
    const keep = refs.filter(
      (r) => r.type === "reference_image" || r.type === "reference_video",
    );
    // 等抓素材时启动的预上传跑完（直链回填到 ref）——
    // 直链就绪时 CLI 直通不重传，省掉 CLI 内部的 4-8s 上传；
    // 没就绪则保持本地路径，CLI 自行上传（与改造前一致）。
    await ensureKlingUrls(keep);
    return { refs: keep, skipped: refs.length - keep.length };
  }

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
