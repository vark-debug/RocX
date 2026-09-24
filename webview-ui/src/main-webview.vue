<script setup lang="ts">
// ---- 轻量 toast：UXP webview 不可依赖原生 alert ----
import { ref as _toastRef } from "vue";
const toastMsg = _toastRef("");
let _toastTimer: any = null;
function showToast(msg: string | unknown) {
  const text = typeof msg === "string" ? msg : String(msg);
  console.log("[toast]", text);
  toastMsg.value = text;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (toastMsg.value = ""), 6000);
}

import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import * as webviewAPI from "./webview-api";
import { initWebview } from "./webview-setup";
import { setBridge, bridge } from "./services/bridge";
import { MiniMaxAPI, MiniMaxError } from "./services/MiniMax";

/** 把任意异常归一为 records 用的 error 结构（带 httpStatus / errorType） */
function toRecordError(e: any) {
  if (e instanceof MiniMaxError) {
    return {
      message: e.message,
      requestId: e.requestId,
      httpStatus: e.httpStatus,
      errorType: e.errorType,
    };
  }
  return { message: String(e?.message || e) };
}
import { usePolling } from "./composables/usePolling";
import {
  MINIMAX_PARAM_CONSTRAINTS,
  type GenerationRecord,
  type MiniMaxModel,
  type MiniMaxRatio,
  type MiniMaxResolution,
  type MiniMaxParamConstraints,
  type ReferenceItem,
  type FileKind,
  type ProjectRecords,
} from "./services/messages";

import PromptInput from "./components/PromptInput.vue";
import ReferenceList from "./components/ReferenceList.vue";
import StatusPanel from "./components/StatusPanel.vue"; // 保留 import 以避免后面需要，UI 已迁到 RecordsPanel 内
import RecordsPanel from "./components/RecordsPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";

const { api, page: pageId } = initWebview(webviewAPI);
setBridge(api);

// ---------- 全局状态 ----------
const apiKey = ref<string | null>(null);
const projectInfo = ref<{ path: string; guid: string; name: string } | null>(null);
const records = ref<GenerationRecord[]>([]);
const storageMode = ref<"primary" | "fallback">("primary");
const prompt = ref("");
const model = ref<MiniMaxModel>("MiniMax-H3");
const ratio = ref<MiniMaxRatio>("16:9");
const duration = ref<number>(5);
const resolution = ref<MiniMaxResolution>("768P");
const references = ref<ReferenceItem[]>([]);
const selectedRecordId = ref<string | null>(null);
const generating = ref<GenerationRecord | null>(null);
const pollingActive = ref(false);
const settingsOpen = ref(false);
const optimizingPrompt = ref(false);

const constraints = computed<MiniMaxParamConstraints>(
  () => MINIMAX_PARAM_CONSTRAINTS[model.value],
);

// 限制 ratio/duration/resolution 在当前模型下合法
watch(model, () => {
  const c = constraints.value;
  if (!c.resolutions.includes(resolution.value)) {
    resolution.value = c.resolutions[0];
  }
  if (!c.durations.includes(duration.value)) {
    duration.value = c.durations[0];
  }
  if (references.value.length === 0 && !c.ratioAdaptiveAllowed) {
    if (ratio.value === "adaptive") ratio.value = "16:9";
  }
});

const canSubmit = computed(() => {
  if (!apiKey.value) return false;
  if (!prompt.value.trim()) return false;
  if (generating.value && pollingActive.value) return false;
  if (references.value.length === 0 && ratio.value === "adaptive") return false;
  return true;
});

// ---------- 记录加载/保存 ----------
async function loadRecords() {
  const r = await bridge.recordsRead();
  if (r.ok && r.data) {
    projectInfo.value = {
      path: r.data.projectPath,
      guid: r.data.projectGuid,
      name: "",
    };
    records.value = r.data.records;
    storageMode.value = r.data.storageMode;
    // 故障恢复：扫描 generating 状态的记录
    for (const rec of r.data.records) {
      if (rec.status === "generating" && rec.taskId) {
        resumePolling(rec);
      }
    }
  } else {
    records.value = [];
  }
}

