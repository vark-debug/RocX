<script setup lang="ts">
import { ref } from "vue";
import { bridge } from "../services/bridge";
import { MiniMaxAPI } from "../services/MiniMax";

const props = defineProps<{
  initialKey: string;
  initialDryRun?: boolean;
}>();
const emit = defineEmits<{
  save: [string];
  "update:dryRun": [boolean];
}>();

const apiKey = ref(props.initialKey);
const saving = ref(false);
const message = ref("");
const dryRun = ref(props.initialDryRun ?? true);

// 调试：MiniMax 任务查询
const debugTaskId = ref("");
const debugResult = ref("");
const debugLoading = ref(false);

// 调试：MiniMax 文件上传
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploadResult = ref("");
const uploadLoading = ref(false);
const uploadFileName = ref("");

async function save() {
  saving.value = true;
  message.value = "";
  const r = await bridge.setApiKey(apiKey.value);
  saving.value = false;
  if (r.ok) {
    message.value = "✓ 已保存";
    emit("save", apiKey.value);
  } else {
    message.value = `保存失败: ${r.error}`;
  }
}

async function queryTask() {
  if (!apiKey.value.trim()) {
    debugResult.value = "错误: API Key 为空";
    return;
  }
  if (!debugTaskId.value.trim()) {
    debugResult.value = "错误: task_id 为空";
    return;
  }
  debugLoading.value = true;
  debugResult.value = "查询中...";
  try {
    const mini = new MiniMaxAPI(apiKey.value.trim());
    const resp = await mini.queryTask(debugTaskId.value.trim());
    debugResult.value = JSON.stringify(resp, null, 2);
  } catch (e: any) {
    debugResult.value = `异常: ${String(e?.message || e)}`;
  }
  debugLoading.value = false;
}

/**
 * 调试：直接用 task_id 拉取并下载视频到 plugin-data 目录
 * 完整链路：queryTask → 拿 content.url → bridge.downloadFile → 落盘
 */
async function downloadByTaskId() {
  if (!apiKey.value.trim()) {
    debugResult.value = "错误: API Key 为空";
    return;
  }
  if (!debugTaskId.value.trim()) {
    debugResult.value = "错误: task_id 为空";
    return;
  }
  debugLoading.value = true;
  const taskId = debugTaskId.value.trim();
  debugResult.value = `查询任务 ${taskId}...`;
  try {
    const mini = new MiniMaxAPI(apiKey.value.trim());
    const resp = await mini.queryTask(taskId);
    const status = resp?.status;
    const url = resp?.content?.url;
    if (status !== "succeeded") {
      debugResult.value = JSON.stringify({
        task_id: taskId,
        status,
        error: resp?.error || "任务未完成，无法下载",
      }, null, 2);
      return;
    }
    if (!url) {
      debugResult.value = "任务 succeeded 但 content.url 为空";
      return;
    }
    debugResult.value = `任务 succeeded。开始下载到 plugin-data 目录...\nURL: ${url}`;
    const fileName = `${taskId}.mp4`;
    const dl = await bridge.downloadFile({
      url,
      suggestedName: fileName,
      recordId: `debug-${taskId}`,
    });
    if (dl.ok && dl.localPath) {
      debugResult.value =
        `下载成功 ✓\n` +
        `本地路径：${dl.localPath}\n` +
        `字节：未知（可打开 Finder 查看）\n\n` +
        `完整响应：\n${JSON.stringify(resp, null, 2)}`;
    } else {
      debugResult.value =
        `下载失败：${dl.error}\n\n` +
        `注：检查 manifest 网络白名单是否包含 CDN 域名\n` +
        `（MiniMax 实际 CDN：algeng-video-infer.oss-cn-shanghai.aliyuncs.com）`;
    }
  } catch (e: any) {
    debugResult.value = `异常: ${String(e?.message || e)}`;
  }
  debugLoading.value = false;
}

function pickUploadFile() {
  if (!apiKey.value.trim()) {
    uploadResult.value = "错误: API Key 为空";
    return;
  }
  uploadResult.value = "";
  uploadFileName.value = "";
  fileInputRef.value?.click();
}

const workDirPath = ref("");
const openDirLoading = ref(false);
async function loadWorkDirPath() {
  workDirPath.value = "";
  try {
    const r = await bridge.ensureWorkDir();
    if (r.ok) workDirPath.value = r.nativePath;
  } catch (_) {}
}
loadWorkDirPath();

async function openWorkDir() {
  openDirLoading.value = true;
  const r = await bridge.openWorkDir();
  openDirLoading.value = false;
  if (!r.ok) alert(`打开失败: ${r.error}`);
}

