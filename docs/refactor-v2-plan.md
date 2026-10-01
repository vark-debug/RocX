# RocX 重构计划 v2

> 范围:基于 [refactor-plan.md v1](./refactor-plan.md) §0.3 中标注"留作下期"的 5 项清理
> 不修改代码,仅规划;每项可独立执行也可按编号顺序推进

---

## 0. 概览

### 0.1 现状速记

v1 落地后剩余的清理目标都是"减法"为主:让代码更像一座只有一份实现的图书馆,而非兼容层 + 实际实现的二元并存。

| 项 | 范围 | 工作量 | 风险 |
| --- | --- | --- | --- |
| **V1** 删除 deprecated alias + MiniMax shim | webview + shared | 中 | 中 |
| **V2** `importToProject` 从 api.ts 下沉到 core/ | UXP 端 api.ts | 小 | 低 |
| **V3** `billing.ts` 价格表独立 | UXP 端 webhook.ts | 小 | 低 |
| **V4** 错误模型统一 `{ok,error}` vs `throw` | webview 业务层 | 中 | 中 |
| **V5** Vue provide/inject 重构顶层 ref 透传 | webview 端 | 中 | 中 |

### 0.2 重构原则

1. 行为不变:不修 bug、不优化性能、不换 API 协议
2. 删除的 deprecated alias 必须先确认全工程零引用(否则按 v1 模式留一个空 re-export 文件作为过渡)
3. 桥层 `{ok, error}` 保留(Comlink 跨端不能 throw);仅收敛 webview 业务层的 throw
4. provide/inject 优先于 Pinia(不引入新依赖),且仅作渐进重构,不替换全部 ref
5. 每项独立提交,每项可回滚到上一 commit

### 0.3 退出标准(DoD)

整个 v2 计划完成的标志:

- [x] `shared/messages.ts` 不再有 `MiniMax*` deprecated alias
- [x] `webview-ui/src/services/MiniMax.ts` 不存在(或仅留 `import { MiniMaxProvider } from "../providers/minimax"` 一行)
- [x] `webview-ui/src` 下无 `MiniMaxError` / `MiniMaxAPI` 引用
- [x] `src/api/api.ts` 不再有 `importToProject` 实现,委托 `core/import.ts`
- [x] `webhook.ts` 内不再有价格表常量;`src/core/billing.ts` 提供 `estimateCost`
- [x] 业务层(`useSubmit` / `useImport` / `useFeishuReport`)不再 throw,返回 `{ok, error}`;桥层保持不变
- [x] `main-webview.vue` 顶层 ref 数量从 12+ 减到 ≤ 8,`useGenerationState` / `useRecordEdit` 等 composable 通过 inject 拿共享状态
- [x] `tsc --noEmit` 双端 0 error
- [x] E2E 列表(沿用 v1 §2.3)全部手测通过

---

## V1. 删除 deprecated alias(MiniMax*)与历史兼容 shim

### V1.1 目标

清除 v0 重构(commit `00b1e1c` "refactor(providers): 模块化抽象层")留下的兼容层,让代码库只剩一份实现。

### V1.2 当前状态

**类型 alias (`shared/messages.ts` L186–195)**:

```ts
/** @deprecated Use VideoModel instead. */
export type MiniMaxModel = VideoModel;
/** @deprecated Use VideoRatio instead. */
export type MiniMaxRatio = VideoRatio;
/** @deprecated Use VideoResolution instead. */
export type MiniMaxResolution = VideoResolution;
/** @deprecated Use VideoParamConstraints instead. */
export type MiniMaxParamConstraints = VideoParamConstraints;
/** @deprecated Use VIDEO_PARAM_CONSTRAINTS instead. */
export const MINIMAX_PARAM_CONSTRAINTS = VIDEO_PARAM_CONSTRAINTS;
```

**历史兼容 shim (`webview-ui/src/services/MiniMax.ts`,115 行)**:

- `MiniMaxError extends VideoGenError` — 仅保留类名以兼容 `instanceof MiniMaxError` 检查
- `MiniMaxAPI` 类 — 4 个方法全部委托给 `minimaxProvider`,签名映射

### V1.3 拆分方案

