# RocX Changelog

## v0.3.0 (2026-09-28)

首个**团队功能**版本。生成成功后自动把"谁在什么工程、用什么素材、生成了哪条视频、花了多少估价"上报到飞书多维表格，让团队可以在表格里做统计、结算与按工程追溯。

### 新增

- **飞书多维表格联动**（设置面板新增 Webhook 地址 / Token / 剪辑师三项）
  - 在记录首次变为 `generated` 的瞬间 fire-and-forget 上报，失败仅 toast 提示，不影响生成结果
  - 上报字段：`recordId` / `estimateCost` / `editorName` / `projectName` / `purpose`
  - 上报请求从 UXP 端发出，token 留在 secureStorage，不跨桥暴露给 webview
- **多用途分类（`purpose` 字段）**：`视频生成` / `分辨率升级` / `提示词优化`，可在飞书侧按列做透视与汇总
- **估价三档**（统一保留三位小数）
  - 视频生成：`(参考视频时长 + 输出视频时长) × 档位单价`（2K=0.8 / 768P=0.5 / 480P=0.33 元/秒）
  - 分辨率升级：`(参考视频时长 + 输出视频时长) × 0.3`
  - 提示词优化：`prompt_tokens × 5.80 + completion_tokens × 23.00` 元 / 百万 tokens
- **飞书限流自动重试**：命中错误码 `800005652` 或 HTTP 429 时按 400 / 800 / 1600ms 指数退避重试，最多 3 次，每次带 ±50% 抖动。鉴权、参数、网络异常不重试
- **设置页「测试上报」按钮**：用固定样例发一次 webhook，验证地址 / 令牌 / 表格字段映射；复用同一重试逻辑，避免测试路径与生产路径行为不一致
- **`uxp.config.ts` 网络白名单**：`https://*.feishu.cn`（租户级子域名，必须通配）+ `https://connector.dingtalk.com`（测试用）

### 修复

- `storage.readSettings()` 此前在 `secureStorage` 命中时直接 `return { apiKey }`，会把兜底文件里的非密钥字段（`dryRun` 及本次新增的飞书三项）全部丢弃。改为"兜底文件为底 + secureStorage 覆盖密钥"，且保留旧明文 apiKey 自动迁移

### 兼容性

- 仍向下兼容 Premiere Pro 25.6.4（UXP 8.1），25.6 / 26.x 全系可运行
- 新增 manifest 网络白名单项**必须重新加载插件**才生效（manifest 改动不热更新）

### 安装与验证

- 飞书自动化 webhook 强烈建议开启凭证校验，否则单流程频率上限仅 1 次/秒（开启后 5 次/秒）
- 单 URL 方案可支撑约 100~200 人团队稳态运行，详见 `.trae/specs/add-feishu-bitable-webhook/spec.md` 的容量评估

## v0.2.0 (2026-09-27)

首个 **Windows + macOS 双平台全量验证**版本。向下兼容到 **Premiere Pro 25.6.4**，已在 Win / Mac 双平台完成全流程验证。

### 跨平台兼容