let writeTimer: any = null;
async function persistRecords() {
  if (!projectInfo.value) return;
  // 防抖
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    const data: ProjectRecords = {
      projectGuid: projectInfo.value!.guid,
      projectPath: projectInfo.value!.path,
      records: records.value,
      storageMode: storageMode.value,
    };
    const w = await bridge.recordsWrite(data);
    if (w.ok) storageMode.value = w.storageMode;
  }, 200);
}

watch(records, () => persistRecords(), { deep: true });

// ---------- 主题 / 项目变化 ----------
webviewAPI.onProjectChanged((p) => {
  projectInfo.value = p;
  loadRecords();
});
webviewAPI.onThemeChanged((v) => {
  console.log("theme changed", v.theme);
});

// ---------- 轮询 ----------
const polling_ = usePolling();

function resumePolling(rec: GenerationRecord) {
  if (!rec.taskId || !apiKey.value) return;
  if (generating.value && generating.value.id !== rec.id) return;
  generating.value = rec;
  pollingActive.value = true;
  polling_
    .start({
      taskId: rec.taskId,
      apiKey: apiKey.value,
      onUpdate: (resp) => {
        const idx = records.value.findIndex((r) => r.id === rec.id);
        if (idx < 0) return;
        records.value[idx] = {
          ...records.value[idx],
          lastPolledAt: new Date().toISOString(),
          usage: resp.usage,
        };
      },
      onTerminal: async (resp, err) => {
        pollingActive.value = false;
        const idx = records.value.findIndex((r) => r.id === rec.id);
        if (idx < 0) {
          generating.value = null;
          resumeNextGenerating();
          return;
        }
        if (!resp) {
          records.value[idx] = {
            ...records.value[idx],
            status: "failed",
            error: { message: err?.message || "查询失败" },
          };
          generating.value = null;
          resumeNextGenerating();
          return;
        }
        if (resp.status === "succeeded" && resp.content?.url) {
          // 先经 Comlink 桥调 UXP 端下载到 plugin-data 工作目录，成功后才更新 UI 状态
          const fileName = `${rec.id}.mp4`;
          const dl = await bridge.downloadFile({
            url: resp.content.url,
            suggestedName: fileName,
            recordId: rec.id,
          });
          // await 期间用户可能切换项目导致 records 数组被替换，重新按 id 定位
          const cur = records.value.findIndex((r) => r.id === rec.id);
          if (cur < 0) {
            generating.value = null;
            resumeNextGenerating();
            return;
          }
          if (dl.ok && dl.localPath) {
            records.value[cur] = {
              ...records.value[cur],
              status: "generated",
              workFile: dl.localPath,
              usage: resp.usage,
            };
          } else {
            records.value[cur] = {
              ...records.value[cur],
              status: "failed",
              error: { message: `下载失败: ${dl.error}` },
            };
          }
        } else if (resp.status === "succeeded") {
          // 极端情况：任务成功但响应缺 url —— 明确标记失败，避免永远卡在 generating
          console.error(
            "[webview] succeeded 但缺少 content.url:",
            JSON.stringify(resp).slice(0, 300),
          );
          records.value[idx] = {
            ...records.value[idx],
            status: "failed",
            error: {
              message: "任务成功但响应缺少下载地址（content.url 为空）",
              requestId: resp.request_id,
            },
          };
        } else if (resp.status === "failed" || resp.status === "cancelled") {
          records.value[idx] = {
            ...records.value[idx],
            status: "failed",
            error: {
              message: resp.error?.message || "生成失败",
              requestId: resp.request_id,
            },
          };
        }
        generating.value = null;
        // 单轮询器设计：当前任务结束后自动恢复下一条 generating 记录
        resumeNextGenerating();
      },
    });
}

/** 当前轮询结束后，自动恢复下一条还处于 generating 的记录（多任务恢复/排队） */
function resumeNextGenerating() {
  const next = records.value.find(
    (r) => r.status === "generating" && !!r.taskId,
  );
  if (next) resumePolling(next);
}