| 类别 | 旧符号 | 新符号 | 删除时机 |
| --- | --- | --- | --- |
| 类型 | `MiniMaxModel` | `VideoModel` | V1.1 |
| 类型 | `MiniMaxRatio` | `VideoRatio` | V1.1 |
| 类型 | `MiniMaxResolution` | `VideoResolution` | V1.1 |
| 类型 | `MiniMaxParamConstraints` | `VideoParamConstraints` | V1.1 |
| 常量 | `MINIMAX_PARAM_CONSTRAINTS` | `VIDEO_PARAM_CONSTRAINTS` | V1.1 |
| 类型 | `MiniMaxCreateRequest` | `VideoGenCreateRequest` | V1.2 |
| 类型 | `MiniMaxCreateResponse` | `VideoGenCreateResponse` | V1.2 |
| 类型 | `MiniMaxQueryResponse` | `VideoGenQueryResponse` | V1.2 |
| 类 | `MiniMaxAPI` | `MiniMaxProvider`(直接 new) | V1.2 |
| 类 | `MiniMaxError` | `VideoGenError` | V1.2 |
| 文件 | `webview-ui/src/services/MiniMax.ts` | 整个删除 | V1.3 |

### V1.4 文件改动清单

**V1.1 — 类型 alias 清理**:
- `shared/messages.ts`:删除 L186–195(MiniMax* 5 个 alias)
- `webview-ui/src/composables/useSubmit.ts`:`MiniMaxModel` / `MiniMaxRatio` / `MiniMaxResolution` → 新名
- `webview-ui/src/composables/useRecordEdit.ts`:同上
- `webview-ui/src/composables/useGenerationState.ts`:`MINIMAX_PARAM_CONSTRAINTS` → `VIDEO_PARAM_CONSTRAINTS`
- `webview-ui/src/composables/useReferences.ts`:同上
- `webview-ui/src/main-webview.vue`:L27–29 类型 import
- `webview-ui/src/components/PromptInput.vue`:类型 import
- `webview-ui/src/components/SettingsPanel.vue`:类型 import
- `webview-ui/src/services/MiniMax.ts`:类型 import(将被删除,V1.2 阶段处理)

**V1.2 — shim 替换**:
- `webview-ui/src/services/MiniMax.ts`:整个文件删除
- `webview-ui/src/composables/useSubmit.ts`:
  - `import { MiniMaxAPI, MiniMaxError } from "../services/MiniMax"` → 移除
  - `const mini = new MiniMaxAPI(opts.apiKey.value)` → `const mini = new MiniMaxProvider(opts.apiKey.value)`
  - `await mini.createVideo(reqPayload)` → `await mini.createVideo(reqPayload)`(签名略变)
  - `await mini.createVideoDryRun(reqPayload)` → 改用 `MiniMaxProvider` 暴露或保留 inline mock
  - `await mini.regenerateVideo({...})` → `await mini.regenerateVideo({...apiKey: opts.apiKey.value})`(MiniMaxProvider 签名需要 apiKey)
  - `await mini.submitOptimizePrompt({...})` → 同上
- `webview-ui/src/composables/useFeishuReport.ts`:
  - `import { MiniMaxError }` → `import { VideoGenError } from "../providers/core/errors"`
  - `e instanceof MiniMaxError` → `e instanceof VideoGenError`
- `webview-ui/src/composables/usePolling.ts`:`MiniMaxQueryResponse` → `VideoGenQueryResponse`

### V1.5 迁移步骤

**Step V1.1 — 类型 alias 清理**(独立 commit)
1. 全文 `grep -rn "MiniMaxModel\|MiniMaxRatio\|MiniMaxResolution\|MiniMaxParamConstraints\|MINIMAX_PARAM_CONSTRAINTS"` 确认引用点
2. 逐文件替换为新名(`VideoModel` / `VideoRatio` / `VideoResolution` / `VideoParamConstraints` / `VIDEO_PARAM_CONSTRAINTS`)
3. 删除 `shared/messages.ts` L186–195 5 个 alias
4. `tsc --noEmit` 通过
5. commit: `chore(messages): remove MiniMax* deprecated alias`

**Step V1.2 — shim 替换**(独立 commit)
1. 修改 `useSubmit.ts`:移除 MiniMaxAPI,直接 `new MiniMaxProvider(apiKey)`;改 `regenerateVideo` / `submitOptimizePrompt` 签名(增加 `apiKey` 字段)
2. 修改 `useFeishuReport.ts`:`MiniMaxError` → `VideoGenError`
3. 修改 `usePolling.ts`:`MiniMaxQueryResponse` → `VideoGenQueryResponse`
4. `tsc --noEmit` 通过
5. `webview-ui/src` 下 `grep "MiniMaxAPI\|MiniMaxError"` 应仅出现在 shim 文件本身(MiniMax.ts)
6. commit: `chore(webview): drop services/MiniMax compatibility wrapper, switch to MiniMaxProvider`

