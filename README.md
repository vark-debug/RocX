# RocX — Premiere Pro AI 视频 / 图片生成插件

在 Premiere Pro 面板内直接调用 AI 生成模型：**视频生成**（MiniMax 海螺）与**图片生成**（RunningHub / 火山方舟 Seedream），支持抓帧 / 抓取工作区片段作为参考素材、提示词优化、分辨率提升，一键导入当前工程，生成历史全程可预览、可管理，并可把用量与估价上报到飞书多维表格做团队统计。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 视频生成 | MiniMax **H3 标准** / **H3-Max 极速**，多档时长 / 分辨率 / 画面比例，支持图 / 视频 / 音频参考 |
| 图片生成 | Seedream 5.0 Pro，双平台可选（**RunningHub** / **火山方舟**），文生图 + 图生图 |
| 智能尺寸 | 图片生成可跟随**当前活动序列的分辨率**，也可手动选 1K / 2K 档 |
| 透明底 | 图片提示词命中透明关键词时（火山方舟）自动出透明背景 PNG |
| 提示词优化 | 一键调用 `h3_context_ir` 扩写提示词（仅 H3 模型） |
| 分辨率提升 | 已生成的 768P 视频一键升级到 2K（仅 H3 模型） |
| 抓帧 → Photoshop | 抓帧后直接在 PS 打开，改完点「修改完成」再上传为参考素材 |
| 团队统计 | 生成成功即上报飞书多维表格（用途分类 + 估价），用于结算与按工程追溯 |

