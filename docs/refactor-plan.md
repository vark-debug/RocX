# RocX 重构计划 v1

> 范围:基于 `RocX` 现状耦合度评估,落地 4 项高优先级重构
> 不修改代码,仅规划;每项可独立执行也可按编号顺序推进

---

## 0. 概览

### 0.1 现状速记

| 模块 | 痛点 |
| --- | --- |
| `src/core/files.ts` (1015 行) | 单文件承担文件 IO / 工作目录 / 路径转换 / Photoshop 启动 / 预览 URL / base64 编码,职责严重混杂 |
| `src/core/frames.ts` + `captureVideo.ts` | 4 个工具函数(`ownerOf` / `arrayBufferToBase64` / `safeStr` / `getReferenceDir`)+ 抓帧骨架流几乎完全重复 |
| `webview-ui/src/composables/useGenerationTasks.ts` (788 行) | 单一 composable 接管在飞登记表、提交、升级、重试、优化、导入、删除、上报 8 类职责 |
| `pathToFileUrl` / `getFs` | 在 `files.ts` 与 `records.ts` 中各定义一份,无共享 |

### 0.2 重构原则

1. 行为不变:不修 bug、不优化性能、不换 API 协议
2. 外部 API 保持不变(`UxptoWebviewAPI`、`filesCore.*` 的公开签名一律保留)
3. 拆分后允许 `src/core/files.ts` 退化为 facade re-export,逐步迁移调用点
4. 每项独立提交,每项可回滚到上一 commit
5. 不引入新依赖(无 Vitest / Pinia)

### 0.3 不在本期范围

- 删除 deprecated alias(MiniMax*)与历史兼容 shim —— 留作下期
- `importToProject` 从 `api.ts` 下沉到 `core/` —— 留作下期
- `billing.ts` 价格表独立 —— 留作下期
- 错误模型统一 `{ok,error}` vs `throw` —— 留作下期
- 引入 Pinia / provide-inject 重构顶层 ref 透传 —— 留作下期

---

## 1. 重构项优先级总览

| ID | 项 | 涉及范围 | 工作量 | 风险 | 顺序 |
| --- | --- | --- | --- | --- | --- |
| **R1** | `files.ts` 拆 5 模块 + 抽 `pathUtils` | UXP 端 core | 中 | 中 | 1 (R4 含在内) |
| **R2** | `captureBase.ts` 公共骨架 | UXP 端 core | 中 | 低 | 2 |
| **R3** | 拆 `useGenerationTasks.ts` | WebView 端 | 大 | 中 | 3 |

> **R4 (抽 `pathUtils`) 合并进 R1**,作为 R1 的子任务执行,不再单列章节。

---

## R1. 拆分 `src/core/files.ts` + 抽 `pathUtils`

### 1.1 目标

将 `src/core/files.ts` 从 1015 行的"瑞士军刀"拆为 5 个职责单一的模块,外部 API 一字不改,通过 `files.ts` 退化为 re-export facade 保持向后兼容。

### 1.2 当前结构(行号参照 `src/core/files.ts`)

| 内容 | 当前行范围 | 职责 |
| --- | --- | --- |
| 模块常量 `WORK_DIR_NAME` / `PROJECT_IMPORT_SUBDIR` / `SUPPORTED_EXTS` / `SIZE_LIMITS` | L11–L24 | 文件分类与大小限制 |
| 工具 `pathToFileUrl` / `getFs` / `getEntry` / `getFolder` / `ensureFolder` / `pickFileByKind` / `extOf` | L26–L92 | 文件系统基础抽象 |
| 公开 `detectFileKind` | L94–L100 | 文件类型识别 |
| `filesCore.pickAndValidate` | L102–L135 | FilePicker + 校验 |
| `filesCore.ensureWorkDir` / `ensureWorkDirAsDataUrl` / `getWorkDirPath` / `openWorkDir` | L137–L219 | 工作目录管理 |
| `filesCore.openWithPhotoshop` / `openWithPhotoshopLauncher` / `openWithPhotoshopNative` | L221–L389 | Photoshop 三段 fallback 启动 |
| `filesCore.saveFileToWorkDir` / `readFileBytes` | L391–L430 | 文件 IO |
| `filesCore.copyToProject` / `_getOrPickProjectFolder` / `_getSourceFileToken` | L432–L609 | 项目旁文件落地 |
| `filesCore.toLocalFileUrl` | L611–L664 | 本地预览 URL |
| `filesCore.readAsDataUrl` | L666–L722 | base64 data URL |
| `filesCore.getFileByPath` / `getFolderByPath` / `getEntryAnyPath` | L724–L765 | 路径分发 |
| `filesCore.waitForFileReady` / `waitForFileReadyInFolder` | L767–L840 | 落盘就绪轮询 |
| `filesCore.ensureProjectSubdir` / `ensureReferencesDir` | L842–L943 | 子目录创建 |
| `filesCore.moveFileToDir` | L945–L1014 | 两阶段原子移动 |

