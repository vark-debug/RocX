# RocX — Premiere Pro AI 视频生成插件

在 Premiere Pro 面板内直接调用 MiniMax 视频生成模型：添加参考素材（抓帧 / 抓取工作区片段）、填写提示词生成视频，一键导入当前工程，生成历史全程可预览、可管理。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 软件 | Adobe Premiere Pro **25.6.4 或更高版本** |
| 操作系统 | **Windows** 与 **macOS**（v0.2.0 起双平台全量验证） |
| 安装方式 | UXP 插件（CCX 包，manifest v6） |
| 网络 | 可访问 MiniMax 服务：`api.minimax.cn`、`cdn.hailuoai.com` 及阿里云 OSS 产物下载域名 |
| 账号 | **MiniMax 官方开放平台**签发的 API Key（插件直接调用官方素材上传接口，第三方中转 Key 不可用） |
| 抓视频依赖 | **Adobe Media Encoder（AME）必须已安装并能正常启动**：抓视频基于 Premiere UXP 的 [`EncoderManager.exportSequence`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager)，按官方文档说明，该 API 的转码由 AME 后台执行（`exportType` 含 `QUEUE_TO_AME`，事件如 `EVENT_RENDER_COMPLETE / ERROR / PROGRESS` 也由 AME 广播）；`EncoderManager` 还提供了 `isAMEInstalled` 属性用于检测。**Win / Mac 若仅装 Premiere 而未装 / 未授权 AME，抓视频将无法完成**；抓帧（基于 `Exporter.exportSequenceFrame`）不受此影响 |

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

打开面板 **设置** 页，粘贴 MiniMax API Key 并保存。

> 注意：目前仅支持 **MiniMax 官方开放平台**签发的 API Key。插件会直接调用 MiniMax 官方的素材上传接口来上传抓帧/抓视频参考素材，第三方中转平台的 Key 不支持该接口，无法使用。

### 2. 添加参考素材（可选）

点击素材列表上方的按钮添加，均为当前项目的参考输入：

- **抓帧**：把节目监视器当前画面截为参考图
- **抓视频**：把工作区栏范围内的视频段作为参考视频（自动读取时长；若超过当前模型最大时长档，会提示并自动按最大档生成，流程继续）。该能力依赖 **Adobe Media Encoder (AME)**：插件通过 [`EncoderManager.exportSequence`](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager) 触发导出，按官方文档转码由 AME 后台执行；请确保本机已安装并能正常启动 AME（Win 用户尤其注意：仅装 Premiere 不一定会带 AME），否则抓视频将无法完成。可用 `EncoderManager.isAMEInstalled` 在代码侧检测。

### 3. 生成视频

填写提示词，选择模型、时长、分辨率、画面比例，点击生成。生成过程可在记录列表中查看状态。

### 4. 管理生成记录

生成完成后，在记录列表中可以：

- **预览**：直接播放生成结果（缩略图 / 视频播放）
- **重新上传**：把某条结果再次作为参考素材用于新一次生成
- **导入到工程**：导入当前 PR 工程的项目面板

## 文件存储说明

生成结果与素材的存放位置分两类：

- **生成结果**：生成完成后先存放在**插件私有目录**（UXP PluginData）；点击**导入到工程**时，才被**移动**到 PR 项目旁的 `AI_Generated_Media/Imports/` 并更新记录路径——因此同一条记录导入过一次后，再次导入不会重复移动
- **参考素材（抓帧 / 抓视频）与生成记录**：存放在 PR 项目旁（项目未保存或目录创建失败时降级到插件私有目录）

```
<PR项目目录>/
├── <项目名>.ai-gen.json      # 生成记录（路径、参数、状态）
└── AI_Generated_Media/
    ├── Imports/              # 「导入到工程」时生成结果从私有目录移动到这里
    └── References/           # 抓帧 / 抓视频的参考素材
```

- 请勿在 PR 外随意改名或移动 `AI_Generated_Media/` 内的文件，否则记录中的路径会失效
- 删除面板中的记录不会删除磁盘文件；需要清理时请手动处理上述目录

## 使用建议

- 当前为**原型阶段**版本，不建议同时执行多条视频生成：并发生成可能造成状态与文件读写相互干扰，请逐条生成、完成后再发起下一条。

## 常见问题

**导入时提示"导入前文件未就绪"？**
这是文件落盘保护机制（等待生成结果真实写入完成后再导入），多为磁盘繁忙所致，稍候重试即可。

**抓视频提示超长？**
素材时长超过当前模型的最大时长档，插件已自动按最大档生成，无需处理。

**生成失败提示鉴权/余额错误？**
检查 API Key 是否有效、账户余额是否充足。

## 致谢

本项目基于 [Bolt UXP](https://github.com/hyperbrew/bolt-uxp) 构建 —— 一个 Vite + TypeScript 驱动的 Adobe UXP 插件脚手架，提供了插件清单生成、Webview UI 热重载、CCX 打包与 C++ Hybrid Plugin 支持。

Bolt UXP 由 [Hyper Brew](https://hyperbrew.co) 以 MIT 协议开源发布，感谢其作者与贡献者。

另：仓库内 `native/RocXBridge/third_party/uxp-hybrid-sdk/` 下的 Adobe UXP Hybrid Plugin SDK 头文件版权归 Adobe 所有，遵循 Adobe 随附的许可协议。

## License

基于 [MIT](LICENSE) 协议开源。