// ---------- 操作 ----------
async function addReference(kind: FileKind) {
  const r = await bridge.pickAndUploadReference(kind);
  if (r.ok && r.reference) {
    // 校验总数上限
    const v = references.value.filter((x) => x.type === "reference_video").length;
    const i = references.value.filter((x) => x.type === "reference_image").length;
    if (kind === "video" && v >= 3) {
      showToast("视频参考最多 3 个");
      return;
    }
    if (kind === "image" && i >= 9) {
      showToast("图片参考最多 9 个");
      return;
    }
    references.value.push(r.reference);
  } else if (r.error && !r.error.includes("取消")) {
    showToast(`上传失败: ${r.error}`);
  }
}

async function captureFrameAsReference() {
  // 校验图片数量上限
  const i = references.value.filter((x) => x.type === "reference_image").length;
  if (i >= 9) {
    showToast("图片参考最多 9 个");
    return;
  }
  // 阶段 1：UXP 端只导出（不等上传），立即拿到本地 reference，UI 立即显示
  const r = await bridge.captureFrameOnlyAsReference();
  if (!r.ok || !r.reference) {
    showToast(`抓帧失败: ${r.error}`);
    return;
  }
  references.value.push(r.reference);
  // 关键：Vue ref 包装数组后，数组里的对象是 reactive proxy；
  // 直接修改 references.value[idx].xxx 会触发响应式；修改原始 bridge 返回的 plain object 不会。
  // 关键：拿数组里的 reactive proxy 引用（不是 bridge 返回的 plain object），
  // 这样引用比较 (===) 永远找得到，且属性赋值触发响应式更新。
  const refToUpdate = references.value[references.value.length - 1];
  refToUpdate.uploading = true;
  // 后台上传
  bridge
    .uploadReferenceFile({
      filePath: refToUpdate.localPath,
      fileName: refToUpdate.fileName,
    })
    .then((up) => {
      const idx = references.value.findIndex((x) => x === refToUpdate);
      if (idx < 0) return;
      if (!up.ok || !up.fileId) {
        console.warn("[webview] reference upload failed:", up.error);
        refToUpdate.uploading = false;
        showToast(`参考素材上传失败: ${up.error || "未知错误"}`);
        return;
      }
      refToUpdate.fileId = up.fileId;
      refToUpdate.uploadedAt = up.uploadedAt;
      refToUpdate.uploading = false;
    })
    .catch((e) => {
      const idx = references.value.findIndex((x) => x === refToUpdate);
      if (idx >= 0) {
        refToUpdate.uploading = false;
      }
      console.error("[webview] upload threw:", e);
      showToast(`参考素材上传异常: ${String(e?.message || e)}`);
    });
}

async function captureVideoAsReference() {
  // 校验视频数量上限
  const v = references.value.filter((x) => x.type === "reference_video").length;
  if (v >= 3) {
    showToast("视频参考最多 3 个");
    return;
  }
  // 阶段 1：UXP 端只导出，立即显示
  const r = await bridge.captureWorkAreaOnlyAsReference();
  if (!r.ok || !r.reference) {
    showToast(`抓视频失败: ${r.error}`);
    return;
  }
  // 仅当当前没有任何视频参考（即本次是第一个视频参考）时，才智能填写生成时长
  const isFirstVideoRef = references.value.every((x) => x.type !== "reference_video");
  if (r.durationSec !== undefined) {
    const t = Math.round(r.durationSec * 10) / 10;
    console.log(`[webview] captured ${t}s of work area${isFirstVideoRef ? " (auto-fill duration)" : ""}`);
  }
  references.value.push(r.reference);
  // 智能填写生成时长：用出入点时长向上取整到当前模型合法档位（6.8s→7s）；
  // 超过最大档位时取最大档并提示，但不阻止流程
  if (isFirstVideoRef && r.durationSec && r.durationSec > 0) {
    const sec = r.durationSec;
    const ds = constraints.value.durations;
    const maxD = ds[ds.length - 1];
    if (sec > maxD) {
      duration.value = maxD;
      showToast(
        `素材时长 ${sec.toFixed(1)}s 超过当前模型最大档 ${maxD}s，生成时长已设为 ${maxD}s，流程继续`,
      );
      console.log(
        `[webview] work area ${sec.toFixed(2)}s exceeds max duration, clamped to ${maxD}s`,
      );
    } else {
      duration.value = ds.find((d) => d >= sec) ?? maxD;
    }
    console.log(`[webview] auto-filled duration=${duration.value}s from work area ${sec.toFixed(2)}s`);
  }
  // 关键：拿数组里的 reactive proxy 引用（不是 bridge 返回的 plain object），
  // 这样引用比较永远找得到，且属性赋值触发响应式更新
  const refToUpdate = references.value[references.value.length - 1];
  refToUpdate.uploading = true;
  // 后台上传
  bridge
    .uploadReferenceFile({
      filePath: refToUpdate.localPath,
      fileName: refToUpdate.fileName,
    })
    .then((up) => {
      const idx = references.value.findIndex((x) => x === refToUpdate);
      if (idx < 0) return;
      if (!up.ok || !up.fileId) {
        console.warn("[webview] reference upload failed:", up.error);
        refToUpdate.uploading = false;
        showToast(`参考素材上传失败: ${up.error || "未知错误"}`);
        return;
      }
      refToUpdate.fileId = up.fileId;
      refToUpdate.uploadedAt = up.uploadedAt;
      refToUpdate.uploading = false;
    })
    .catch((e) => {
      const idx = references.value.findIndex((x) => x === refToUpdate);
      if (idx >= 0) {
        refToUpdate.uploading = false;
      }
      console.error("[webview] upload threw:", e);
      showToast(`参考素材上传异常: ${String(e?.message || e)}`);
    });
}