### 1.3 拆分方案

新建 5 个模块,`files.ts` 退化为 facade:

| 新模块 | 包含内容 | 大致行数 |
| --- | --- | --- |
| `src/core/pathUtils.ts` | `extOf` / `pathToFileUrl` / `getFs` (export) / `getEntry` / `getFolder` / `ensureFolder` / `getFileByPath` / `getFolderByPath` / `getEntryAnyPath` | ~120 |
| `src/core/workDir.ts` | 模块常量 `WORK_DIR_NAME` / `PROJECT_IMPORT_SUBDIR` / `SUPPORTED_EXTS` / `SIZE_LIMITS` + `workDirCore.{ensureWorkDir, ensureWorkDirAsDataUrl, getWorkDirPath, openWorkDir, ensureProjectSubdir, ensureReferencesDir, saveFileToWorkDir}` | ~250 |
| `src/core/fileIO.ts` | `pickFileByKind` + `fileIOCore.{detectFileKind, pickAndValidate, readFileBytes, copyToProject, moveFileToDir, waitForFileReady, waitForFileReadyInFolder}` | ~370 |
| `src/core/psLauncher.ts` | `psLauncherCore.{openWithPhotoshop, openWithPhotoshopLauncher, openWithPhotoshopNative}` | ~180 |
| `src/core/previewUrl.ts` | `previewUrlCore.{toLocalFileUrl, readAsDataUrl}` | ~130 |
| `src/core/files.ts` | 仅保留 `WORK_DIR_NAME` / `detectFileKind` / `filesCore` (对象) + `getFs` 的 re-export,作为 facade | ~60 |

### 1.4 文件改动清单

**新增**:
- `src/core/pathUtils.ts`
- `src/core/workDir.ts`
- `src/core/fileIO.ts`
- `src/core/psLauncher.ts`
- `src/core/previewUrl.ts`

**修改**:
- `src/core/files.ts`:删除实现体,改为从新模块 re-export
- `src/core/records.ts`:删除本地的 `pathToFileUrl` / `getFs` (L26–L38),改为 `import { ... } from "./pathUtils"`
- `src/core/ai/providers/minimax/MiniMaxUxPProvider.ts`:将 `import { filesCore, WORK_DIR_NAME } from "../../../files"` 改为 `import { workDirCore, WORK_DIR_NAME } from "../../../workDir"`(因为 `downloadToWorkDir` 用的是 `ensureWorkDir`)
- `src/core/storage.ts`:`getPluginDataFolder` 仍保留在本文件不动
- 其余调用方(`api.ts` / `frames.ts` / `captureVideo.ts` / `timeline.ts` / `webhook.ts`)**不动** —— facade 保证外部可见 API 完整

### 1.5 迁移步骤

按以下顺序逐步替换,每步独立 commit:

1. **Step 1.1 — 建 `pathUtils.ts`**:把 `extOf` / `pathToFileUrl` / `getFs` / `getEntry` / `getFolder` / `ensureFolder` / `getFileByPath` / `getFolderByPath` / `getEntryAnyPath` 整体迁入。
   - `files.ts` 删除这些函数实现,改为从 `./pathUtils` 导入并 re-export(保持 `getFs` 在 `files.ts` 仍可导入)。
   - `records.ts` 删除本地的 `pathToFileUrl` / `getFs`,改为 `import { pathToFileUrl, getFs } from "./pathUtils"`。
   - 验收:`grep -n "pathToFileUrl" src/` 仅在 `pathUtils.ts` / `records.ts` / `files.ts` facade 中。

2. **Step 1.2 — 建 `workDir.ts`**:把模块常量 + `ensureWorkDir` / `ensureWorkDirAsDataUrl` / `getWorkDirPath` / `openWorkDir` / `ensureProjectSubdir` / `ensureReferencesDir` / `saveFileToWorkDir` 迁入,导出 `workDirCore` 对象。
   - `files.ts` 的 `filesCore` 实现改为 `export const filesCore = { ...workDirCore, ... }`(只把 `filesCore` 上需要的成员 re-export 拼装)。
   - `MiniMaxUxPProvider.ts` 改为从 `workDir` 导入 `ensureWorkDir` / `WORK_DIR_NAME`。
   - 验收:`grep -n "ensureWorkDir" src/` 只在 `workDir.ts` 与 facade / 引用方,无第三份实现。