**Step V1.3 — 删除 shim 文件**(独立 commit)
1. `rm webview-ui/src/services/MiniMax.ts`
2. `tsc --noEmit` 通过(确认无外部引用)
3. commit: `chore(webview): remove services/MiniMax.ts shim file`

### V1.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `shared/messages.ts` 中 `MiniMax*` alias 行数 | 0 |
| `webview-ui/src/services/MiniMax.ts` 存在 | 否 |
| `webview-ui/src` 引用 `MiniMaxAPI` | 0 处 |
| `webview-ui/src` 引用 `MiniMaxError` | 0 处 |
| `webview-ui/src` 引用 `MiniMaxCreateRequest` | 0 处 |
| `webview-ui/src` 引用 `MiniMaxQueryResponse` | 0 处 |
| `useSubmit.ts` 行数 | 略减(移除 MiniMaxAPI wrapper) |
| TypeScript 编译 | 0 error |

### V1.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 外部 NPM 包 / 内部 PR / commit log 引用 `MiniMaxModel` 等旧名 | 低 | 低 | `grep -rn "MiniMaxModel\|MiniMaxError"` 全文检查;commit log 不可改,但代码层可以 |
| `MiniMaxAPI` 删除前遗漏引用 | 中 | 高 | Step V1.2 前先 `grep "MiniMaxAPI"` 全文;再删除文件 |
| `regenerateVideo` / `submitOptimizePrompt` 签名变更影响 webview 业务 | 中 | 中 | `MiniMaxProvider` 已要求 `apiKey` 参数(`webview-ui/src/providers/minimax/MiniMaxProvider.ts:177` `apiKey: string`),业务层补字段即可 |
| 回滚成本 | 低 | — | 每 Step 独立 commit;若 V1.2 出问题可保留 shim |

---

## V2. `importToProject` 从 `api.ts` 下沉到 `core/`

### V2.1 目标

将 `api.ts` L190–310(120+ 行)的 `importToProject` 业务编排抽到 `src/core/import.ts`,让 `api.ts` 退化为纯桥接薄壳,业务知识不再躲在 bridge 层。

### V2.2 当前结构

`src/api/api.ts` 中 `importToProject` 流程(120+ 行):
1. `projectCore.getCurrent()` 拿项目路径
2. `recordsCore.read()` 拿当前工程的 records
3. `filesCore.ensureProjectSubdir(projectDir, "AI-Generated-Media/Imports")`
4. 逐条 `filesCore.moveFileToDir()` + 更新 `item.workFile`
5. `recordsCore.write()` 持久化新路径
6. `filesCore.waitForFileReadyInFolder` 落盘校验
7. `premierepro.Project.getActiveProject().importFiles(paths, true)`

### V2.3 拆分方案

新建 `src/core/import.ts`,导出 `importToProjectCore`:

```ts
export const importToProjectCore = {
  async importAndMove(args: { recordIds: string[]; target?: { guid?, path? } }) {
    // 1-6 步全部逻辑
  },
};
```

`api.ts` 改为:

```ts
async importToProject(args: { recordIds: string[] }) {
  return importToProjectCore.importAndMove(args);
},
```

### V2.4 文件改动清单

**新增**:
- `src/core/import.ts`

**修改**:
- `src/api/api.ts`:删除 `importToProject` 实现体(120+ 行),改为 1 行委托

### V2.5 迁移步骤

1. **Step V2.1 — 建 `importToCore`**(独立 commit)
   - 创建 `src/core/import.ts`,迁入 `api.ts` 中 `importToProject` 的全部逻辑
   - `api.ts` 改为委托
   - 行为完全不变(包括 `console.log` 步骤标记、错误处理、`moved` 数组填充)
   - `tsc --noEmit` 通过
   - commit: `refactor(core): extract importToProject from api.ts into core/import`

### V2.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `src/core/import.ts` 行数 | ~130(原 120 行+ 文件头/imports) |
| `src/api/api.ts` 行数 | ≤ 290(从 403 减) |
| `api.ts.importToProject` 实现体行数 | ≤ 5 行(委托) |
| `UxptoWebviewAPI.importToProject` 签名 | 不变 |
| 行为(包括 `moved` 数组 / 落盘校验失败时的错误信息) | 与 v1 一致 |
| TypeScript 编译 | 0 error |

