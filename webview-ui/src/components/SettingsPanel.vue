<script setup lang="ts">
import { ref, onMounted } from "vue";
import { bridge } from "../services/bridge";

declare const __ROCX_DEV__: boolean;

const props = defineProps<{
  initialKey: string;
  /** 初始选中的 provider id（当前视频 provider） */
  initialProviderId?: string;
}>();
const emit = defineEmits<{
  save: [string, string];
}>();

/** 可配置 key 的 provider 列表（视频 + 图片） */
const KEY_PROVIDERS = [
  { id: "minimax", label: "MiniMax" },
  { id: "runninghub", label: "RunningHub" },
  { id: "ark", label: "火山方舟" },
] as const;

const providerId = ref<string>(props.initialProviderId || "minimax");
const apiKey = ref(props.initialKey);
const saving = ref(false);
const message = ref("");

/** 切换 provider：加载该 provider 已存的 key（无则清空输入框） */
async function switchProvider(id: string) {
  if (id === providerId.value) return;
  providerId.value = id;
  message.value = "";
  try {
    apiKey.value = (await bridge.getApiKey(id)) || "";
  } catch {
    apiKey.value = "";
  }
}

// ---------- 飞书多维表格联动 ----------
const feishuUrl = ref("");
const feishuToken = ref("");
const editorName = ref("");
const feishuSaving = ref(false);
const feishuMessage = ref("");
const feishuTesting = ref(false);

/** 用固定样例打一次 webhook，验证地址 / 令牌 / 表格字段映射 */
async function testFeishu() {
  feishuTesting.value = true;
  feishuMessage.value = "";
  try {
    const r = await bridge.testFeishuReport();
    feishuMessage.value = r.ok
      ? "✓ 测试上报成功，请去飞书表格查看新增行"
      : `测试失败: ${r.error}`;
  } catch (e: any) {
    feishuMessage.value = `测试失败（桥调用异常）: ${e?.message || e}`;
  } finally {
    feishuTesting.value = false;
  }
}

onMounted(async () => {
  try {
    const cfg = await bridge.getFeishuConfig();
    feishuUrl.value = cfg.webhookUrl;
    feishuToken.value = cfg.token;
    editorName.value = cfg.editorName;
  } catch (e: any) {
    feishuMessage.value = `读取失败: ${e?.message || e}`;
  }
});

async function saveFeishu() {
  feishuSaving.value = true;
  feishuMessage.value = "";
  const r = await bridge.setFeishuConfig({
    webhookUrl: feishuUrl.value,
    token: feishuToken.value,
    editorName: editorName.value,
  });
  feishuSaving.value = false;
  feishuMessage.value = r.ok ? "✓ 已保存" : `保存失败: ${r.error}`;
}

async function save() {
  saving.value = true;
  message.value = "";
  const r = await bridge.setApiKey(apiKey.value, providerId.value);
  saving.value = false;
  if (r.ok) {
    message.value = "✓ 已保存";
    emit("save", apiKey.value, providerId.value);
  } else {
    message.value = `保存失败: ${r.error}`;
  }
}

// ---------- 仅 DEV 模式可见的调试工具 ----------
// 通过 __ROCX_DEV__ 构建时常量控制：MODE=dev 时为 true，build/zip 时为 false，
// 整段 if (false) 块被 esbuild 静态消除，连带 MiniMaxProvider import 在 ccx 中不再出现。
if (__ROCX_DEV__) {
  // 延迟引入，避免非 dev 模式加载
  import("../providers/minimax").then(({ MiniMaxProvider }) => {
    attachDebugHandlers(MiniMaxProvider);
  });
}

function attachDebugHandlers(MiniMaxProvider: any) {
  // 通过全局函数挂载调试入口（保持模板的 @click 绑定无需变）
  ;(window as any).__rocx_debug_queryTask = async () => {
    const taskId = (document.querySelector(".debug-input") as HTMLInputElement)?.value?.trim();
    const r = (document.querySelector(".debug-output") as HTMLElement);
    if (!taskId) {
      if (r) r.textContent = "错误: task_id 为空";
      return;
    }
    if (r) r.textContent = "查询中...";
    try {
      const api = new MiniMaxProvider();
      const resp = await api.queryTask(taskId, apiKey.value.trim());
      if (r) r.textContent = JSON.stringify(resp, null, 2);
    } catch (e: any) {
      if (r) r.textContent = `异常: ${String(e?.message || e)}`;
    }
  };
}
</script>