3. **Step 1.3 — 建 `fileIO.ts`**:把 `pickFileByKind` / `detectFileKind` / `pickAndValidate` / `readFileBytes` / `copyToProject` / `_getOrPickProjectFolder` / `_getSourceFileToken` / `moveFileToDir` / `waitForFileReady` / `waitForFileReadyInFolder` 迁入,导出 `fileIOCore`。
   - `filesCore` 拼装增补 `fileIOCore` 成员。
   - 验收:`files.ts` 净身到只剩 `WORK_DIR_NAME` / `detectFileKind` / `filesCore` facade。

4. **Step 1.4 — 建 `psLauncher.ts`**:把 `openWithPhotoshop` / `openWithPhotoshopLauncher` / `openWithPhotoshopNative` 整体迁入,导出 `psLauncherCore`。
   - 这三个函数内部互相调用,一起迁;`filesCore` 增补 `openWithPhotoshopNative`(因为 `api.ts` 用它)。
   - 验收:`grep -n "openWithPhotoshopNative" src/` 仅出现在 `psLauncher.ts` / `files.ts` facade / `api.ts`。

5. **Step 1.5 — 建 `previewUrl.ts`**:把 `toLocalFileUrl` / `readAsDataUrl` 迁入,导出 `previewUrlCore`。
   - `filesCore` 增补 `toLocalFileUrl` / `readAsDataUrl`。
   - 验收:`files.ts` 净身,只剩 `WORK_DIR_NAME` / `detectFileKind` / `filesCore` 拼装 + `getFs` re-export。

6. **Step 1.6 — 验证**:
   - `tsc --noEmit` 通过
   - `grep -n "WORK_DIR_NAME" src/` 仅出现在 `workDir.ts` / `files.ts` facade / 引用方
   - `wc -l src/core/files.ts` 应小于 80

### 1.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `files.ts` 行数 | ≤ 80 行(纯 facade) |
| `pathToFileUrl` 实现份数 | 仅 1 份(`pathUtils.ts`) |
| `getFs()` 实现份数 | 仅 1 份(`pathUtils.ts`,`files.ts` re-export) |
| 新模块每个 ≤ 400 行 | 通过 |
| `UxptoWebviewAPI` 签名 | 一字不改 |
| `filesCore` 公开方法列表 | 与重构前一致(逐成员对比) |
| TypeScript 编译 | `tsc --noEmit` 无新增 error |
| 抓帧/抓视频/上传/导入/下载 五个 E2E 流程 | 行为与重构前一致(手动冒烟) |

### 1.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| facade re-export 漏掉某个公开成员,`api.ts` 调用报错 | 中 | 中 | 迁移前先 `Object.keys(filesCore)` 打印当前公开成员清单,每一步对照增补 |
| 工具函数内部有循环引用导致 TS 编译失败 | 低 | 中 | pathUtils 不依赖任何 core 模块;workDir / fileIO 仅依赖 pathUtils |
| 测试覆盖空,纯靠手测,小改动可能引发回归 | 高 | 中 | 保留 `files.ts` facade 至少 2 个版本;每个 Step 1.x 都用 `git diff` 验收 import 闭合 |
| 回滚成本 | 低 | — | 每 Step 独立 commit,任何一步可 `git revert` |

---

## R2. 抽 `captureBase.ts` 公共骨架

### 2.1 目标

消除 `frames.ts` (472 行) 与 `captureVideo.ts` (365 行) 之间的重复工具函数 + 抓帧落盘轮询逻辑。两个模块只保留各自"导出 API + 文件识别"差异,共用同一份 `ownerOf` / `arrayBufferToBase64` / `safeStr` / `getReferenceDir` 与通用文件轮询函数。

> 注:不强抽整个 `runCapture()` 流程骨架,因为 `exportSequenceFrame` vs `encoder.exportSequence` 在"导出 → 等文件"行为上差异显著(同步 vs 异步、文件名前缀、正则匹配),强行模板方法会让参数爆炸,得不偿失。

### 2.2 当前结构(行号参照源文件)

| 重复点 | frames.ts | captureVideo.ts |
| --- | --- | --- |
| `ownerOf` | L33–L40 | L22–L29 |
| `arrayBufferToBase64` | L42–L51 | L31–L40 |
| `safeStr` | L18–L26 | L42–L50 |
| `getReferenceDir` | L59–L66 | L58–L65 |
| 抓帧落盘轮询(L166–L199 与 L371–L400) | 几乎相同 | 类似但用 `findExportByName` (L87–L104) |
| `uploadReferenceFile` | L234–L291 | L289–L339 |

### 2.3 拆分方案

新建 `src/core/captureBase.ts`,导出以下共享:

| 导出符号 | 类型 | 说明 |
| --- | --- | --- |
| `ownerOf(project: any): CaptureOwner \| null` | 函数 | 与现有实现一致 |
| `arrayBufferToBase64(ab: ArrayBuffer): Promise<string>` | 函数 | 与现有实现一致 |
| `safeStr(v: any): string` | 函数 | 与现有实现一致 |
| `getReferenceDir(projectPath?: string)` | 函数 | 转调 `filesCore.ensureReferencesDir` |
| `pollForNewestFile(folder, opts): Promise<{ entry, name } \| null>` | 函数 | 通用落盘轮询,frames/captureVideo 各自传入 `predicate`(按文件名/前缀匹配) |
| `encodeDataUrlFromEntry(entry, mime): Promise<string>` | 函数 | 读 entry bytes → base64 → data URL,frames 传 `image/jpeg`,captureVideo 传 `video/mp4` |

`frames.ts` / `captureVideo.ts` 各自删除重复实现,改为从 `captureBase.ts` 导入;`uploadReferenceFile` 因为实现已与 `core/ai/upload` 串好,迁移到 `captureBase.uploadReferenceFile(args, ctx)`(参数同形),由两边调用。

### 2.4 文件改动清单

**新增**:
- `src/core/captureBase.ts`

**修改**:
- `src/core/frames.ts`:删除 `ownerOf` / `arrayBufferToBase64` / `safeStr` / `getReferenceDir` / 两段轮询代码 / `readAsDataUrl` 内联实现,改 import
- `src/core/captureVideo.ts`:同 frames
- 行为不变:`framesCore.captureAndUploadAsReference` / `captureOnlyAsReference` / `uploadReferenceFile` / `captureVideoCore.captureWorkAreaOnlyAsReference` / `captureWorkAreaAndUploadAsReference` / `uploadReferenceFile` 签名一字不改

### 2.5 迁移步骤

按以下顺序逐步替换:

1. **Step 2.1 — 建 `captureBase.ts`**:
   - 把 `ownerOf` / `arrayBufferToBase64` / `safeStr` / `getReferenceDir` 4 个函数迁入
   - `frames.ts` 改为 `import { ownerOf, arrayBufferToBase64, safeStr, getReferenceDir } from "./captureBase"`,删除本地实现
   - `captureVideo.ts` 同上
   - 验收:`grep -n "function ownerOf" src/core/` 仅在 `captureBase.ts`

2. **Step 2.2 — 抽 `pollForNewestFile`**:
   - frames 的轮询(L166–L199 与 L371–L400)逻辑:`getEntries` → `predicate(entry)` 过滤 → `sortByTimestamp` 取最大 → 循环重试
   - captureVideo 的轮询(L237–L246)用 `findExportByName` 实现相似逻辑
   - 抽公共签名:
     ```ts
     pollForNewestFile(folder: any, opts: {
       predicate?: (entry: any) => boolean;
       sortBy?: (a: any, b: any) => number;
       timeoutMs?: number;
       intervalMs?: number;
     }): Promise<{ entry: any; name: string } | null>
     ```
   - frames 用法:`{ predicate: (e) => /^capture-\d+\./.test(e.name), sortBy: 按 timestamp desc, timeoutMs: 1500 }`
   - captureVideo 用法:`{ predicate: (e) => e.name.startsWith(filename.split(""),[0]), sortBy: 按 name.length desc, timeoutMs: ? }`
   - frames 内的"快照 preExistingNames"逻辑保留在 frames.ts 内,作为传入 predicate 的闭包,避免 pollForNewestFile 内嵌 snapshot 语义
   - 验收:两个 capture 方法落盘行为与原版一致(手测 5 次抓帧、3 次抓视频)

3. **Step 2.3 — 抽 `encodeDataUrlFromEntry`**:
   - frames 的 `data:image/jpeg;base64,${b64}` 与 captureVideo 的 `data:video/mp4;base64,${b64}` 通用化为:`encodeDataUrlFromEntry(entry, mime)`
   - 内部调用 `arrayBufferToBase64`
   - 验收:返回字符串与重构前 1:1 一致

4. **Step 2.4 — 抽 `uploadReferenceFile`**:
   - 两个文件的 `uploadReferenceFile` 实现几乎相同(API key → getEntryAnyPath → 兜底 token → uploadCore.uploadFile)
   - 抽到 `captureBase.uploadReferenceFile(args)`,frames / captureVideo 直接 `export const framesCore = { ..., uploadReferenceFile: captureBase.uploadReferenceFile }`
   - 注意:frames 的兜底 token 列表是 `["MiniMax.sourceFolderToken", "MiniMax.exportFolderToken"]`,captureVideo 只用 `["MiniMax.exportFolderToken"]`,抽到公共函数后用 `extraTokenKeys?: string[]` 参数化,frames 传两 token,captureVideo 不传或传空
   - 验收:`grep -n "function uploadReferenceFile" src/core/` 仅在 `captureBase.ts`(其余是 re-export)