### V2.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 内部 `import` 与命名冲突(import 关键字 / npm 包名) | 低 | 低 | 文件名 `import.ts` 与 TypeScript import 关键字无冲突(运行时是模块路径) |
| 行为微差(console.log 步骤标记 / 错误文案) | 中 | 中 | 迁移时按原样搬运,不改字符串;行为等价由 E2E 验证 |
| 回滚成本 | 极低 | — | 单 commit,可直接 revert |

---

## V3. `billing.ts` 价格表独立

### V3.1 目标

将 `webhook.ts` 中内联的价格表常量与 `estimateCost` 函数抽到 `src/core/billing.ts`,让 webhook 只做 HTTP 限流重试,价格调整只改一处。

### V3.2 当前结构

`src/core/webhook.ts`:
- L24–28: `PRICE_BY_RESOLUTION` 常量(`"2K": 0.8` / `"768P": 0.5` / `"480P": 0.33`)
- L31: `UPGRADE_UNIT_PRICE = 0.3`
- L37–40: `TOKEN_PRICE_PER_MILLION` 常量
- L67: `COST_PRECISION = 3`
- L69–94: `estimateCost` 函数(基于 GenerationRecord + ReportPurpose 算金额)
- L211–252: `reportGenerated` / `testReport` 调 `estimateCost`

### V3.3 拆分方案

新建 `src/core/billing.ts`:

```ts
// 价格表常量
export const PRICE_BY_RESOLUTION: Record<string, number> = { ... };
export const UPGRADE_UNIT_PRICE = 0.3;
export const TOKEN_PRICE_PER_MILLION = { ... };
const COST_PRECISION = 3;

// 价格计算(纯函数)
export function estimateCost(record: GenerationRecord, purpose: ReportPurpose): number { ... }
```

`webhook.ts` 改为:

```ts
import { estimateCost } from "./billing";
// 内部 estimateCost re-export 给删除层保持 facade
```

### V3.4 文件改动清单

**新增**:
- `src/core/billing.ts`

**修改**:
- `src/core/webhook.ts`:删除 L24–28 / L31 / L37–40 / L67 / L69–94;改为 `import { estimateCost } from "./billing"`;`webhookCore` 上仍可选择 re-export `estimateCost` 作为兼容(若外部有引用)。

### V3.5 迁移步骤

1. **Step V3.1 — 抽 `billing.ts`**(独立 commit)
   - 创建 `src/core/billing.ts`,迁入 4 个价格表常量 + `estimateCost` 函数
   - `webhook.ts` 改为 `import { estimateCost } from "./billing"`;删除本地的价格表常量与函数
   - 行为完全不变
   - `tsc --noEmit` 通过
   - commit: `refactor(core): extract price table and estimateCost from webhook.ts into billing.ts`

### V3.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `src/core/billing.ts` 行数 | ~50 |
| `webhook.ts` 行数 | ≤ 220(从 253 减) |
| `webhook.ts` 内 `PRICE_BY_RESOLUTION` / `UPGRADE_UNIT_PRICE` / `TOKEN_PRICE_PER_MILLION` / `COST_PRECISION` / `estimateCost` 出现次数 | 0(全部迁移到 billing.ts) |
| 外部 (`webhookCore.estimateCost` / `webhookCore.reportGenerated` 引用) | 不变 |
| TypeScript 编译 | 0 error |
| 飞书上报金额(`reportGenerated` 调 `estimateCost` 的输出) | 与 v1 一致 |

### V3.7 风险与与与风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `estimateCost` 内部依赖 `REPORT_PURPOSE` 常量(从 `@shared/messages` 导入) | 低 | 低 | billing.ts 同样从 `@shared/messages` 导入 REPORT_PURPOSE,无影响 |
| 外部通过 `webhookCore.estimateCost` 引用(grep) | 中 | 低 | 在 `webhook.ts` 顶部 `export { estimateCost } from "./billing"`,保持 facade |
| 价格调整漏改(billing.ts 改但 webhook.ts 仍有副本) | 极低 | — | 迁移后 webhook.ts 不再有价格表常量,只引一份 |
| 回滚成本 | 极低 | — | 单 commit |

---

## V4. 错误模型统一 `{ok,error}` vs `throw`

### V4.1 目标

让 webview 业务层(`useSubmit` / `useImport` / `useFeishuReport`)不再 `throw`,统一返回 `{ok, error}` 结果对象,与 UXP 桥层风格对齐。桥层保持不变(Comlink 跨端 throw 会污染调用栈)。

