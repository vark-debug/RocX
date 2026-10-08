# RocX Changelog

> **追溯说明（2026-09-28）**：v0.3.0 走的是**本地 `no-ff` merge**（commit `6a26fb5`），未走 GitHub PR。本次起，建议下次发布改走 PR merge → tag → release 的流程，确保每个发布在 GitHub 上有对应的 PR 编号追溯。

## v0.4.0 (2026-10-08)

首个**多平台 + 图片生成**版本。面板从「MiniMax 单平台视频生成」扩展为视频 / 图片双模式、三平台独立 Key，并新增抓帧→Photoshop 工作流与 C++ 混合插件；同时系统性修复了多工程并行下的记录丢失问题。

### 新增

- **图片生成模式**（面板顶部 `🎬 视频生成` / `🖼 图片生成` 切换，两模式共用参考素材区与记录列表）
  - **RunningHub** `seedream-v5-pro`：文生图 / 图生图，异步提交 + 轮询
  - **火山方舟** `doubao-seedream-5-0-pro-260628`：**同步 API**（一次请求直接返回，实测 55~80s），面板跳过 `pending` 直接显示「生成中」
  - 智能路由：有参考图走图生图，无参考图走文生图（provider 内部判定，UI 无需切换）
  - 参考图一律 **Base64 data URI 直传**（RunningHub 对外链 / 纯文件名引用报 1007 无法识别）
  - 图片结果 URL 仅 24h 有效，故**尽快落盘**；落盘失败仍可预览与导入
- **图片尺寸「智能」档**：跟随**当前活动序列的分辨率**（提交瞬间实时读取 + 按平台像素上限等比钳制）；另有 1K / 2K 预设档
- **火山方舟透明底**：提示词命中 `透明背景` / `透明底` / `无背景` / `去背景` / `transparent` / `alpha` 等关键词时，自动补一张全透明画布作为输入并要求输出透明 PNG（**纯文生图无法产出 alpha 通道**）
- **抓帧 → Photoshop**（面板 `🎨 抓帧→PS` 按钮，2 秒防抖锁）
  - 抓帧后自动在 PS 打开，改完点面板「**修改完成**」才真正上传为参考素材；未确认前显示「✏ PS 中」，生成时跳过并提示
  - 三级回退：C++ Hybrid addon → launcher 脚本（`.cmd` / `.command`）→ 系统文件关联
- **C++ 混合插件 `RocXBridge.uxpaddon`**（`native/RocXBridge/`）
  - 纯 UXP 的 `shell.openPath` 只能走系统关联，`.jpg` 常被「预览 / WPS / Photos」接管；addon 经 `NSWorkspace` 按 bundle id 精确命中 Photoshop
  - CMake POST_BUILD 输出到 `public-hybrid/{mac,win}/<arch>/`
- **API Key 三平台独立配置**：设置页按平台分槽填写，存 UXP `secureStorage`（macOS 钥匙串）；不可用时降级混淆写文件（**非真加密**）
- **记录区改信息流布局**（`RecordFeedBlock`）：每条记录 = meta 行 + 强制 16:9 预览（竖屏 letterbox）+ 操作行；`<video>` 惰性挂载（`IntersectionObserver`），播放互斥
- **图片模型智能默认**：仅配置了单个图片平台 Key 时自动选中该平台首个模型
- **抓帧智能填写画面比例**：与抓视频同机制，按素材实际宽高比匹配模型合法 ratio
- **开发与构建**：`npm run dev / build / ccx` 均先编译 C++ addon；新增 `docs/cpp-hybrid-build.md`

### 修复

- **记录落盘防丢防回退**（多工程并行场景的系统性修复）
  - 写盘前读盘做并集合并：内存以内存为准，仅盘上独有才保留 —— 修「切工程时其它工程已完成记录被全量覆盖抹掉」
  - 终态记录 `persistNow` 直通落盘，抢在 200ms 防抖窗口前写盘
  - 删除墓碑 `deletedRecordIds`：合并 / 补插时排除已删记录，防删除后被复活
  - `syncToRecords` 记录缺失时补插回 records，防在飞任务完成后凭空蒸发
  - `doPersist` 重入保护 + `switching` 冻结窗口内延后重试（不再静默吞写入）