- **Windows 兼容修复**
  - `file://` 三斜杠路径统一处理
  - 剥离 `\\?\` 长路径前缀，避免 UXP 文件 API 在 Win 下拒绝访问
  - 抓帧写盘改为轮询确认，规避 Win 下写入延迟导致的"文件未就绪"误报
  - Adobe Media Encoder（AME）缺失 / 启动失败时给出明确错误提示（Win 下仅装 Premiere 不一定带 AME）
- 兼容性下限确认到 **Premiere Pro 25.6.4**（UXP 8.1），25.6 / 26.x 全系可运行

### 功能

- 提交生成后自动清空参考素材列表（一次提交 = 一次完整输入清空，避免上一轮参考图 / 参考视频误带入下一轮生成；磁盘原始文件保留）
- 抓视频时按素材实际宽高比自动匹配并填写画面比例（provider 中性，按当前模型合法 ratio 列表取最接近值）

### 架构改进

- **provider 模块化抽象层**：抽出 `VideoGenProvider` / `ModelDescriptor` / registry，UI 改为按 `capabilities` 能力位驱动（`videoGeneration` / `promptOptimization` / `resolutionUpscale` 等），不再硬编码 MiniMax 模型名
- **webview-ui composable 拆分**：`main-webview.vue` 拆出 `useGenerationState` / `useReferences` / `useGenerationTasks`，参考素材、轮询、记录等关注点分离
- 移除大视频预览首帧遮罩（`mainFrameBlob` 与 canvas 抽帧遮罩 全部删除），预览逻辑简化
- 跨端类型收口 `shared/messages.ts`，新增 `ReferenceItem.consumed` 状态字段

## v0.1.1 (2026-09-25)

向下兼容到 **25.6.0**（官方 UXP for Premiere 正式首发版本；UXP 8.1）。

### 兼容性

- `manifest.host.minVersion` 由 `26.5.0` 调为 `25.6.0`
- 时间线插入的 `lockedAccess` / `executeTransaction` 回调去掉 `async/await`（Adobe 官方 ESLint 规则 `no-async-in-lock-scope` 建议锁定回调内同步执行；外层 `await project.lockedAccess` 保留）
- README 同步说明 25.6 → 26.5 全系 UXP 8.x 可运行
- 仍使用 `@adobe/premierepro@26.5.0` 作为构建时类型参考（Adobe 官方 npm 类型包最低 26.2.0，未发布 25.6.0 类型包）

### 已审计确认

- 未引用任何 26.5 独有 API（`C2PAService` / `MediaManager` / `WorkAreaUtils` / `Media.getStart` / `Media.getDuration` / `host.applicationPath` / `host.getBackgroundColor` 等均未使用）
- `Sequence.setSelection` 同步化（26.3 引入）不影响本项目（本项目未调用 `setSelection`）
- 项目切换监听已有 `eventManager.on` → `Project.onActiveProjectChange` → `setInterval` 三级兜底；25.6 上前两者为 undefined，自动落到 2s 轮询

### 未做

- ESLint / `eslint-plugin-premierepro` 未接入（与兼容性目标无关，会引入 eslint v9 + typescript-eslint v8 共 50+ 间接依赖，超出本次范围）。建议后续单独 PR 处理

## v0.1.0 (2026-09-25)

首个公开版本。在 Adobe Premiere Pro 26.5+ 面板内调用 MiniMax（海螺 AI）视频生成模型。

### 功能

- 抓帧 / 抓视频参考：从节目监视器 / 工作区一键导出，作为生成参考素材
- 提示词生成：支持 H3 标准 / H3-Max 极速，多档时长 / 分辨率 / 画面比例
- 上传参考素材到 MiniMax（图片 / 视频 / 音频）
- 异步轮询任务状态，下载生成结果到 PR 项目旁 `AI_Generated_Media/Imports/`
- 一键导入到 PR Project 面板，或通过拖拽 / 按钮插入时间线（含事务化的 lockedAccess + executeTransaction）
- 提示词优化（h3_context_ir，仅 H3 模型）
- 像素提升：H3 768P 视频调用 video_regeneration 升级到 2K
- 历史记录持久化到 PR 项目旁的 `<项目名>.ai-gen.json`

### 架构改进

- 跨端类型收口到 `shared/messages.ts`（消除 UXP / WebView 字段漂移）
- Premiere DOM API 异步调用规范化（`lockedAccess` / `executeTransaction` 改 await）
- 文件移动语义统一为 `copyTo + 校验 + delete`，删除反复兜底
- 项目切换监听可清理（移除 IIFE 自启动 + 不可清理的 setInterval）
- API Key 切换到 UXP `secureStorage` 优先 + 兜底文件
- RecordsPanel 拆分 composable，组件从 ~1250 行精简到 217 行，样式外迁
- `UxptoWebviewAPI` / `WebviewToUxPAPI` 接口方向命名修正
- DEV 模式调试工具按构建时常量隐藏，非 dev 包不含调试入口

### 兼容性

- 仅在 macOS + Premiere Pro 26.5.0+ 验证
- 仅支持 MiniMax 官方开放平台签发的 API Key

### 已知限制

- 不支持并发生成（原型阶段）
- Windows 未验证