### V4.2 当前结构

| 层级 | 错误流 | 代码位置 |
| --- | --- | --- |
| UXP 桥层 (`src/core/*` → `bridge.*`) | 返回 `{ok, error}` | `src/api/api.ts` 全部方法 |
| WebView 业务层 (`useSubmit` 等内部 `try/catch`) | catch 后写 record.error | `useSubmit.ts:410,212,316` 等 |
| Provider 实现 (`MiniMaxProvider`) | `throw new VideoGenError` | `MiniMaxProvider.ts` 11 处 |

### V4.3 拆分方案

业务层 `useSubmit` / `useImport` / `useFeishuReport` 内部:

- 当前:`await new MiniMaxProvider(...).createVideo(...)` → 可能 throw → catch 后 `toRecordError(e)` 写 record.error
- 改造:用 `{ok, error}` 风格的包装,在 `useSubmit` 内统一把 provider.throw 翻译为业务层 `{ok, error}`

设计:
```ts
// 业务层新增工具:把 throw 转 {ok, error}
async function safeProviderCall<T>(fn: () => Promise<T>): Promise<{ok: true; data: T} | {ok: false; error: ErrorPayload}> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: toRecordError(e) };
  }
}
```

`useSubmit.submitGenerate` 内 `await mini.createVideo(...)` 改为 `safeProviderCall(() => mini.createVideo(...))`,根据 ok 判断分支。

### V4.4 文件改动清单

**修改**:
- `webview-ui/src/composables/useSubmit.ts`:
    - L410–419 (submitGenerate catch):改为 `safeProviderCall` 后跟 `if (!r.ok)`
    - L511–520 (upgradeTo2K catch):同上
    - L722–726 (optimizePrompt catch):同上
  - 业务层 try/catch 仍在(因 record.success 字段需在错误时回填),但 catch 体只是回填,不再依赖 throw 传播

- `webview-ui/src/composables/useImport.ts`:
  - 当前已有 try/catch 包装(行为已对齐 `{ok}` 风格),保持不动

- `webview-ui/src/composables/useFeishuReport.ts`:
  - 当前是 fire-and-forget,内部 try/catch 已对齐,保持不动

**不修改**:
- UXP 桥层 (`src/api/api.ts` / `src/core/*`) — 跨 Comlink 边界必须 `{ok}`
- Provider 类 (`MiniMaxProvider`) — `throw` 是单端同语言(JS)错误流的自然选择

### V4.5 迁移步骤

1. **Step V4.1 — `useSubmit` 错误流统一**(独立 commit)
   - 创建 `webview-ui/src/composables/useProviderSafe.ts`(辅助函数)
   - `useSubmit.submitGenerate` / `upgradeTo2K` / `optimizePrompt` 改用 `safeProviderCall`
   - 行为完全不变(失败时 record.status = "failed", error 字段填好)
   - `tsc --noEmit` 通过
   - commit: `refactor(webview): unify useSubmit error model to {ok, error} via safeProviderCall`

### V4.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `useSubmit.ts` 中 `try { ... } catch (e)` 包裹 provider 调用的次数 | ≤ 0(全用 safeProviderCall) |
| `useSubmit` 提交失败时 record.status / record.error 表现 | 与 v1 一致 |
| Provider `throw new VideoGenError` 次数 | 不变(provider 层不归本计划) |
| UXP 桥层 `{ok, error}` 风格 | 不变 |
| TypeScript 编译 | 0 error |
| 失败 toast 内容 | 与 v1 一致 |

### V4.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `safeProviderCall` 的 ErrorPayload 字段格式与 record.error 字段不一致 | 中 | 中 | 设计 `ErrorPayload = GenerationRecord["error"]`,直接 spread 进 record.error |
| 异步任务的 onTerminal 回调(由 useInflight 持有)仍依赖 throw 语义 | 低 | 中 | onTerminal 由 useInflight 内部实现,本计划不触及 |
| 回滚成本 | 低 | — | 单 commit |

---

## V5. Vue provide/inject 重构顶层 ref 透传

### V5.1 目标

减少 `main-webview.vue` 顶层 ref 数量(12+)在多个 composable 间反复透传(`useGenerationState` / `useRecordEdit` / `useSubmit` 等)的噪音,引入 Vue 3 原生 `provide/inject` 共享高频 ref(`apiKey` / `projectInfo` / `records` / `prompt` / `model` / `ratio` / `duration` / `resolution` / `references` / `selectedRecordId`)。