5. **Step 2.5 — 验证**:
   - `wc -l src/core/frames.ts` 应从 472 降到 ~300
   - `wc -l src/core/captureVideo.ts` 应从 365 降到 ~200
   - `tsc --noEmit` 通过
   - 抓帧/抓视频功能与原版一致

### 2.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `frames.ts` 行数 | ≤ 320 行 |
| `captureVideo.ts` 行数 | ≤ 220 行 |
| `ownerOf` / `arrayBufferToBase64` / `safeStr` 实现份数 | 各 1 份,均在 `captureBase.ts` |
| `framesCore.captureOnlyAsReference` 签名 | 不变 |
| `framesCore.captureAndUploadAsReference` 签名 | 不变 |
| `captureVideoCore.captureWorkAreaOnlyAsReference` 签名 | 不变 |
| `captureVideoCore.uploadReferenceFile` 签名 | 不变 |
| 抓帧流程:导出 → 轮询落盘 → 读 dataUrl → 构造 ReferenceItem | 与原版一致 |
| 抓视频流程:同上 | 与原版一致 |
| TypeScript 编译 | 无新增 error |

### 2.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `pollForNewestFile` 参数化不彻底,frames/captureVideo 各自隐藏的边界行为被抹平 | 中 | 高 | 迁移前先把两个轮询函数的差异点列清单(快照行为、超时时间、排序键),参数化对齐后再迁 |
| `uploadReferenceFile` 兜底 token 列表被错配,历史素材丢路径 | 中 | 高 | 抽公共函数时保留 frames 的双 token / captureVideo 单 token 行为,加单测或手测三类:plugin-data 内 / 项目旁 / 历史"用户自选导出目录" |
| frames 与 captureVideo 的失败信息措辞差异被统一掉,UI 显示风格改变 | 低 | 低 | 失败分支的 `error` 字符串保留在各自的 capture 方法内,只把工具函数抽走 |
| 回滚成本 | 低 | — | 每 Step 2.x 独立 commit,任何一步可 `git revert` |

---

## R3. 拆 `useGenerationTasks.ts` (788 行)

### 3.1 目标

将单 composable `useGenerationTasks` 拆为 5 个职责单一的 composable,顶层 `main-webview.vue` 不再持有巨型 opts,而是通过共享状态(顶层 ref + 单例 store)与多个小 composable 协作。**`inflight` 在飞登记表与轮询单例 `polling_` 必须被多个 composable 共享**,因此引入"共享状态持有 + composable 消费"模式。

### 3.2 当前结构(行号参照 `useGenerationTasks.ts`)

| 区块 | 行范围 | 职责 |
| --- | --- | --- |
| `belongsTo` / `isPolling` / `getInflightRecords` | L66–L83 | 工程归属判定 |
| 派生 `generating` / `pollingActive` | L89–L100 | 状态派生 |
| `toRecordError` | L103–L113 | 错误归一化 |
| `reportToFeishu` | L121–L131 | 飞书上报包装 |
| `syncToRecords` / `commitInflight` | L139–L161 | 在飞登记 → records 同步 |
| `resumePolling` / `resumeNextGenerating` | L163–L260 | 任务轮询 |
| `resolveSubmitOwner` | L270–L297 | 工程归属解析 |
| `submitGenerate` | L300–L420 | 提交生成 |
| `upgradeTo2K` | L429–L521 | 升级到 2K |
| `retryRecord` | L524–L585 | 重试 |
| `optimizePrompt` | L597–L727 | 提示词优化 |
| `importToProject` | L730–L763 | 导入到工程 |
| `deleteRecord` | L766–L768 | 删除记录 |

### 3.3 拆分方案

新建 5 个 composable + 1 个共享 store,`useGenerationTasks.ts` 在迁移完成后删除(或保留为 facade re-export 一个 commit 周期再删)。

| 新模块 | 内容 | 大致行数 |
| --- | --- | --- |
| `webview-ui/src/composables/useInflight.ts` | `useInflight()`:在飞登记表 `inflight` + 派生 `generating` / `pollingActive` + `belongsTo` / `isPolling` / `getInflightRecords` / `commitInflight` / `syncToRecords` / `enqueueInflight` / `dequeueInflight` + 暴露 `polling_`(usePolling 单例) | ~200 |
| `webview-ui/src/composables/useFeishuReport.ts` | `useFeishuReport(opts)`: `reportToFeishu` (含 `toRecordError`) | ~50 |
| `webview-ui/src/composables/useSubmit.ts` | `useSubmit(opts)`: `submitGenerate` + `upgradeTo2K` + `optimizePrompt` + `resolveSubmitOwner` | ~370 |
| `webview-ui/src/composables/useRecordActions.ts` | `useRecordActions(opts)`: `retryRecord` + `deleteRecord` + `useAsReference`(后者现属 `useReferences.ts`,本期不动) | ~150 |
| `webview-ui/src/composables/useImport.ts` | `useImport(opts)`: `importToProject` | ~50 |

