/**
 * MiniMax wire format：content 数组 + mm_file:// 引用语法
 */
import type { ReferenceItem } from "@shared/messages";
import type { ReferenceType } from "@shared/messages";

export function refTypeToWireType(t: ReferenceType): string {
  switch (t) {
    case "reference_video":
      return "video_url";
    case "reference_image":
      return "image_url";
    case "reference_audio":
      return "audio_url";
  }
}

/** MiniMax 私有引用语法：mm_file://<file_id> */
export function buildReferenceUrl(fileId: string): string {
  return `mm_file://${fileId}`;
}

/** 构造 MiniMax content 数组 */
export function buildContent(prompt: string, references: ReferenceItem[]): any[] {
  const content: any[] = [{ type: "text", text: prompt }];
  for (const ref of references) {
    if (!ref.fileId) {
      throw new Error("参考素材缺少 fileId，请先上传");
    }
    const wireType = refTypeToWireType(ref.type);
    content.push({
      type: wireType,
      [wireType]: {
        url: buildReferenceUrl(ref.fileId),
      },
      role: ref.type,
    });
  }
  return content;
}

/** 检测 body 是否意外含 base64 data URL */
export function warnIfContainsBase64(bodyString: string, tag: string): void {
  if (bodyString.includes("data:") && bodyString.includes("base64")) {
    console.warn(
      `[MiniMax] ⚠️ ${tag} body 包含 base64 data URL！请改用 mm_file://<file_id>`,
    );
  }
}