不引入 Pinia(已在 v1 §0.3 原则 4 中明确)。低频 ref(如 `settingsOpen` / `refreshing` / `storageMode` / `currentProviderId` / `currentProvider`)保持局部。

### V5.2 当前结构

`main-webview.vue` 顶层 ref 列表:

| ref | 接收者 |
| --- | --- |
| `apiKey` | useGenerationState / useRecordEdit / useSubmit / useFeishuReport(通过 showToast) |
| `projectInfo` | useGenerationState / useSubmit / useGenerationTasks |
| `records` | useGenerationState / useRecordEdit / useSubmit / useImport |
| `storageMode` | useGenerationState |
| `prompt` | useGenerationState / useRecordEdit / useSubmit |
| `model` | useGenerationState / useRecordEdit / useSubmit |
| `ratio` | useGenerationState / useRecordEdit / useSubmit / useReferences |
| `duration` | useGenerationState / useRecordEdit / useSubmit / useReferences |
| `resolution` | useGenerationState / useRecordEdit / useSubmit |
| `references` | useGenerationState / useRecordEdit / useSubmit / useReferences |
| `settingsOpen` | useGenerationState |
| `selectedRecordId` | useRecordEdit / useSubmit |
| `currentProviderId` | useSubmit |
| `currentProvider` | main-webview(本地) |
| `providerModels` | main-webview(本地) |
| `toastMsg` | main-webview(本地) |
| `refreshing` | main-webview(本地) |

### V5.3 拆分方案

新建 `webview-ui/src/providers/state.ts`,定义 `SharedRefs` 类型与 injection key:

```ts
import type { InjectionKey, Ref } from "vue";
import type { GenerationRecord, ... } from "@shared/messages";

export interface SharedRefs {
  apiKey: Ref<string | null>;
  projectInfo: Ref<{ path: string; guid: string; name: string } | null>;
  records: Ref<GenerationRecord[]>;
  prompt: Ref<string>;
  model: Ref<any>;
  ratio: Ref<any>;
  duration: Ref<number>;
  resolution: Ref<any>;
  references: Ref<ReferenceItem[]>;
  selectedRecordId: Ref<string | null>;
}

export const SharedRefsKey: InjectionKey<SharedRefs> = Symbol("rocx-shared-refs");
```

`main-webview.vue`:

```ts
import { provide } from "vue";
import { SharedRefsKey } from "./providers/state";

provide(SharedRefsKey, {
  apiKey, projectInfo, records, prompt, model,
  ratio, duration, resolution, references, selectedRecordId,
});
```

各 composable:

```ts
import { inject } from "vue";
import { SharedRefsKey } from "../providers/state";

export function useSubmit(opts: { showToast: ...; findModelDescriptor: ...; ... }) {
  const shared = inject(SharedRefsKey);
  if (!shared) throw new Error("useSubmit requires SharedRefs provider");
  // 用 shared.apiKey.value 替代 opts.apiKey.value
}
```

### V5.4 文件改动清单

**新增**:
- `webview-ui/src/providers/state.ts`

**修改**:
- `webview-ui/src/main-webview.vue`:顶层 `provide(SharedRefsKey, {...})`;删除向各 composable 的 ref 透传
- `webview-ui/src/composables/useGenerationState.ts`:删除 `apiKey/projectInfo/records/storageMode/prompt/model/ratio/duration/resolution/references/settingsOpen` 入参;改为 `inject(SharedRefsKey)`;`resumePolling` / `getInflightRecords` 保持入参(由 useInflight 提供)
- `webview-ui/src/composables/useRecordEdit.ts`:删除 `apiKey/records/prompt/model/ratio/duration/resolution/references/selectedRecordId` 入参;改为 inject
- `webview-ui/src/composables/useSubmit.ts`:删除 `apiKey/records/prompt/model/ratio/duration/resolution/references/projectInfo/selectedRecordId` 入参;改为 inject
- `webview-ui/src/composables/useImport.ts`:删除 `records` 入参;改为 inject
- `webview-ui/src/composables/useReferences.ts`:删除 `references/constraints/duration/ratio/currentProviderId` 入参;改为 inject(`constraints` 仍可作为入参,因为它来自 useGenerationState 的派生 computed)

### V5.5 迁移步骤

1. **Step V5.1 — 建 `state.ts`**(独立 commit)
   - 创建 `webview-ui/src/providers/state.ts`,定义 `SharedRefs` 接口与 `SharedRefsKey`
   - 编译通过(尚无消费者)
   - commit: `feat(webview): introduce SharedRefs provide/inject key`