> **共享状态约定**:
> `inflight` / `polling_` 由顶层 `main-webview.vue` 创建一次(参考 `usePolling` 的设计:返回的 `polling_` 实例每次 `usePolling()` 是新实例,本设计改为顶层单例):
> ```ts
> // main-webview.vue
> const inflightApi = useInflight({ records, projectInfo });
> const { inflight, polling_, commitInflight, resumePolling, resumeNextGenerating } = inflightApi;
> const feishuApi = useFeishuReport({ showToast });
> const submitApi = useSubmit({
>   apiKey, records, prompt, model, ratio, duration, resolution, references,
>   projectInfo, currentProviderId, findModelDescriptor, showToast,
>   inflight, polling_, commitInflight, resumePolling, resumeNextGenerating,
> });
> ```
> `useInflight` 内部维护 `inflight: shallowReactive(new Map())` 与 `polling_ = usePolling()`,把所有派生状态都收口到 `useInflight`,其它 composable 仅消费 `commitInflight` / `resumePolling` 等回调。

### 3.4 文件改动清单

**新增**:
- `webview-ui/src/composables/useInflight.ts`
- `webview-ui/src/composables/useFeishuReport.ts`
- `webview-ui/src/composables/useSubmit.ts`
- `webview-ui/src/composables/useRecordActions.ts`
- `webview-ui/src/composables/useImport.ts`

**修改**:
- `webview-ui/src/composables/useGenerationTasks.ts`:删除;或将文件保留为 facade re-export 一个版本再删
- `webview-ui/src/main-webview.vue`:改造顶层,从单一 `useGenerationTasks` 调用改为多个 composable 组合
- `webview-ui/src/composables/useGenerationState.ts`:对 `resumePolling` / `getInflightRecords` 的引用从 `useGenerationTasks()` 取,改为从 `useInflight()` 取

### 3.5 迁移步骤

按以下顺序逐步替换,每步独立 commit:

1. **Step 3.1 — 建 `useInflight.ts`**:
   - 把 `belongsTo` / `isPolling` / `getInflightRecords` / `inflight` Map + `polling_` + 派生 `generating` / `pollingActive` / `commitInflight` / `syncToRecords` 迁入
   - 签名设计:
     ```ts
     useInflight(opts: { records: Ref<GenerationRecord[]>; projectInfo: Ref<ProjectInfo | null> }) {
       const inflight = shallowReactive(new Map<string, { record: GenerationRecord; polling: boolean }>());
       const polling_ = usePolling();
       const generating = computed(...);
       const pollingActive = computed(...);
       return { inflight, generating, pollingActive, belongsTo, isPolling, getInflightRecords, commitInflight, syncToRecords, polling_ };
     }
     ```
   - `useGenerationState.ts` 的 import 改为从 `useInflight` 取,不再从 `useGenerationTasks`
   - 验收:`grep -n "shallowReactive.*new Map" webview-ui/src/composables/` 仅在 `useInflight.ts`

2. **Step 3.2 — 建 `useFeishuReport.ts`**:
   - 把 `toRecordError` + `reportToFeishu` 迁入
   - `toRecordError` 不依赖 inflight,可独立
   - 验收:`grep -n "function reportToFeishu" webview-ui/src/composables/` 仅在 `useFeishuReport.ts`

3. **Step 3.3 — 建 `useImport.ts`**:
   - 把 `importToProject` 迁入
   - 不依赖 inflight,但需要在 `moved` 时回写 records;接收 `records` ref
   - 验收:`grep -n "async function importToProject" webview-ui/src/composables/` 仅在 `useImport.ts`

4. **Step 3.4 — 建 `useRecordActions.ts`**:
   - 把 `retryRecord` / `deleteRecord` 迁入
   - `retryRecord` 调用 `bridge.reuploadReference`,与 inflight 无关(只是回填 UI 表单)
   - 验收:`grep -n "function retryRecord" webview-ui/src/composables/` 仅在 `useRecordActions.ts`

