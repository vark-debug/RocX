# RocX — Premiere Pro AI 视频生成插件

在 Premiere Pro 面板内直接调用 MiniMax 视频生成模型：添加参考素材（抓帧 / 抓取工作区片段）、填写提示词生成视频，一键导入当前工程，生成历史全程可预览、可管理。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 软件 | Adobe Premiere Pro **26.5.0 或更高版本** |
| 操作系统 | **macOS**（开发与验证环境）；Windows 理论上可用但**未做验证**，遇到问题欢迎反馈 |
| 安装方式 | UXP 插件（CCX 包，manifest v6） |
| 网络 | 可访问 MiniMax 服务：`api.minimax.cn`、`cdn.hailuoai.com` 及阿里云 OSS 产物下载域名 |
| 账号 | **MiniMax 官方开放平台**签发的 API Key（插件直接调用官方素材上传接口，第三方中转 Key 不可用） |

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

即插件**没有使用任何 26.5 才新增的 API**（26.5 新增的 `C2PAService`、`MediaManager`、`WorkAreaUtils`、`Media.getStart/getDuration` 等均未使用）。要求 26.5.0 的原因：

- 插件 manifest 采用 manifestVersion 6，UI 由 WebView 承载，`allowLocalRendering` 需 UXP 8.0+（官方版本对照：Premiere 26.0.2 起集成 UXP 8.1）
- 26.5 为当前开发与实测验证的基线版本，更低版本未做测试

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
- **抓视频**：把工作区栏范围内的视频段作为参考视频（自动读取时长；若超过当前模型最大时长档，会提示并自动按最大档生成，流程继续）

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