function removeReference(idx: number) {
  references.value.splice(idx, 1);
}

async function useAsReference(rec: GenerationRecord) {
  if (!rec.workFile) return;
  const kind = await bridge.detectFileKind(rec.workFile);
  if (!kind) {
    showToast("无法识别文件类型");
    return;
  }
  const r = await bridge.uploadExistingFileAsReference({
    localPath: rec.workFile,
    fileName: rec.workFile.split("/").pop() || "ref.bin",
    kind,
  });
  if (r.ok && r.reference) {
    references.value.push(r.reference);
  } else {
    showToast(`上传失败: ${r.error}`);
  }
}

async function submitGenerate() {
  if (!canSubmit.value || !apiKey.value) return;
  if (!projectInfo.value) {
    showToast("无活动 PR 项目，无法记录生成历史");
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const newRec: GenerationRecord = {
    id,
    createdAt: now,
    prompt: prompt.value,
    params: {
      model: model.value,
      ratio: ratio.value,
      duration: duration.value,
      resolution: resolution.value,
    },
    references: [...references.value],
    status: "pending",
    submittedAt: now,
  };
  records.value.unshift(newRec);
  prompt.value = "";

  try {
    const mini = new MiniMaxAPI(apiKey.value);
    const reqPayload = {
      model: model.value,
      prompt: newRec.prompt,
      ratio: ratio.value,
      duration: duration.value,
      resolution: resolution.value,
      references: newRec.references,
    };
    if (dryRun.value) {
      // 调试模式：仅打印请求，不实际发送
      const { task_id, payload } = await mini.createVideoDryRun(reqPayload);
      const idx = records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        records.value[idx] = {
          ...records.value[idx],
          taskId: task_id,
          status: "generating",
          // @ts-ignore
          dryRunPayload: payload,
        };
      }
      console.log(
        "[MiniMax dry-run] 已写入 record.taskId =",
        task_id,
        "（dry-run 不会真正创建任务，不会启动轮询）",
      );
    } else {
      // 实发模式
      const { task_id } = await mini.createVideo(reqPayload);
      const idx = records.value.findIndex((r) => r.id === id);
      if (idx >= 0) {
        records.value[idx] = {
          ...records.value[idx],
          taskId: task_id,
          status: "generating",
        };
      }
      resumePolling({ ...newRec, taskId: task_id, status: "generating" });
    }
  } catch (e: any) {
    const idx = records.value.findIndex((r) => r.id === id);
    if (idx >= 0) {
      records.value[idx] = {
        ...records.value[idx],
        status: "failed",
        error: toRecordError(e),
      };
    }
  }
}