- **归属错位**：素材归属改为**抓取瞬间**从真实工程对象读出并随抓取结果返回（`CaptureOwner`），废除原「素材父级目录 → 实时活动工程 → 缓存」三层信任层级导致的「读 A 写 B」
- **记录归属收养**：磁盘读出的记录重打为当前工程 guid/path —— 项目目录拷贝 / 另存后打开即见全部记录（guid 不能作跨位置锚点）
- **轮询互相掐断**：单 timer + `currentKey` 改为 `Map<taskId, PollerState>`，每任务独立定时器 / 失败计数 / 退避间隔；并在记录面板补跨工程角标与「完成后切回该工程查看」提示
- **提示词优化**：`optimizePrompt` 不再进 records，落盘路径与生成完全对齐（此前会与生成抢归属）
- **主记录 JSON 文件名统一**：去掉 `cur.name` 分支，消除 `B.prproj.ai-gen.json` 与 `B.ai-gen.json` 双写
- **⚠ 降级存储角标**：改为实时反映主路径可写性，而非写入时才变
- **连续抓帧取到残留文件**：导出前快照已有 `capture-*` 文件名，轮询时排除（`excludeNames`）
- **macOS 抓帧→PS 三处阻塞**：`launcher.command` 执行位（改 100755 + 拷贝后显式 `chmod 755`，不依赖源文件权限位）、PluginData 路径中间有 `Adobe/` 一层导致 glob 落空（改 `find` 递归搜 UXP 根目录）、打开 PS 残留终端窗口（改派 `nohup` 后台轮询待 `$$` 退出后再关窗）
- **SharedRefs HMR 失配**：`SharedRefsKey` 改用 `Symbol.for()`，规避 Vite HMR 下 Symbol 重新求值导致 `inject` 拿到 undefined
- **watch 回归**：`persistRecords` 改为 watch `shared.records`（V5.6 回归）
- **TDZ**：`main-webview` composable 初始化顺序调整
- **`purpose` 传参错误**：不再把 `VideoGenQueryResponse` 当作 `purpose` 传入终态回调

### 重构

- **`src/core/files.ts` 拆为 5 个单一职责模块**：`fileIO` / `workDir` / `pathUtils` / `previewUrl` / `psLauncher`
- **`importToProject` 从 `api.ts` 抽到 `core/import.ts`**，价格表与 `estimateCost` 从 `webhook.ts` 抽到 `core/billing.ts`
- **provider 抽象层拆分**：UXP 端 `UxPProvider`（只做 upload / downloadToWorkDir）与 webview 端 `VideoGenProvider` / `ImageGenProvider`（只做 API 请求）职责分离；视频 / 图片各一张独立注册表
- **webview composable 拆分**：`useGenerationTasks` 拆为 5 个 composable；`SharedRefs` provide/inject 取代逐层透传 props（V5.1~V5.7）
- `useSubmit` 错误模型统一为 `safeProviderCall`；`captureBase` 抽出抓取公共逻辑
- 清理：`MiniMaxAPI` shim、`services/MiniMax.ts` shim、`shared/messages.ts` 中 `MiniMax*` 旧名 alias

### 兼容性

- `host.minVersion` 保持 **25.6.0**；C++ Hybrid addon 声明保留（`enableAddon: true` + `addon.name`）
- ⚠️ **C++ addon 实际仅 PR ≥ 26.2 可用**，老版本 PR（22.x / 25.x）加载报 "Addon is not supported"。这正是 launcher 脚本兜底路径存在的原因：addon 不可用时自动降级，**不影响 25.6 用户使用抓帧→PS**
- **新增 manifest 网络白名单项必须重新加载插件才生效**（manifest 不热更新）
  - `https://www.runninghub.cn`、`https://*.myqcloud.com`（RunningHub 结果 COS）
  - `https://*.volces.com`（火山方舟 API + 结果 CDN）
- 向下兼容 Premiere Pro 25.6.4（UXP 8.1），25.6 / 26.x 全系可运行

### 已知限制

- **时间线插入未在 UI 暴露**：`timelineCore.importAndInsert` 后端已实现并完成桥接，但 webview 侧无调用方。当前上时间线需用记录卡片拖拽；「导入到工程」只导入 Project 面板
- 仍**不支持并发生成**（原型阶段）
- 图片 `output_format` 硬编码 `png`，UI 暂不可选 jpeg
- 火山方舟为同步 API，单次请求挂起 55~80s 期间不可取消

### 未做

- ESLint / `eslint-plugin-premierepro` 仍未接入（自 v0.1.1 顺延；会引入 eslint v9 + typescript-eslint v8 共 50+ 间接依赖，需单独 PR 处理）
- 未在 macOS / Windows 双平台对图片生成与抓帧→PS 做全量验证（v0.4.0 功能主要在 macOS 开发机验证）

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