<template>
  <section class="settings-section">
    <!-- API Key：按 provider 切换存储（MiniMax = 视频生成 / RunningHub = 图片生成） -->
    <div class="settings-row">
      <label class="label">API Key</label>
      <div class="provider-tabs">
        <button
          v-for="p in KEY_PROVIDERS"
          :key="p.id"
          type="button"
          class="provider-tab"
          :class="{ active: providerId === p.id }"
          @click="switchProvider(p.id)"
        >{{ p.label }}</button>
      </div>
    </div>
    <div class="settings-row">
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

    <!-- 飞书多维表格联动：生成成功后自动上报 -->
    <div class="feishu-block">
      <div class="feishu-title">飞书多维表格联动</div>
      <div class="settings-row">
        <label class="label">Webhook 地址</label>
        <input
          v-model="feishuUrl"
          type="text"
          placeholder="https://xxx.feishu.cn/base/workflow/webhook/event/..."
          class="input"
        />
      </div>
      <div class="settings-row">
        <label class="label">Bearer Token</label>
        <input
          v-model="feishuToken"
          type="password"
          placeholder="开启凭证校验后填写（强烈建议开启）"
          class="input"
        />
      </div>
      <div class="settings-row">
        <label class="label">剪辑师</label>
        <input
          v-model="editorName"
          type="text"
          placeholder="你的名字"
          class="input"
        />
        <button @click="saveFeishu" :disabled="feishuSaving" class="save-btn">
          {{ feishuSaving ? '保存中...' : '保存' }}
        </button>
      </div>
      <div class="settings-row">
        <button
          @click="testFeishu"
          :disabled="feishuTesting"
          class="test-btn"
        >
          {{ feishuTesting ? '上报中...' : '测试上报' }}
        </button>
      </div>
      <div v-if="feishuMessage" class="message">{{ feishuMessage }}</div>
    </div>

    <!-- DEV：生成工作目录与调试工具仅 dev 模式可见 -->
    <template v-if="__ROCX_DEV__">
      <div class="workdir-row">
        <div class="workdir-label">生成工作目录</div>
        <div class="workdir-path"><em>（开发模式：在 UDT 控制台查看 workDirPath / 调用 openWorkDir）</em></div>
      </div>

      <details class="debug-block">
        <summary class="debug-title">🛠 调试工具：仅 dev 模式可见</summary>
        <div class="debug-msg">
          调试工具已迁移到 UDT 控制台：在 UXP Developer Tool 中打开本插件的 webview 面板，
          可直接调用 <code>__rocx_debug_*</code> 全局方法，或参考源码
          <code>src/components/SettingsPanel.vue</code> 旧版本手动恢复。
        </div>
      </details>
    </template>
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
  & + .settings-row {
    margin-top: 4px;
  }
}

.provider-tabs {
  display: flex;
  gap: 2px;
}

.provider-tab {
  padding: 2px 8px;
  font-size: 10px;
  font-family: inherit;
  background: var(--uxp-host-background-color, #2b2b2b);
  color: var(--uxp-host-text-color-secondary, #b0b0b0);
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  &:hover {
    color: var(--uxp-host-text-color, #fff);
  }
  &.active {
    color: var(--uxp-host-link-text-color, #4b9cf5);
    border-color: var(--uxp-host-link-text-color, #4b9cf5);
    background: rgba(75, 156, 245, 0.12);
  }
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

// 区分主操作：测试上报用描边按钮，避免与「保存」抢视觉焦点
.test-btn {
  padding: 3px 8px;
  font-size: 11px;
  background: transparent;
  color: var(--uxp-host-link-text-color, #4b9cf5);
  border: 1px solid var(--uxp-host-border-color, #454545);
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

.feishu-block {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--uxp-host-border-color, #454545);
  display: flex;
  flex-direction: column;
  gap: 4px;

  .feishu-title {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.85;
  }
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
  em {
    font-style: normal;
    opacity: 0.7;
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

.debug-msg {
  margin-top: 4px;
  padding: 4px 6px;
  background: var(--uxp-host-background-color, #1f1f1f);
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 3px;
  font-size: 10px;
  line-height: 1.4;
  opacity: 0.85;

  code {
    font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
    background: rgba(255, 255, 255, 0.06);
    padding: 0 3px;
    border-radius: 2px;
  }
}
</style>