async function importToProject(ids: string[]) {
  let r: any;
  try {
    r = await bridge.importToProject({ recordIds: ids });
  } catch (e: any) {
    console.error("[webview] importToProject bridge error:", e);
    showToast(`导入到工程失败（桥调用异常）: ${e?.message || e}`);
    return;
  }
  if (r.ok) {
    // 导入前生成结果已被移动到项目旁 Imports/，同步新路径到本地记录
    // （主进程已持久化 records.json，这里更新 UI 状态保持一致，深 watch 会自动落盘相同数据）
    if (r.moved?.length) {
      for (const m of r.moved) {
        const idx = records.value.findIndex((x) => x.id === m.recordId);
        if (idx >= 0 && records.value[idx].workFile !== m.newPath) {
          records.value[idx] = { ...records.value[idx], workFile: m.newPath };
        }
      }
    }
    const movedCount = r.moved?.length || 0;
    const totalCount = r.imported?.length || 0;
    showToast(
      movedCount > 0
        ? `已导入到 PR 项目 ${totalCount} 个视频（其中 ${movedCount} 个已从生成目录移动到 Imports/）`
        : `已导入到 PR 项目 ${totalCount} 个视频（文件已在 Imports/，无需重复移动）`,
    );
  } else {
    showToast(`导入到工程失败: ${r.error}`);
  }
}

async function deleteRecord(id: string) {
  records.value = records.value.filter((r) => r.id !== id);
}

/**
 * 像素提升：把已生成的 H3 768P 视频提交到 video_regeneration 升级为 2K
 * - 限制：仅 H3 模型 + 768P 可升级（H3-Max 不支持 / 2K 已为最高档）
 * - 实现：创建一条新 record（保留原 768P 不动），记录 parentTaskId + upgradedFromResolution
 * - 复用 resumePolling，等下载完成后再让用户选择导入到工程
 */
