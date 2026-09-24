/**
 * MiniMax CDN 结果视频下载 → 生成工作目录
 *
 * 全程走 URL 形式（getEntryWithUrl/createEntryWithUrl），不依赖 Folder 实例方法。
 * 注意：UXP File.write 的 format 默认是 utf8，写二进制必须显式传 formats.binary，
 * 否则写出的 mp4 是坏的（"[object ArrayBuffer]" 或报错）。
 * 大文件（≤50MB）受运行时内存限制；如失败会返回错误提示。
 */
import { uxp } from "../../globals";
import { filesCore, WORK_DIR_NAME } from "../files";

export const downloadCore = {
  async downloadToWorkDir(args: {
    url: string;
    suggestedName: string;
  }): Promise<{ ok: boolean; localPath?: string; error?: string }> {
    try {
      const fs: any = uxp.storage.localFileSystem;
      const baseUrl = `plugin-data:/${WORK_DIR_NAME}`;

      // 1) 确保工作目录存在且真的是文件夹
      const dir = await filesCore.ensureWorkDir();
      if (!dir) {
        return { ok: false, error: "无法获取生成工作目录（plugin-data 不可访问？）" };
      }
      if (!dir.isFolder) {
        return { ok: false, error: "工作目录被同名文件占用（AI-Generated-Media 不是文件夹），请检查后重试" };
      }
      console.log("[download] workDir:", dir.nativePath || baseUrl);

      // 2) 重名检查（getEntryWithUrl 找不到会 throw）
      const exists = async (name: string): Promise<boolean> => {
        try {
          const e = await fs.getEntryWithUrl(`${baseUrl}/${name}`);
          return !!e;
        } catch {
          return false;
        }
      };
      let name = args.suggestedName;
      let counter = 1;
      while (await exists(name)) {
        const dot = args.suggestedName.lastIndexOf(".");
        name =
          dot > 0
            ? `${args.suggestedName.slice(0, dot)}_${counter}${args.suggestedName.slice(dot)}`
            : `${args.suggestedName}_${counter}`;
        counter++;
      }

      // 3) 下载
      console.log("[download] fetching", args.url);
      const r = await fetch(args.url, { method: "GET" });
      console.log(
        "[download] fetch status:",
        r.status,
        "Content-Length:",
        r.headers.get("content-length"),
      );
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const ab = await r.arrayBuffer();
      console.log("[download] got", ab ? ab.byteLength : 0, "bytes");
      if (!ab || ab.byteLength === 0) {
        return { ok: false, error: "下载内容为空" };
      }

      // 4) 落盘（关键：显式 formats.binary，默认 utf8 会写坏二进制）
      const entry = await fs.createEntryWithUrl(`${baseUrl}/${name}`, {
        type: uxp.storage.types.file,
        overwrite: false,
      });
      const written = await entry.write(ab, {
        format: uxp.storage.formats.binary,
      });
      console.log("[download] wrote", written, "bytes to", entry.nativePath);

      const localPath = entry.nativePath || (await fs.getNativePath(entry));
      return { ok: true, localPath };
    } catch (e: any) {
      console.error("[download] exception:", e);
      return { ok: false, error: String(e?.message || e) };
    }
  },
};