2. **Step V5.2 — `main-webview.vue` 提供共享 refs**(独立 commit)
   - 顶层添加 `provide(SharedRefsKey, { apiKey, projectInfo, records, ... })`
   - 尚未删除 ref 入参(双轨;composable 尚未消费 inject)
   - commit: `chore(webview): provide SharedRefs in main-webview`

3. **Step V5.3 — 迁移 `useImport`**(独立 commit)
   - 删除 `records` 入参;改为 `inject(SharedRefsKey)`
   - commit: `refactor(webview): useImport migrate to inject SharedRefs`

4. **Step V5.4 — 迁移 `useRecordEdit`**(独立 commit)
   - 删除 9 个 ref 入参;改为 inject
   - commit: `refactor(webview): useRecordEdit migrate to inject SharedRefs`

5. **Step V5.5 — 迁移 `useSubmit`**(独立 commit)
   - 删除 10 个 ref 入参;改为 inject
   - 注意 `optimizingPrompt` 是 useSubmit 内部创建的 ref,不是来自 SharedRefs;保持入参或挪到 SharedRefs
   - commit: `refactor(webview): useSubmit migrate to inject SharedRefs`

6. **Step V5.6 — 迁移 `useGenerationState`**(独立 commit)
   - 删除 11 个 ref 入参;改为 inject
   - 行为完全不变(包括 derivedCount / constraints / loadRecords 等)
   - commit: `refactor(webview): useGenerationState migrate to inject SharedRefs`

7. **Step V5.7 — `main-webview.vue` 清理入参**(独立 commit)
   - 删除所有已迁移的 ref 入参透传
   - commit: `chore(webview): clean up SharedRefs-migrated props in main-webview`

### V5.6 验收标准

| 检查项 | 期望 |
| --- | --- |
| `main-webview.vue` 顶层 `provide(SharedRefsKey, ...)` | 1 处 |
| `useSubmit` 等 composable `inject(SharedRefsKey)` | 4 处(useImport, useRecordEdit, useSubmit, useGenerationState) |
| `main-webview.vue` 透传给 composable 的 ref 数量 | 0 |
| `main-webview.vue` 顶层 ref 总数 | ≤ 8(本地 `settingsOpen`、`currentProvider`、`providerModels`、`refreshing`、`toastMsg`、`storageMode`、`currentProviderId` 等保留) |
| Composable 公开 API | 不变(返回对象结构同 v1) |
| TypeScript 编译 | 0 error |

### V5.7 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| `inject(SharedRefsKey)` 在单元测试 / Storybook 里失败(无 provider) | 中 | 中 | 各 composable 内部 `if (!shared) throw new Error(...)` 早期失败;或保留 fallback 默认值 |
| composable 多消费者共享同一 `inflight` 实例,改一处影响多处 | 中 | 高 | SharedRefs 注入的是顶层 `useState` ref,与组件状态共享相同引用;不破坏 Vue 反应式系统;测试覆盖率要求 100% |
| V5.5 阶段 `useSubmit` `optimizingPrompt` 处理不当 | 低 | 中 | `optimizingPrompt` 是 useSubmit 内部状态,不进 SharedRefs;若有别的 composable 需要,挪到 useInflight 同层 |
| 回滚成本 | 中 | — | 每 Step 独立 commit;V5.7 是 cleanup,即使回滚到 V5.2 也只是双轨(provide 已存在但 composable 仍用 props),无功能影响 |

---

## 1. 实施计划与依赖

### 1.1 推荐执行顺序

```
V1 (删除 alias + shim)
  └─ V3 (billing.ts 独立) — 独立
  └─ V2 (importToProject 下沉) — 独立
  └─ V4 (错误模型统一) — 独立
       └─ V5 (provide/inject) — 依赖 V4 错误模型稳定
```

理由:V1 是"减法"清理,与其他项无交集;V2/V3 是 UX 端的细化抽离,可与 V1 并行;V4 是 webview 业务层调整,需要在 V1 完成(避免 provider 与 shim 同时改名)之后;V5 依赖 V4 后的稳定接口。

### 1.2 提交粒度

每 Step 一个 commit,commit message 前缀:

| 前缀 | 含义 |
| --- | --- |
| `chore(messages): remove MiniMax* deprecated alias` | V1.1 |
| `chore(webview): drop services/MiniMax compatibility wrapper` | V1.2 |
| `chore(webview): remove services/MiniMax.ts shim file` | V1.3 |
| `refactor(core): extract importToProject from api.ts into core/import` | V2.1 |
| `refactor(core): extract price table and estimateCost from webhook.ts into billing.ts` | V3.1 |
| `refactor(webview): unify useSubmit error model to {ok, error} via safeProviderCall` | V4.1 |
| `feat(webview): introduce SharedRefs provide/inject key` | V5.1 |
| `chore(webview): provide SharedRefs in main-webview` | V5.2 |
| `refactor(webview): useImport migrate to inject SharedRefs` | V5.3 |
| `refactor(webview): useRecordEdit migrate to inject SharedRefs` | V5.4 |
| `refactor(webview): useSubmit migrate to inject SharedRefs` | V5.5 |
| `refactor(webview): useGenerationState migrate to inject SharedRefs` | V5.6 |
| `chore(webview): clean up SharedRefs-migrated props in main-webview` | V5.7 |

### 1.3 测试与验收节奏

每个 Step 必须跑通:

```bash
yarn tsc --noEmit      # 两侧均通过
yarn lint              # 若项目配置
```

每个 V 项完成时跑(沿用 v1 §2.3 的 E2E 列表):

| 测试类别 | 用例 |
| --- | --- |
| TypeScript 编译 | `tsc --noEmit` 双端 |
| 构建产物 | `yarn build` 产出正常 |
| 抓帧 E2E | 抓帧 + 上传 + 显示 thumbDataUrl |
| 抓视频 E2E | 抓视频 + 上传 + 显示 |
| 文件 IO E2E | 移动到 Imports/ + 导入工程 + 插入时间线 |
| 提交生成 E2E | submitGenerate → 轮询 → 下载 → 状态机正确 |
| 升级到 2K E2E | upgradeTo2K → 轮询 → 升级记录 |
| 优化提示词 E2E | optimizePrompt → 填回 prompt 输入框 |
| 重试 E2E | retryRecord → 表单回填 + reference 重新上传 |
| 飞书上报 E2E | 配置 webhook + 生成成功 → 上报金额与 v1 一致(关键: V3 验证金额未漂移) |

### 1.4 工期估算

| V 项 | 工作量 | 备注 |
| --- | --- | --- |
| V1 | 0.5–1 天 | 3 个 step commit,纯替换 |
| V2 | 0.5 天 | 1 个 step commit,机械搬迁 |
| V3 | 0.5 天 | 1 个 step commit,纯搬运 |
| V4 | 0.5–1 天 | 1 个 step commit,需重新过 try/catch 边界 |
| V5 | 1.5–2 天 | 7 个 step commit,涉及 ref 所有权改造 |
| **合计** | **3.5–5.5 天** | |

### 1.5 退出标准(DoD)

整个 v2 计划完成的标志:

- [x] `shared/messages.ts` 不再有 `MiniMax*` deprecated alias
- [x] `webview-ui/src/services/MiniMax.ts` 不存在
- [x] `webview-ui/src` 下无 `MiniMaxError` / `MiniMaxAPI` 引用
- [x] `src/api/api.ts` 不再有 `importToProject` 实现,委托 `core/import.ts`
- [x] `webhook.ts` 内不再有价格表常量;`src/core/billing.ts` 提供 `estimateCost`
- [x] 业务层(`useSubmit`)不再 throw,返回 `{ok, error}`;桥层保持不变
- [x] `main-webview.vue` 透传给 composable 的 ref 数量为 0
- [x] `tsc --noEmit` 双端 0 error
- [x] E2E 列表(沿用 v1 §2.3)全部手测通过;V3 专项验证:飞书上报金额与 v1 一致

---

## 2. 参考

- 本计划基于 [refactor-plan.md v1](./refactor-plan.md) §0.3 "不在本期范围"清单
- v1 已落地的 4 项重构记录:`git log` 1e1ce84 / 8099e8f / 1645a79 / 74a21e8
- v1 中提到的 `importToProject` 业务编排详见 [`src/api/api.ts` L190–310](https://github.com/vark-debug/RocX/blob/feat/capture-frame-and-open-ps/src/api/api.ts#L190)
- 价格表与 estimateCost 在 `webhook.ts` L24–94
- 错误模型当前:`webview-ui/src/providers/minimax/MiniMaxProvider.ts` 11 处 `throw new VideoGenError`
- 顶层 ref 透传当前:`webview-ui/src/main-webview.vue` 12+ 个 ref 在多个 composable 间反复透传