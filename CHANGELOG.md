# RocX Changelog

> **追溯说明（2026-09-28）**：v0.3.0 走的是**本地 `no-ff` merge**（commit `6a26fb5`），未走 GitHub PR。本次起，建议下次发布改走 PR merge → tag → release 的流程，确保每个发布在 GitHub 上有对应的 PR 编号追溯。
>
> **追溯补录（2026-10-25）**：v0.4.0 发布时未同步写入本文件，以下章节由 [GitHub Release](https://github.com/vark-debug/RocX/releases/tag/v0.4.0) 正文回填。

## v0.5.0 (2026-10-27)

新增**可灵（Kling）视频生成平台**，并首次引入「积分制」成本口径 —— 可灵按灵感值计费、提交即扣费，与其余三家的「人民币元估算」不是一套账。

> **配套文档**：新增 [docs/agent-install.md](docs/agent-install.md) —— 面向 AI agent 的 macOS 自动化安装指南（UPIA 静默安装插件 / 可灵 CLI 安装 / OAuth 登录引导 / 体检脚本 / 故障速查）。

### 新增

- **可灵视频生成 provider**（走本机 `kling` CLI，非 HTTP API）
  - 文生视频 `text_to_video` / 图生视频 `image_to_video`，参考图传本地路径由 CLI 自动上传，公网 URL 直传不下载重传
  - **全能参考 `omni_ref_video`**：参考视频 + 参考图 + 提示词 → 新视频（视频 → 视频）。参考视频按服务端声明只能走这个工具
  - **模型清单由服务端动态下发**（`who_am_i` → `availableModels`），不硬编码；清单拉取失败时禁用提交并回退到设置面板自检
  - 参数按目标工具的模型声明过滤下发（CLI 对未声明参数直接报错）
  - C++ addon 新增 `runCommand`（macOS `posix_spawn` / Windows `CreateProcessW`），异步不阻塞 JS 线程
- **平台切换 UI**：模型弹层顶部新增「平台」一栏（MiniMax / 可灵），切换后模型清单、默认模型、参数约束、API Key 分槽同步
- **可灵环境自检**（设置面板）：CLI 是否安装 / 是否登录 / 会员等级 / 灵感值余额 / 可用模型数，支持「重新检测」
- **积分制成本结构化**：`CostEstimate = { amount, unit, basis }`，可灵走 `CREDITS` / `actual`（实扣值），其余三家走 `CNY` / `estimated`（本地价格表估算），**两种单位绝不互相折算**
- **飞书上报适配**
  - payload 扩为 8 字段：新增 `creditsConsumed` / `costUnit` / `status`
  - 可灵「**提交即上报**」：拿到 `generationId` + `creditsConsumed` 的瞬间入账，终态成功 / 失败均**不重复上报**
  - 可灵任务失败时仍保留 `creditsConsumed`，便于本地对账

### 变更

- **参数约束的派生源**从全局表 `VIDEO_PARAM_CONSTRAINTS[modelId]` 改为**当前 provider 的 model descriptor**（MiniMax 行为不变；可灵的规格由服务端下发，不在本地表里）
- `VideoModel` / `VideoResolution` / `VideoRatio` 放宽为可接受 provider 自定义取值（保留已知值的字面量补全）
- 参考素材的抓取 / 选择路径按 provider 区分：可灵走 CLI，由 CLI 自己上传素材，不再调用 provider 的文件上传接口
- 飞书多维表格需新增「灵感值」「计费单位」「状态」三列；**人民币元与灵感值两张表分别求和，不得跨单位相加**
- 新增 `npm run typecheck`（`tsc` + `vue-tsc`）；仓库此前没有 `vue-tsc`，`.vue` 文件的 `<script setup>` 实际未被类型检查
- **可灵 CLI 环境自检状态持久化**
  - 之前：检测结果只存在内存（模块级 ref），插件重启即丢；检测只在「打开设置面板」或「切到可灵 provider」时触发
  - 现在：检测结果（就绪态 / 余额 / 会员 / 模型清单）写入 `app-settings.json` 的 `klingEnv` 字段
    - 全新安装：跑一次真实检测并落盘
    - 二次启动：先读快照渲染 UI（余额/模型立即可见，无需等 CLI），再后台静默刷新覆盖
    - 失败态快照（未装 CLI / 未登录）下次启动会**立即重试检测** —— 用户很可能刚装好/刚登录
  - 快照存在 settings 文件而非 secureStorage：余额 / 会员 / 模型清单都不是密钥
  - 设置面板新增「上次检测」时间显示（快照可能来自上一次启动，需要让用户知道余额的测量时间）
- **未配置 MiniMax API Key 时默认走可灵**
  - 之前：默认 provider 恒为 minimax，没配 key 的新用户一进来就看到「请配置 API Key」，而可灵（走 CLI 登录态，**不需要 API Key**）明明可用
  - 现在：启动时读 minimax 的 key —— 没配就默认切到可灵，并把平台栏里可灵排到前面（可直接用的平台优先）；已配 key 的老用户保持 minimax，不受影响
  - 可灵的默认模型取**服务端下发的 `defaultModel`**（实测 `kling-video-v4_0`）—— **不能取清单首项**：服务端返回顺序是 `v2_5, v2_6, o1, v3_0_omni, v3_0, v3_0_turbo, v4_0`，首项是旧版 v2_5
  - 设置面板里补配 / 清除 minimax key 后，平台栏排序实时跟随
- **可灵 CLI 并发限流 + 提交并发上限**
  - 问题背景：每次可灵 CLI 调用都会 fork 一个独立 node 进程（单进程峰值 RSS 实测 `query_tasks` 312MB / `who_am_i` 352MB —— node 要加载 CLI 那份 17k 行 esbuild 产物 + 111 个依赖）。16 个并发实测吃掉 **2.2GB** 内存，在 PR 里再叠加渲染/编解码就会明显卡顿
  - 放大器是**轮询**：每个在飞任务一个独立定时器，每 5s 各拉起一个 node 进程
  - 修复 1（技术层，UXP 侧）：`klingCli.ts` 加信号量，**同时最多 3 个 CLI 业务进程**，超出的排队（FIFO）
    - 限流点选在真正起进程之前（`runCommand` 之前）；CLI 定位探测不纳入限流（只在首次跑一次，且必须串行）
    - 排队等待上限 30s，超时则放弃并明确报错「可灵 CLI 请求排队超时」—— 不能让用户看到「生成中」卡死实际在排队
    - 槽位在异常路径也会释放（不泄漏）
  - 修复 2（产品层，webview 侧）：**同时在飞任务数上限 3**
    - 提交前拦截（`submitGenerate` 入口）+ 按钮禁用（`canSubmit`）+ 按钮直接显示原因文案
    - 计数剔除「提示词优化占位」（临时登记，不产生视频、不占 CLI 进程）
  - 尚未做：改用 CLI 原生 `query_tasks --poll`（单进程内部轮询，内存占用只有插件侧轮询的 1/3.4）—— 涉及轮询状态机重构，留待后续
- **提交乐观 UI**（点击「生成」后 UI 立刻响应，不再有 2.5-4s 空窗）
  - 问题背景：可灵提交链路全是慢操作 —— `kling account` 实测 1.84s、`kling who_am_i` 1.66s、CLI 提交 2-3s。旧实现是「全部校验/上传完 → 建卡片」，用户点完按钮后 2.5-4s 内界面毫无变化
  - 修复 A（**关键**）：**先落 pending 卡片，再做慢操作**
    - 记录创建与 `records.unshift` 提到所有慢 `await` 之前，UI 在 ~50ms 内可见
    - 慢操作任一环节失败，乐观卡片就地转 `failed`（带错误信息），不再「无声消失」
    - 提交 payload 用**补传后**的素材（换 provider 提交时 `fileId` 是现场补传的），与卡片里展示的原始 refs 区分开
    - 纯本地校验（capability 是否支持视频生成）提到最前 —— 失败时不该产生任何 UI 变化
  - 修复 B：**余额检查不再阻塞提交**
    - `checkKlingReady` 改为只读**已知**余额（可能是上次快照值）判断，不等 `kling account` CLI
    - 真实余额刷新放后台跑（`void refreshKlingAccount()`，失败静默），刷新后的值写回环境状态并落盘快照
    - 代价：快照过期时可能漏挡「余额已归零」，但服务端会明确拒绝并带回充值链接，代价可控
  - 修复 C：**提交按钮 loading 态**
    - 点击后按钮立刻变「提交中...」并禁用，给即时反馈（引用计数实现，多任务并发提交时一个完成不会误清另一个的态）
    - 提交在途时重复点击被忽略（`onSubmitClick` 守卫）
  - 验证：新增 10 组回归（测真实 `useSubmit` / `checkKlingReady` 代码），覆盖乐观卡片落点、失败转 failed、余额不阻塞、引用计数等
- **可灵素材预上传：点「生成」→「生成中」的空窗从 ~10s 压到 ~2.5s**
  - 问题背景：素材以**本地路径**交给可灵 CLI 时，CLI 会在提交命令内部现传 CDN —— http.log 实测 `POST /api/mcp/files` 耗时 4.0-8.7s（4MB mp4）。这段全部落在「pending 卡片已出、status 还没切成 generating」的空窗里，用户只看到「排队」干等 10 秒
  - 破局点：CLI 的 `resolveFileUrl` 对 http(s) 是**直通不重传**的（`if (/^https?:\/\//.test(file)) return file;`）—— 所以只要提前把素材传成可灵 CDN 直链，提交时传 URL 即可跳过 CLI 内部的整段上传
  - 修复 A（**关键**）：抓素材时**后台预上传**拿 CDN 直链，提交时直链就绪
    - 新增 `webview-ui/src/providers/kling/klingPreUpload.ts`：后台调 `kling file_upload <path> --quiet` 取直链（实测 `body.url` / `body.data.url`）
    - 接入点全覆盖：抓帧 / 抓视频 / 抓帧→PS 的「修改完成」/ 选文件添加 / 用生成结果作参考（`useReferences.ts` 五个入口）
    - 直链存 `ReferenceItem.klingFileUrl`（**不占用 `fileId`** —— `fileId` 语义是「provider 自家文件服务的 id」且与 `uploadProvider` 绑定，可灵没有这层服务，混用会污染 minimax 的换 provider 补传逻辑）
    - 实测：预上传 5.75s（4MB mp4）从「提交路径」搬到「抓素材路径」，用户写 prompt 的那几十秒正好覆盖掉；提交侧只剩 CLI 冷启 + `who_am_i` 能力发现（实测 856ms）+ 提交往返（~1s）
  - 修复 B（**兜底，不阻断**）：预上传失败 / 直链过期 → 保持本地路径，由 CLI 自行上传（与改造前完全一致的行为）
    - 直链 TTL 取 6 小时（保守）：可灵 CDN 对象侧实测过期在 16 天量级（`x-oss-expiration`），但签名参数另有有效期，旧直链实测会 403
    - 过期回退本地路径重传（宁可慢，不可错）
    - 预上传失败**不重试**，避免同一次提交里连传两遍
  - 修复 C（**文案细化**）：「排队」拆成两段可见状态
    - `GenerationRecord.pendingStage` 新增 `preparing` / `submitting`
    - pending 卡片显示「准备素材中」（CLI 自检 + 素材上传/直链回填）→「提交中」（provider 提交接口）→ 终态清空该字段
  - 配套（**防止预上传反而堵住提交**）：UXP 侧 CLI 通道按优先级分级
    - `klingCli.ts` 的并发信号量拆成前台 / 后台双队列：前台（提交 / 轮询）优先，后台（预上传）让位
    - 后台预上传可被用户点「生成」后的前台请求插队，避免预上传占满 3 个槽位把提交堵在队列里
  - 验证（无头集成测试，真实代码 + mock bridge）
    - 预上传模块 13 组：直链回填 / 同一路径只起一次任务 / 失败不阻断 / 过期清直链 / 直链复用
    - CLI 优先级队列 12 组：3 个后台占满槽位 → 前台提交插队先启动；排队超时返回明确错误且不泄漏槽位
    - 真实 CLI 实测：`file_upload` 5.75s（4MB mp4，含空格路径经 argv 传参）、`who_am_i` 856ms、直链 HEAD 200（`video/mp4` / 4033258 bytes）
    - `npm run typecheck` + `npm run build` 全通过

### 修复

- **可灵提交多行提示词时报「可灵拒绝了当前参数：Usage: kling omni_ref_video ...」**
  - 根因：可灵 CLI 的 `parseFlags` 用正则 `/^--([A-Za-z][A-Za-z0-9_-]*)=(.*)$/` 匹配 `--flag=value` 形式，而 JS 正则的 `.` **默认不匹配换行** —— `--prompt=第一行\n第二行` 整条匹配失败被丢弃，CLI 判定「没给 prompt」，于是把整段 usage 打到 stderr 并 `exit 1`
  - 影响面：所有可灵视频命令（`text_to_video` / `image_to_video` / `omni_ref_video`），与是否使用全能参考无关
  - 修复：参数组装按值内容智能选型 —— 值以 `--` 开头走等号形式，其余（含换行）走 `--flag 值` 分离形式；两种形式均由 CLI 源码与真实 CLI 实测确认
  - 兜底：CLI 的 usage 文本（3000+ 字符）不再原样甩给用户，改为一句可行动的中文提示
- **MiniMax 上传的参考素材 `fileId` 是数字导致可灵提交崩溃**（`(e.fileId||"").trim is not a function`）
  - 根因：MiniMax 上传接口的 `file_id` 是 int64（JSON 数字），代码却按 string 使用；在 minimax 模式抓的素材切到可灵后，`.trim()` 作用在数字上直接抛错
  - 修复：UXP 侧上传结果统一 `String()` 归一化；可灵侧 `referenceSource` 加类型守卫（非字符串按无 fileId 处理，走本地路径）；读盘时把历史记录里的数字型 `fileId` 转成 string
  - 兼容性：归一化前后 `mm_file://<id>` 拼接结果完全一致，minimax 侧请求语义不变
- **可灵生成结果下载失败**（`下载失败: Permission denied to the url https://v2-fdl.kechuangai.com/... . Manifest entry not found.`）
  - 根因：UXP 的 `requiredPermissions.network.domains` 是网络白名单，域名不在表里就拒绝请求。可灵接入时漏加 CDN 域名（`uxp.config.ts` 当时留的是未经验证的 `api.klingai.com` / `cdn.klingai.com`，这两个域名实际不存在）
  - 修复：补 `https://*.kechuangai.com` 与 `https://*.klingai.com`（`network.domains` 与 `webview.domains` 同步）；原先的猜测条目一并删除
  - 为什么必须通配：CDN 主机名含分片编号（实测见过 `v2-` / `v4-` / `p2-` / `p4-`），且主域名本身迁移过（`*.klingai.com` → `*.kechuangai.com`），路径前缀也变过（`/ksc2/` → `/bs2/upload-ylab-stunt/`）
  - 说明：可灵的 API / OAuth / 上传票据请求由 CLI 子进程（node）发出，是独立 OS 进程，不受 UXP 白名单约束；白名单只管 UXP 侧下载生成结果

### 兼容性

- **现有 provider 的飞书上报数据零变化**：估价金额、purpose、上报时机均与改造前逐条一致（回归比对 294 条 payload + 260 条估价用例）
- 可灵功能依赖 Adobe PR ≥ 26.2（C++ Hybrid addon 仅在 26.2+ 可加载，更早版本报 "Addon is not supported"）与本机已安装并已登录的 `kling` CLI；两者任一缺失时仅可灵功能不可用，其余功能不受影响
- 可灵**不需要 API Key**（走 CLI 登录态），其余三家仍按原有 Key 配置流程
- **manifest 有变更**：新增可灵 CDN 域名白名单（`network.domains` 与 `webview.domains` 同步）—— manifest 不热更新，**升级后必须重新加载插件**
- 未配置 MiniMax API Key 的新用户启动时默认切到可灵（可直接用，无需先配 Key）；已配 Key 的老用户默认平台不变

### 已知限制

- **轮询仍为插件侧逐任务拉起**：可灵每个在飞任务每 5s 拉起一个独立 node 进程（单进程峰值 RSS 实测 `query_tasks` 312MB / `who_am_i` 352MB）。已用「CLI 并发上限 3 + 在飞任务上限 3」双重限流把峰值从 2.2GB 压下来，但改用 CLI 原生 `query_tasks --poll`（单进程内部轮询，内存约为现方案的 1/3.4）尚未做 —— 涉及轮询状态机重构，留待后续版本
- **未配置 API Key 时默认切可灵**：依赖本机已装并登录 `kling` CLI；两者都没有时用户仍需手动在平台栏切换
- **可灵素材直链 TTL 6 小时**：过期后回退本地路径由 CLI 重传（宁可慢，不可错）
- **本仓库 `public-hybrid/` 当前只有 arm64 产物**：Intel Mac / Windows 需在对应平台执行 `npm run native:build` 重新产出原生 addon

## v0.4.1 (2026-10-15)

新增**提示词模板**功能，提升重复性提示词的录入效率。

### 新增

- **提示词模板（"/" 唤起）**：提示词输入框内键入 `/` 唤起模板浮层，键盘 ↑↓ 选择、回车插入、Esc 关闭；视频与图片输入框均支持
- **模板锚定符**（仅模板内有效，不进入最终提示词）：
  - `{xxx}` 光标锚点：插入后光标定位到锚点处，`xxx` 作为预填文本全选，直接打字即覆盖
  - 「甲或乙」模式等效符：视频模式取甲、图片模式取乙（无「或」时原文保留）
- **设置页模板管理**：内置模板开合 + 自定义模板增删改（上限 10 条，随插件全局持久化，跨工程共享）
- **生成闸门**：提示词与模板原样一致（未修改 `{xxx}` 预填）时拦截提交并提示，防止把锚点占位文本直接送去生成

### 兼容性

- 纯 webview + storage 层改动，无 manifest 变更，热更新即可生效

## v0.4.0 (2026-10-09)

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

### 附件说明

- `com.rocx.uxp_premierepro.ccx`：CCX 安装包（macOS 本机构建）。包内 C++ Hybrid addon（`RocXBridge.uxpaddon`）**仅含 macOS arm64 版本**——Windows 安装后「抓帧→PS」会因 addon 缺失**直接降级走 launcher 启动脚本**（`launcher.ps1` / `launcher.cmd`），功能可用但拉起方式不同；Windows 版 addon 需在 Windows 上另行编译打包。

**Full Changelog**: https://github.com/vark-debug/RocX/compare/v0.3.0...v0.4.0

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