async function upgradeTo2K(rec: GenerationRecord) {
  if (!apiKey.value) {
    showToast("请先在设置里填写 API Key");
    return;
  }
  if (!rec.taskId) {
    showToast("原记录缺少 task_id，无法升级");
    return;
  }
  if (rec.status !== "generated" && rec.status !== "imported") {
    showToast("仅对已生成 / 已导入的视频可以升级");
    return;
  }
  if (rec.params.model !== "MiniMax-H3") {
    showToast("仅 H3 模型支持像素提升");
    return;
  }
  if (rec.params.resolution !== "768P") {
    showToast("仅 768P 分辨率可升级到 2K");
    return;
  }
  // 防重复：已经升级过（按 parentTaskId 查）
  const dup = records.value.find(
    (r) => r.parentTaskId === rec.taskId && r.status !== "failed",
  );
  if (dup) {
    showToast("该视频已存在升级任务，正在记录列表中");
    selectedRecordId.value = dup.id;
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const upgradeRec: GenerationRecord = {
    id,
    createdAt: now,
    prompt: rec.prompt,
    params: {
      model: "MiniMax-H3",
      ratio: rec.params.ratio,
      duration: rec.params.duration,
      resolution: "2K",
    },
    references: [...rec.references],
    status: "pending",
    submittedAt: now,
    parentTaskId: rec.taskId,
    upgradedFromResolution: "768P",
  };
  records.value.unshift(upgradeRec);

  try {
    const mini = new MiniMaxAPI(apiKey.value);
    const { task_id } = await mini.regenerateVideo({
      sourceTaskId: rec.taskId,
      resolution: "2K",
    });
    const idx = records.value.findIndex((r) => r.id === id);
    if (idx >= 0) {
      records.value[idx] = {
        ...records.value[idx],
        taskId: task_id,
        status: "generating",
      };
    }
    resumePolling({ ...upgradeRec, taskId: task_id, status: "generating" });
  } catch (e: any) {
    const idx = records.value.findIndex((r) => r.id === id);
    if (idx >= 0) {
      records.value[idx] = {
        ...records.value[idx],
        status: "failed",
        error: toRecordError(e),
      };
    }
  }
}

async function retryRecord(rec: GenerationRecord) {
  if (!apiKey.value) return;
  const idx = records.value.findIndex((r) => r.id === rec.id);
  if (idx < 0) return;
  // 以这条记录为底子：把 prompt / params / references 全部填回生成逻辑 UI
  prompt.value = rec.prompt;
  model.value = rec.params.model;
  ratio.value = rec.params.ratio;
  duration.value = rec.params.duration;
  resolution.value = rec.params.resolution;

  // 检查 reference file_id 过期，必要时重新上传拿新 file_id
  let newRefs = rec.references;
  if (newRefs.length > 0) {
    const refreshed: ReferenceItem[] = [];
    for (const ref of newRefs) {
      if (ref.fileId && ref.uploadedAt) {
        const age = Date.now() - new Date(ref.uploadedAt).getTime();
        if (age > 6 * 24 * 3600 * 1000) {
          const r = await bridge.reuploadReference({
            type: ref.type,
            localPath: ref.localPath,
            fileName: ref.fileName,
          });
          if (r.ok && r.fileId) {
            refreshed.push({
              ...ref,
              fileId: r.fileId,
              uploadedAt: new Date().toISOString(),
            });
          } else {
            refreshed.push(ref);
          }
        } else {
          refreshed.push(ref);
        }
      } else {
        refreshed.push(ref);
      }
    }
    newRefs = refreshed;
  }
  references.value = newRefs;

  // 不自动提交，让用户看着填好的 prompt + references 后手动点「生成」
  // 但把记录状态从 failed 还原成 pending，方便观察
  if (idx >= 0) {
    records.value[idx] = {
      ...records.value[idx],
      references: newRefs,
      status: records.value[idx].status === "failed" ? "pending" : records.value[idx].status,
    };
  }
  // 把焦点切到这条记录（提示词输入框自动滚动到视图中）
  selectedRecordId.value = rec.id;
  // 滚到顶部让用户看到 prompt 输入框
  const promptEl = document.querySelector(".prompt-section textarea");
  if (promptEl) (promptEl as HTMLTextAreaElement)?.focus?.();
}

/**
 * 提示词优化（h3_context_ir）
 * - 官方接口同步返回 content.prompt 字符串
 * - 限制：仅 H3 模型；prompt 非空；references 中若仍有未上传的 fileId 会被忽略
 * - 行为：成功时直接覆盖填入 prompt 输入框（不创建 record，不计费入库）
 * - ratio：与 createVideo 一致，无 references 时 'adaptive' 不合法，自动回退到 '16:9'
 */
async function optimizePrompt() {
  if (!apiKey.value) {
    showToast("请先在设置里填写 API Key");
    return;
  }
  if (!prompt.value.trim()) {
    showToast("请先填写提示词");
    return;
  }
  if (model.value !== "MiniMax-H3") {
    showToast("仅 H3 模型支持提示词优化");
    return;
  }
  if (optimizingPrompt.value) return;

  // 仅取已上传成功的 references（有 fileId 的）
  const validRefs = references.value.filter((r) => !!r.fileId);
  // 与 createVideo 保持一致：无 references 时 ratio=adaptive 不合法
  const ratioArg: MiniMaxRatio =
    validRefs.length === 0 && ratio.value === "adaptive" ? "16:9" : ratio.value;

  optimizingPrompt.value = true;
  try {
    const mini = new MiniMaxAPI(apiKey.value);
    const optimized = await mini.optimizePrompt({
      prompt: prompt.value,
      duration: duration.value,
      ratio: ratioArg,
      references: validRefs,
    });
    prompt.value = optimized;
    showToast("提示词已优化");
  } catch (e: any) {
    console.error("[webview] optimizePrompt failed:", e);
    showToast(`优化失败: ${e?.message || e}`);
  } finally {
    optimizingPrompt.value = false;
  }
}

const generatedCount = computed(() => records.value.filter((r) => r.status === "generated").length);

// ---------- 初始化 ----------
onMounted(async () => {
  apiKey.value = await bridge.getApiKey();
  // 获取项目信息
  const pi = await bridge.queryProjectState();
  if (pi.project) {
    projectInfo.value = pi.project;
    await loadRecords();
  }
});

onBeforeUnmount(() => {
  if (writeTimer) clearTimeout(writeTimer);
});

function onSettingsSave(key: string) {
  apiKey.value = key;
  settingsOpen.value = false;
}

// 默认实发（dry-run 仅调试用，可在设置面板开启；此前默认 true 会导致“正常生成”静默不发）
const dryRun = ref<boolean>(false);
function onDryRunChange(v: boolean) {
  dryRun.value = v;
}
</script>

<template>
  <div class="ai-panel-root">
    <!-- Header: 项目名 + 设置按钮 -->
    <header class="panel-header">
      <div class="project-name" v-if="projectInfo">
        {{ projectInfo.name || projectInfo.path.split(/[\\/]/).pop() }}
      </div>
      <div class="project-name muted" v-else>无活动项目</div>
      <button class="icon-btn" @click="settingsOpen = !settingsOpen" title="设置">
        ⚙
      </button>
    </header>

    <!-- Settings 折叠区 -->
    <SettingsPanel
      v-if="settingsOpen"
      :initial-key="apiKey || ''"
      :initial-dry-run="dryRun"
      @save="onSettingsSave"
      @update:dryRun="onDryRunChange"
    />

    <!-- 参考素材列表已并入浮动窗口 -->

    <!-- 生成中提示已合并到 RecordsPanel 大视频预览区 -->

    <!-- 生成记录区：左列缩略图（可滚动）+ 右列详情（生成中/失败/已生成） -->
    <RecordsPanel
      :records="records"
      :generating="generating"
      @select="(rec: GenerationRecord) => (selectedRecordId = rec.id)"
      @import-to-project="importToProject"
      @retry="retryRecord"
      @use-as-reference="useAsReference"
      @upgrade="upgradeTo2K"
    />

    <!-- 底部状态条 -->
    <footer class="panel-footer">
      <span class="muted">{{ records.length }} 条记录 · {{ generatedCount }} 条已生成</span>
      <span class="muted" v-if="storageMode === 'fallback'">⚠ 降级存储</span>
    </footer>

    <!-- 浮动窗口：参考素材 + 提示词 + 模型 + 参数按钮 + 生成按钮（贴底覆盖） -->
    <div class="floating-prompt-bar">
      <ReferenceList
        v-model:references="references"
        @add="addReference"
        @captureFrame="captureFrameAsReference"
        @captureVideo="captureVideoAsReference"
        @remove="removeReference"
      />
      <div class="prompt-divider"></div>
      <PromptInput
        v-model:prompt="prompt"
        v-model:model="model"
        v-model:ratio="ratio"
        v-model:duration="duration"
        v-model:resolution="resolution"
        :constraints="constraints"
        :has-references="references.length > 0"
        :can-submit="canSubmit"
        :polling="pollingActive"
        :has-api-key="!!apiKey"
        :has-project="!!projectInfo"
        :optimizing="optimizingPrompt"
        @submit="submitGenerate"
        @optimize="optimizePrompt"
      />
    </div>
    <div v-if="toastMsg" class="uxp-toast">{{ toastMsg }}</div>
  </div>
</template>

<style lang="scss">
@use "./index.scss" as *;

.ai-panel-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  font-size: 12px;
  background-color: var(--uxp-host-background-color, #2b2b2b);
  color: var(--uxp-host-text-color, #fff);
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  flex-shrink: 0;
  .project-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &.muted {
      opacity: 0.6;
    }
  }
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  &:hover {
    background: var(--uxp-host-widget-hover-background-color, #3d3d3d);
  }
}

.floating-prompt-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  padding: 6px 8px 8px;
  background: var(--uxp-host-background-color, #2b2b2b);
  border-top: 1px solid var(--uxp-host-border-color, #454545);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.25);
}

.prompt-divider {
  height: 1px;
  margin: 4px 0 4px;
  background: var(--uxp-host-border-color, #454545);
  opacity: 0.4;
}

.panel-footer {
  padding: 4px 8px;
  border-top: 1px solid var(--uxp-host-border-color, #454545);
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  flex-shrink: 0;
  .muted {
    opacity: 0.6;
  }
}

:root[data-theme="lightest"] {
  --bg-fallback: #f0f0f0;
  --text-fallback: #4b4b4b;
}
:root[data-theme="light"] {
  --bg-fallback: #b8b8b8;
  --text-fallback: #424242;
}
:root[data-theme="dark"] {
  --bg-fallback: #535353;
  --text-fallback: #fff;
}
:root[data-theme="darkest"] {
  --bg-fallback: #292929;
  --text-fallback: #fff;
}

button {
  font-family: inherit;
}
</style>