async function onUploadFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploadLoading.value = true;
  uploadFileName.value = file.name;
  uploadResult.value = `上传中... (${file.name}, ${(file.size / 1024 / 1024).toFixed(2)} MB)`;

  // 构造请求（与官方示例一致）
  const url = "https://api.minimax.cn/v1/files/upload";
  const form = new FormData();
  form.append("purpose", "video_generation_input");
  form.append("file", file);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.value.trim()}`,
  };

  console.log(
    "%c[MiniMax upload DRY-RUN]",
    "color:#4b9cf5;font-weight:bold",
  );
  console.log("URL:", url);
  console.log("Method:", "POST");
  console.log("Headers:", JSON.stringify(headers, null, 2));
  console.log(
    "FormData entries:",
    Array.from(form.entries()).map(([k, v]) => ({
      key: k,
      value: v instanceof File ? `<File ${v.name} ${v.size}B>` : v,
    })),
  );

  try {
    const resp = await fetch(url, { method: "POST", headers, body: form });
    const text = await resp.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    console.log(
      `[MiniMax upload] → HTTP ${resp.status}  Content-Type=${resp.headers.get("content-type")}`,
    );
    console.log(`[MiniMax upload] 响应原文: ${text}`);
    if (json) console.log(`[MiniMax upload] 响应 JSON:`, json);

    uploadResult.value =
      `HTTP ${resp.status}\n\n` +
      (json ? JSON.stringify(json, null, 2) : text);
  } catch (err: any) {
    console.error("[MiniMax upload] 异常:", err);
    uploadResult.value = `异常: ${String(err?.message || err)}`;
  }
  uploadLoading.value = false;
  // 清空 input，允许重复选同一文件
  input.value = "";
}

function onDryRunChange(e: Event) {
  const v = (e.target as HTMLInputElement).checked;
  dryRun.value = v;
  emit("update:dryRun", v);
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-row">
      <label class="label">MiniMax API Key</label>
      <input
        v-model="apiKey"
        type="password"
        placeholder="sk-..."
        class="input"
      />
      <button @click="save" :disabled="saving" class="save-btn">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
    <div v-if="message" class="message">{{ message }}</div>

    <!-- 调试/实发 切换 -->
    <div class="toggle-row">
      <label class="toggle-label">
        <input
          type="checkbox"
          :checked="dryRun"
          @change="onDryRunChange"
        />
        <span>Dry-Run 模式（只打印请求到 UDT，不实际调用）</span>
      </label>
    </div>

    <!-- 生成工作目录 -->
    <div class="workdir-row">
      <div class="workdir-label">生成工作目录</div>
      <div class="workdir-path" :title="workDirPath">{{ workDirPath || '<加载中>' }}</div>
      <button
        @click="openWorkDir"
        :disabled="openDirLoading"
        class="save-btn"
      >
        {{ openDirLoading ? '打开中...' : '打开' }}
      </button>
    </div>

    <!-- 调试：MiniMax 任务查询 / 下载 -->
    <details class="debug-block">
      <summary class="debug-title">🛠 调试工具：查询 / 下载 MiniMax 任务结果</summary>
      <div class="debug-row">
        <input
          v-model="debugTaskId"
          placeholder="task_id (如 444809271464354)"
          class="input debug-input"
        />
        <button
          @click="queryTask"
          :disabled="debugLoading"
          class="save-btn"
        >
          {{ debugLoading ? '查询中...' : '查询' }}
        </button>
        <button
          @click="downloadByTaskId"
          :disabled="debugLoading"
          class="save-btn"
          title="直接用 task_id 查询并下载到 plugin-data 目录"
        >
          {{ debugLoading ? '下载中...' : '下载' }}
        </button>
      </div>
      <pre v-if="debugResult" class="debug-output">{{ debugResult }}</pre>
    </details>

    <!-- 调试：MiniMax 文件上传 -->
    <details class="debug-block">
      <summary class="debug-title">🛠 调试工具：上传参考素材到 MiniMax</summary>
      <div class="debug-row">
        <button
          @click="pickUploadFile"
          :disabled="uploadLoading"
          class="save-btn"
        >
          {{ uploadLoading ? '上传中...' : '选择文件并上传' }}
        </button>
        <span v-if="uploadFileName" class="upload-name">{{ uploadFileName }}</span>
        <input
          ref="fileInputRef"
          type="file"
          accept="video/*,audio/*,image/*"
          style="display:none"
          @change="onUploadFileChange"
        />
      </div>
      <pre v-if="uploadResult" class="debug-output">{{ uploadResult }}</pre>
    </details>
  </section>
</template>

<style lang="scss" scoped>
.settings-section {
  padding: 6px 8px;
  background: var(--uxp-host-border-color, #383838);
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  flex-shrink: 0;
}

.settings-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.label {
  font-size: 11px;
  flex: 0 0 auto;
}

.input {
  flex: 1;
  padding: 3px 6px;
  font-size: 11px;
  background: var(--uxp-host-background-color, #2b2b2b);
  color: inherit;
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 3px;
  font-family: inherit;
}

.save-btn {
  padding: 3px 8px;
  font-size: 11px;
  background: var(--uxp-host-link-text-color, #4b9cf5);
  color: #fff;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
  }
}

.message {
  font-size: 10px;
  margin-top: 2px;
  color: var(--uxp-host-link-text-color, #4b9cf5);
}

.toggle-row {
  margin-top: 4px;
  font-size: 11px;
}

.workdir-row {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workdir-label {
  font-size: 11px;
  opacity: 0.8;
}

.workdir-path {
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
  opacity: 0.65;
  padding: 2px 4px;
  background: var(--uxp-host-background-color, #2b2b2b);
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  input {
    cursor: pointer;
  }
}

.debug-block {
  margin-top: 6px;
  font-size: 11px;
}

.debug-title {
  cursor: pointer;
  padding: 2px 0;
  user-select: none;
  opacity: 0.85;
}

.debug-row {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 4px;
}

.debug-input {
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
}

.upload-name {
  flex: 1;
  font-size: 10px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debug-output {
  margin-top: 4px;
  padding: 4px 6px;
  background: var(--uxp-host-background-color, #1f1f1f);
  color: var(--uxp-host-text-color, #e6e6e6);
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 3px;
  font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 10px;
  line-height: 1.4;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>