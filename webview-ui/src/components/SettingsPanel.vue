<script setup lang="ts">
import { ref } from "vue";
import { bridge } from "../services/bridge";

declare const __ROCX_DEV__: boolean;

const props = defineProps<{
  initialKey: string;
}>();
const emit = defineEmits<{
  save: [string];
}>();

const apiKey = ref(props.initialKey);
const saving = ref(false);
const message = ref("");

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

// ---------- 仅 DEV 模式可见的调试工具 ----------
// 通过 __ROCX_DEV__ 构建时常量控制：MODE=dev 时为 true，build/zip 时为 false，
// 整段 if (false) 块被 esbuild 静态消除，连带 MiniMaxAPI import 在 ccx 中不再出现。
if (__ROCX_DEV__) {
  // 延迟引入，避免非 dev 模式加载
  import("../services/MiniMax").then(({ MiniMaxAPI }) => {
    attachDebugHandlers(MiniMaxAPI);
  });
}

function attachDebugHandlers(MiniMaxAPI: any) {
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
      const api = new MiniMaxAPI(apiKey.value.trim());
      const resp = await api.queryTask(taskId);
      if (r) r.textContent = JSON.stringify(resp, null, 2);
    } catch (e: any) {
      if (r) r.textContent = `异常: ${String(e?.message || e)}`;
    }
  };
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