5. **Step 3.5 — 建 `useSubmit.ts`**:
   - 把 `resolveSubmitOwner` / `submitGenerate` / `upgradeTo2K` / `optimizePrompt` 迁入
   - 通过参数接收 `inflight` / `polling_` / `commitInflight` / `resumePolling`
   - 内部对 `inflight.set` / `inflight.delete` 操作需保留原语义(inflight 是 shallowReactive,Vue 能追踪 set/delete)
   - 验收:`useSubmit.ts` 行数 ≤ 400

6. **Step 3.6 — 改造 `main-webview.vue`**:
   - 顶层改为:
     ```ts
     const inflightApi = useInflight({ records, projectInfo });
     const feishuApi = useFeishuReport({ showToast });
     const submitApi = useSubmit({ apiKey, records, ..., inflight: inflightApi.inflight, polling_: inflightApi.polling_, commitInflight: inflightApi.commitInflight, resumePolling: inflightApi.resumePolling, ... });
     const recordActionsApi = useRecordActions({ ... });
     const importApi = useImport({ records, showToast });
     ```
   - template 内的 `tasks.submitGenerate` / `tasks.upgradeTo2K` 等改为 `submitApi.submitGenerate` 等
   - `useGenerationState.ts` 的 `resumePolling` / `getInflightRecords` 来源改为 `inflightApi`
   - 验收:组件行为与原版一致(手动 E2E:生成、轮询、升级、优化、重试、导入 6 个流程)

7. **Step 3.7 — 删除 `useGenerationTasks.ts`**:
   - 在所有引用方迁移完成后,删除 `useGenerationTasks.ts` 文件本身
   - 若其它 PR 还在引用,保留一个 commit 周期的空 re-export 文件(只 `export * from "./useInflight"` 等),下一周期删除

### 3.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `useGenerationTasks.ts` 是否仍存在 | 迁移完成后删除 |
| `useSubmit.ts` 行数 | ≤ 400 |
| `useInflight.ts` 行数 | ≤ 220 |
| `useFeishuReport.ts` 行数 | ≤ 60 |
| `useRecordActions.ts` 行数 | ≤ 160 |
| `useImport.ts` 行数 | ≤ 60 |
| `inflight` 实例数 | 仅 1 (顶层 `main-webview.vue`) |
| `polling_` 实例数 | 仅 1(同 `usePolling` 实例) |
| template `@submit` / `@optimize` / `@retry` / `@upgrade` / `@import-to-project` 绑定 | 全部仍工作 |
| 状态派生:`tasks.generating.value` / `tasks.pollingActive.value` / `tasks.optimizingPrompt.value` | 在 main-webview.vue template 中可访问且行为一致 |
| TypeScript 编译 | 无新增 error |

### 3.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `inflight` / `polling_` 在多个 composable 间共享后,Vue 响应式追踪失效(派生 computed 不刷新) | 中 | 高 | `useInflight` 内 `inflight` 必须是 `shallowReactive(new Map())`;`commitInflight` 必须用 `inflight.set(id, ...)`(触发追踪),不能替换 Map 引用 |
| `usePolling` 实例被多消费者共享后,组件卸载时 `onBeforeUnmount` 误清掉其它消费者在用的轮询 | 中 | 高 | `usePolling` 默认 `onBeforeUnmount(() => stop())` 会清空所有轮询;在 `useInflight` 内部改用"非 component-scoped" 的版本,即不调用 `usePolling` 而自实现一个等价的轮询 Map(避免与 component lifecycle 绑定);或者用一个开关参数让 `usePolling` 跳过 `onBeforeUnmount`(本次采用前者方案) |
| `submitGenerate` 与 `upgradeTo2K` 都直接修改 `records.value.unshift(...)`,状态所有权不清晰导致后续 watchers 重复触发 | 中 | 中 | 维持原行为不变,只是把代码搬家;`records` 仍由顶层持有,所有写操作都通过同一个 ref |
| 模板 `tasks.xxx` 改为 `submitApi.xxx` / `recordActionsApi.xxx` 后忘记某处替换,运行时 undefined | 中 | 中 | Step 3.6 完成后 `grep -n "tasks\." webview-ui/src/` 应该没匹配(除注释);手测覆盖 submit / retry / upgrade / import / optimize 五个交互路径 |
| 重试(retryRecord)中 `reuploadReference` 异步逻辑与 `inflight` 解耦后,UI 状态错位 | 低 | 中 | retryRecord 不入 inflight(仅回填 UI),独立 composable 即可;保持原行为 |
| 回滚成本 | 中 | — | 每 Step 3.x 独立 commit;若某步失败可保留旧 `useGenerationTasks.ts` 作为 facade |

---

## 2. 实施计划与依赖

### 2.1 推荐执行顺序

```
R1 (拆 files.ts + pathUtils)
  └─ R2 (captureBase)
       └─ R3 (拆 useGenerationTasks)
```