面板顶部为 **模式切换**：`🎬 视频生成` / `🖼 图片生成`，两个模式共用参考素材区与记录列表。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 软件 | Adobe Premiere Pro **25.6.4 或更高版本** |
| 操作系统 | **Windows** 与 **macOS**（v0.2.0 起双平台全量验证） |
| 安装方式 | UXP 插件（CCX 包，manifest v6） |
| 网络 | 需可达各 provider 域名（见下方[网络白名单](#网络白名单)） |
| 账号 | 对应平台签发的 API Key（详见[配置 API Key](#配置-api-key)） |
| 抓视频依赖 | **Adobe Media Encoder（AME）必须已安装并能正常启动**：抓视频基于 Premiere UXP 的 [`EncoderManager.exportSequence`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager)，按官方文档说明，该 API 的转码由 AME 后台执行（`exportType` 含 `QUEUE_TO_AME`，事件如 `EVENT_RENDER_COMPLETE / ERROR / PROGRESS` 也由 AME 广播）；`EncoderManager` 还提供了 `isAMEInstalled` 属性用于检测。**Win / Mac 若仅装 Premiere 而未装 / 未授权 AME，抓视频将无法完成**；抓帧（基于 `Exporter.exportSequenceFrame`）不受此影响 |

### 网络白名单

manifest 的 `requiredPermissions.network.domains` 已按当前 provider 维护，新增 provider 需同步追加（`webview.domains` 保持同步）：

| 平台 | 域名 |
| --- | --- |
| MiniMax | `api.minimax.cn`、`cdn.hailuoai.com`、`algeng-video-infer.oss-cn-shanghai.aliyuncs.com` |
| RunningHub | `www.runninghub.cn`、`*.myqcloud.com`（结果 COS，桶名不固定，通配覆盖） |
| 火山方舟 | `*.volces.com`（含 `ark.cn-beijing.volces.com` API 与结果 CDN） |
| 飞书 | `*.feishu.cn`（多维表格自动化 webhook，租户级子域名必须通配） |

> **改动 manifest 后必须重新加载插件才生效**（manifest 不热更新）。

### 版本要求说明

已对照官方 [Premiere DOM API 参考](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/)（每个成员标注 MIN VERSION）逐一核对，插件用到的 API 及官方最低版本如下：

| 插件用到的 API | 官方最低版本 |
| --- | --- |
| `Project.getActiveProject` / `getActiveSequence` / `importFiles` / `lockedAccess` / `executeTransaction` | 25.6 |
| `Sequence.getInPoint` / `getOutPoint` / `getVideoTrackCount` | 25.6 |
| `SequenceEditor.getEditor` / `createOverwriteItemAction` | 25.6 |
| `TickTime.createWithSeconds` | 25.6 |
| `Exporter.exportSequenceFrame`（抓帧） | 25.6 |
| `EncoderManager.getManager` / `exportSequence`（抓视频） | 25.6 |

即插件**没有使用任何 26.5 才新增的 API**（26.5 新增的 `C2PAService`、`MediaManager`、`WorkAreaUtils`、`Media.getStart/getDuration` 等均未使用），也未使用任何 26.3 才强制的语法特性（如 `create*Action` 在 `lockedAccess` 内的硬性约束），因此理论上可在 **Premiere 25.6 / 26.0 / 26.2 / 26.3 / 26.5** 全系 UXP 8.x 上运行。要求 25.6.0 的原因：

- 插件 manifest 采用 manifestVersion 6，UI 由 WebView 承载，`allowLocalRendering` 需 UXP 8.0+（官方版本对照：Premiere 26.0.2 起集成 UXP 8.1；Premiere 25.6 自带 UXP 8.1）
- 25.6 为官方 UXP for Premiere 的**正式首发版本**（[Adobe Changelog](https://developer.adobe.com/premiere-pro/uxp/changelog/)）；v0.2.0 已在 **Premiere 25.6.4 / 26.x + Windows / macOS** 双平台完成全流程验证

### 关于 Adobe UXP 版本对照（自核验）

| Premiere 版本 | 内置 UXP 版本 | 引用 |
| --- | --- | --- |
| 25.6 | UXP 8.1 | [Adobe Host Environment 文档](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/host-info/) |
| 26.5 | UXP 8.x | [Adobe Changelog](https://developer.adobe.com/premiere-pro/uxp/changelog/) |

### 类型包说明

`@adobe/premierepro` npm 类型包**最低版本是 26.2.0**（官方未发布 25.6.0 类型包）；本项目保留使用 `@adobe/premierepro@26.5.0` 作为构建时类型参考，但 manifest 的 `host.minVersion` 仍为 25.6.0 —— 运行时实际依赖的 DOM API 全部在 25.6 已可用（参见上表）。

### Action 锁规范（25.6 / 26.3 通用）

- `lockedAccess` 回调内**不再使用 async**（Adobe 官方 ESLint 规则 [`no-async-in-lock-scope`](https://github.com/adobe/eslint-plugin-premierepro/blob/main/docs/rules/no-async-in-lock-scope.md)）
- 所有 `create*Action` 在 `executeTransaction` 内同步创建并通过 `compoundAction.addAction` 提交
- 26.3 才强制的"`create*Action` 必须在 `lockedAccess` 内创建"在 25.6 上**已默认满足**（本项目一直用 `lockedAccess(executeTransaction(...))` 嵌套结构）

## 安装

1. 双击 `ccx/com.rocx.uxp_premierepro.ccx`，按提示完成安装
2. 重启 Premiere Pro
3. 打开面板：菜单栏 **窗口 > 扩展 > RocX**

> 若双击安装无效，可在 [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/uxp-developer-tools/) 中 Import 并 Load 本 CCX 包。

## 使用步骤

### 1. 配置 API Key

打开面板右上角 **设置**，为你要使用的平台填写 API Key 并保存。**三个平台的 Key 相互独立，只需填写实际要用的**：

| 平台 | 用于 | 说明 |
| --- | --- | --- |
| **MiniMax** | 视频生成 | 需 **MiniMax 官方开放平台**签发的 Key。插件直接调用官方素材上传接口上传参考素材，**第三方中转 Key 不支持该接口，无法使用** |
| **RunningHub** | 图片生成 | RunningHub 开放平台 API Key |
| **火山方舟** | 图片生成 | 火山方舟（方舟大模型）API Key |

- Key 优先存入 UXP `secureStorage`（macOS 钥匙串）；不可用时降级为混淆写文件（**非真加密**，仅防明文肉眼可读）
- 设置页另有**飞书上报**配置（见[飞书多维表格上报](#飞书多维表格上报)），未配置则静默跳过上报，不影响生成

### 2. 添加参考素材（可选）

切换到对应模式后，点击素材列表上方的按钮添加，均为当前工程的参考输入：

- **🖼 抓帧**：把节目监视器当前画面截为参考图（图片参考最多 9 个）
- **🎬 抓视频**（仅视频模式）：把工作区栏范围内的视频段作为参考视频（视频参考最多 3 个，自动读取时长；若超过当前模型最大时长档，会提示并自动按最大档生成，流程继续）。该能力依赖 **Adobe Media Encoder (AME)**，请确保本机已安装并能正常启动，否则抓视频将无法完成
- **🎨 抓帧→PS**：抓帧后**自动在 Photoshop 中打开**该图片，你在 PS 里改完后面板上点「**修改完成**」才会真正上传为参考素材；未点确认前该素材显示为「✏ PS 中」，生成时会被跳过并提示
  - 拉起 Photoshop 走三级回退：native addon（C++ Hybrid）→ launcher 脚本 → 系统文件关联
- 两种模式下，**有参考图即自动走图生图**，无参考图走文生图（路由由 provider 内部判定，无需手动切换）

> 参考素材归属在**抓取瞬间**即锁定到当时打开的工程，多工程并行打开时不会错位。

### 3. 生成视频（🎬 视频生成）

填写提示词，选择模型、时长、分辨率、画面比例，点击生成。生成过程可在记录列表中查看状态。

- **提示词优化**：点提示词框右上角 **✨** 调用 `h3_context_ir` 扩写（**仅 H3 标准模型**支持，H3-Max 无此能力）
- 视频参考**总时长上限 15 秒**

### 4. 生成图片（🖼 图片生成）

填写提示词，选择模型、尺寸档位与画面比例，点击生成。

- **尺寸档位**：
  - **智能**（默认）：跟随**当前活动序列的分辨率**，提交时实时读取并按平台像素上限等比钳制（超限会自动缩放并提示）。此时宽高比选项不生效
  - **1K / 2K**：按所选宽高比映射到预设像素（如 16:9 的 1K = 1280×720，2K 为其两倍）
- **平台**：
  - **RunningHub** `seedream-v5-pro`：异步提交 + 轮询取结果
  - **火山方舟** `doubao-seedream-5-0-pro-260628`：**同步 API**（一次请求直接返回，实测 55~80 秒），面板会显示为「生成中」而非「等待中」
- **透明背景**（火山方舟）：提示词中含 `透明背景` / `透明底` / `无背景` / `去背景` / `transparent` / `alpha` 等关键词时，插件自动补一张全透明画布作为输入并要求输出透明 PNG，从而产出带 alpha 通道的图（**纯文生图无法出透明底**）
- 参考图以 Base64 直传（RunningHub 对外链 / 文件名引用会报 1007 无法识别）
- 图片结果会**尽快落盘**到工作目录（平台结果 URL 仅 24 小时有效）；即使落盘失败仍可在面板预览与导入

### 5. 管理生成记录

生成完成后，在记录列表中每条记录可：

- **预览**：直接播放生成结果（缩略图 / 视频播放）
- **重试**：文件 ID 过期（超过 6 天）时自动补传并重跑
- **填入生成器**：把该记录的提示词 / 参数 / 参考素材回填到生成器（不自动提交）
- **用作参考**：把该结果再次作为参考素材用于新一次生成
- **⬆ 升级到 2K**：对 768P 视频调用 `video_regeneration` 升级到 2K（**仅 H3 模型**，已升级过的不会重复升级）
- **导入到工程**：导入当前 PR 工程的**项目面板**
- **拖拽**：直接把记录卡片拖到 PR 时间线（也可在项目面板拖入）

> 「导入到工程」**只导入 Project 面板，不插入时间线**；需要上时间线请用拖拽。

## 文件存储说明

生成结果与素材的存放位置分两类：

- **生成结果**：生成完成后先存放在**插件私有目录**（UXP PluginData）；点击**导入到工程**时，才被**移动**到 PR 项目旁的 `AI-Generated-Media/Imports/` 并更新记录路径——因此同一条记录导入过一次后，再次导入不会重复移动
- **参考素材（抓帧 / 抓视频 / 抓帧→PS）与生成记录**：存放在 PR 项目旁（项目未保存或目录创建失败时降级到插件私有目录）

```
<PR项目目录>/
├── <项目名>.ai-gen.json           # 生成记录（路径、参数、状态、估价）
└── AI-Generated-Media/
    ├── Imports/                   # 「导入到工程」时生成结果从私有目录移动到这里
    └── References/                # 抓帧 / 抓视频 / 抓帧→PS 的参考素材
```

- 记录**跟随工程**：切换工程后面板只显示当前工程的记录，生成中的其他工程任务会在后台继续轮询
- 请勿在 PR 外随意改名或移动 `AI-Generated-Media/` 内的文件，否则记录中的路径会失效
- 删除面板中的记录不会删除磁盘文件；需要清理时请手动处理上述目录

## 飞书多维表格上报

生成成功后自动把「谁在什么工程、用什么素材、生成了哪条内容、花了多少估价」上报到飞书多维表格，便于团队做统计、结算与按工程追溯。

- 设置页填写 **Webhook 地址** / **Token** / **剪辑师姓名**，点「**测试上报**」用固定样例验证地址、令牌与表格字段映射
- 上报字段：`recordId` / `estimateCost` / `editorName` / `projectName` / `purpose`
- **用途分类**（`purpose` 列）：`视频生成` / `图片生成` / `分辨率升级` / `提示词优化`，可在飞书侧按列做透视与汇总
- 上报在记录首次变为 `generated` 的瞬间 fire-and-forget 发出，**失败仅 toast 提示，不影响生成结果**
- 上报请求由 **UXP 端**发出，token 保留在 `secureStorage`，不跨桥暴露给 WebView
- 命中飞书限流（错误码 `800005652` 或 HTTP 429）时按 400 / 800 / 1600ms 指数退避重试，最多 3 次并带 ±50% 抖动；鉴权 / 参数 / 网络异常不重试

### 估价口径

统一保留三位小数；价格集中在一处调整。

| 用途 | 公式 |
| --- | --- |
| 视频生成 | `(参考视频总时长 + 输出视频时长) × 档位单价`（2K = 0.8 / 768P = 0.5 / 480P = 0.33 元/秒） |
| 图片生成 | 按尺寸档位每张计价 + 图生图输入图加收（**首张免费**，第 2 张起按张计）<br>RunningHub：1K 0.27 / 2K 0.54 元/张，输入图 0.018 元/张<br>火山方舟：1K 0.3 / 2K 0.6 元/张，输入图 0.02 元/张 |
| 分辨率升级 | `(参考视频时长 + 输出视频时长) × 0.3` |
| 提示词优化 | `prompt_tokens × 5.80 + completion_tokens × 23.00` 元 / 百万 tokens |

> 单 URL 方案可支撑约 100~200 人团队稳态运行；建议开启飞书自动化 webhook 的凭证校验，否则单流程频率上限仅 1 次/秒（开启后 5 次/秒）。

## 使用建议

- 当前为**原型阶段**版本，不建议同时执行多条生成：并发生成可能造成状态与文件读写相互干扰，请逐条生成、完成后再发起下一条。

## 常见问题

**导入时提示"导入前文件未就绪"？**
这是文件落盘保护机制（等待生成结果真实写入完成后再导入），多为磁盘繁忙所致，稍候重试即可。

**抓视频提示超长？**
素材时长超过当前模型的最大时长档，插件已自动按最大档生成，无需处理。

**生成失败提示鉴权/余额错误？**
检查对应平台的 API Key 是否有效、账户余额是否充足。

**图片生成报「未能获取活动序列分辨率」？**
智能尺寸档需要读取当前活动序列，请先在 PR 里打开一个序列，或改用 1K / 2K 预设档。

**RunningHub 报 1007「无法识别图片」？**
请走「抓帧」添加参考素材（插件会自动转 Base64 直传）。外部 URL 或纯文件名引用 RunningHub 无法识别。

**火山方舟生成结果没出现「等待中」而是直接「生成中」？**
火山方舟是同步 API，一次请求直接返回结果（实测 55~80 秒），属正常表现。

## 开发与构建

```bash
npm install
npm run dev        # 构建并监听（开发模式，含 C++ addon 编译）
npm run build      # 构建
npm run ccx        # 打包 CCX 安装包
```

> 三个 build 脚本都会先执行 `npm run native:build`（macOS 走 CMake，Windows 走 `scripts/native-build-win.js`），用于编译 Photoshop 拉起所需的 C++ Hybrid Addon。

## 致谢

本项目基于 [Bolt UXP](https://github.com/hyperbrew/bolt-uxp) 构建 —— 一个 Vite + TypeScript 驱动的 Adobe UXP 插件脚手架，提供了插件清单生成、Webview UI 热重载、CCX 打包与 C++ Hybrid Plugin 支持。

Bolt UXP 由 [Hyper Brew](https://hyperbrew.co) 以 MIT 协议开源发布，感谢其作者与贡献者。

另：仓库内 `native/RocXBridge/third_party/uxp-hybrid-sdk/` 下的 Adobe UXP Hybrid Plugin SDK 头文件版权归 Adobe 所有，遵循 Adobe 随附的许可协议。

## License

基于 [MIT](LICENSE) 协议开源。
