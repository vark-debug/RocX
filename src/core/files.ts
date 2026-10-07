/**
 * 文件 IO 聚合 facade
 *
 * 历史背景:本文件原本是 1015 行的"瑞士军刀",承担文件 IO / 工作目录 / 路径转换 /
 * Photoshop 启动 / 预览 URL 等多职责。R1 重构后,实际实现已拆到 pathUtils / workDir /
 * fileIO / psLauncher / previewUrl 五个模块,本文件退化为聚合 + 向后兼容 facade。
 * 外部 (api.ts / frames.ts / captureVideo.ts) 通过 filesCore 调用,签名保持不变。
 */
import { getFs } from "./pathUtils";
import { WORK_DIR_NAME, PROJECT_IMPORT_SUBDIR, workDirCore } from "./workDir";
import { detectFileKind, fileIOCore } from "./fileIO";
import { psLauncherCore } from "./psLauncher";
import { previewUrlCore } from "./previewUrl";
import {
  getFileByPath as _getFileByPath,
  getFolderByPath as _getFolderByPath,
  getEntryAnyPath as _getEntryAnyPath,
} from "./pathUtils";

export { getFs };
export { WORK_DIR_NAME, PROJECT_IMPORT_SUBDIR } from "./workDir";
export { detectFileKind };

export const filesCore = {
  ...workDirCore,
  ...fileIOCore,
  ...psLauncherCore,
  ...previewUrlCore,

  // pathUtils 透传 facade:外部 (api.ts / frames.ts / captureVideo.ts) 通过 filesCore 调用
  // 路径相关方法,签名保持不变。
  async getFileByPath(p: string): Promise<any | null> {
    return await _getFileByPath(p);
  },
  async getFolderByPath(p: string): Promise<any | null> {
    return await _getFolderByPath(p);
  },
  async getEntryAnyPath(p: string): Promise<any | null> {
    return await _getEntryAnyPath(p, { pluginDataDirName: WORK_DIR_NAME });
  },
};