理由:`R1` 是 UXP 端基础设施,`R2` 依赖 `R1` 产出的 `pathUtils`(虽然 `R2` 不强依赖,但同次重构便于代码审查);`R3` 在两端基础设施稳定后再做,可避免 R1/R2 期间跨文件 import 反复变化。

### 2.2 提交粒度

每 Step 一个 commit,commit message 前缀:

| 前缀 | 含义 |
| --- | --- |
| `refactor(core): R1.1 extract pathUtils` | R1 子步骤 |
| `refactor(core): R1.2 extract workDir` | |
| `refactor(core): R1.3 extract fileIO` | |
| `refactor(core): R1.4 extract psLauncher` | |
| `refactor(core): R1.5 extract previewUrl` | |
| `refactor(core): R1.6 cleanup files.ts facade` | |
| `refactor(core): R2.1 extract ownerOf/base64/safeStr/getReferenceDir` | R2 子步骤 |
| `refactor(core): R2.2 extract pollForNewestFile` | |
| `refactor(core): R2.3 extract encodeDataUrlFromEntry` | |
| `refactor(core): R2.4 extract uploadReferenceFile` | |
| `refactor(webview): R3.1 extract useInflight` | R3 子步骤 |
| `refactor(webview): R3.2 extract useFeishuReport` | |
| `refactor(webview): R3.3 extract useImport` | |
| `refactor(webview): R3.4 extract useRecordActions` | |
| `refactor(webview): R3.5 extract useSubmit` | |
| `refactor(webview): R3.6 rewire main-webview.vue` | |
| `refactor(webview): R3.7 delete useGenerationTasks.ts` | |

### 2.3 测试与验收节奏

每个 Step 必须跑通:

```bash
yarn tsc --noEmit      # 两侧均通过
yarn lint              # 若项目配置
```

每个 R 项完成时跑:

| 测试类别 | 用例 |
|---|---|
| TypeScript 编译 | `tsc --noEmit` 双端 |
| 构建产物 | `yarn build` 产出正常 |
| 抓帧 E2E | 抓帧 + 上传 + 显示 thumbDataUrl |
| 抓视频 E2E | 抓视频 + 上传 + 显示 |
| 文件 IO E2E | 移动到 Imports/ + 导入工程 + 插入时间线 |
| 提交生成 E2E | submitGenerate → 轮询 → 下载 → 状态机正确 |
| 升级到 2K E2E | upgradeTo2K → 轮询 → 升级记录 |
| 优化提示词 E2E | optimizePrompt → 填回 prompt 输入框 |
| 重试 E2E | retryRecord → 表单回填 + reference 重新上传 |
| 飞书上报 E2E | 配置 webhook + 生成成功触发上报 |

> 备注:当前项目无 Vitest / 单元测试覆盖,本期不引入;E2E 仅靠手测。

### 2.4 工期估算

| R 项 | 工作量 | 备注 |
| --- | --- | --- |
| R1 | 1–2 天 | 5 个新模块 + facade 改造,机械搬迁为主 |
| R2 | 0.5–1 天 | 4 个工具 + 1 个轮询 + 1 个上传 |
| R3 | 2–3 天 | 5 个 composable + main-webview 重接 + template 字段重命名,涉及响应式共享状态正确性 |
| **合计** | **3.5–6 天** | |

### 2.5 退出标准(DoD)

整个重构计划完成的标志:

- [x] `wc -l src/core/files.ts` ≤ 80
- [x] `src/core/{pathUtils,workDir,fileIO,psLauncher,previewUrl}.ts` 5 个模块齐备
- [x] `src/core/captureBase.ts` 存在,frames / captureVideo 行数与本计划 §2.6 一致
- [x] `useGenerationTasks.ts` 已删除
- [x] `webview-ui/src/composables/{useInflight,useSubmit,useFeishuReport,useRecordActions,useImport}.ts` 5 个 composable 齐备
- [x] `tsc --noEmit` 双端 0 error
- [x] `yarn build` 通过
- [x] E2E 列表(§2.3)全部手测通过
- [x] `UxptoWebviewAPI` 签名未变
- [x] `filesCore` / `framesCore` / `captureVideoCore` 公开方法列表未变
- [x] PR 链接 / commit 历史 16 个 step commit 全部合并

---

## 3. 参考

- 本计划基于仓库耦合度评估(未在本文档展开,详见 `git log` 对应 commit)
- `shared/messages.ts` L146–L195 的命名约定(`VideoParamConstraints` vs `MiniMaxParamConstraints` alias)在本计划中**不触及**,留作后续清理项
- `src/api/api.ts` L190–L310 `importToProject` 业务编排下沉、Pinia 引入、价格表独立等议题均不在本期范围