<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { bridge } from "../services/bridge";
import {
  usePromptTemplates,
  PROMPT_TEMPLATES_MAX,
} from "../composables/usePromptTemplates";
import {
  klingEnv,
  loadKlingModels,
  refreshKlingAccount,
  restoreKlingEnvSnapshot,
  KLING_LOW_CREDITS_THRESHOLD,
} from "../providers/kling";

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

// ---------- 可灵 CLI 环境自检 ----------
const klingChecking = ref(false);

/** 余额是否为 0（提交必然被服务端拒绝） */
const klingNoCredits = computed(
  () => typeof klingEnv.value.credits === "number" && klingEnv.value.credits <= 0,
);

/** 余额是否低于告警阈值（够不够做几次最便宜的任务） */
const klingLowCredits = computed(
  () =>
    typeof klingEnv.value.credits === "number" &&
    klingEnv.value.credits < KLING_LOW_CREDITS_THRESHOLD,
);

/**
 * 上次检测时间的可读文本。
 *
 * 快照是持久化的，所以这个时间可能来自上一次启动 —— 用户需要知道
 * 显示的余额是什么时候测的。
 */
const klingCheckedAtText = computed(() => {
  const raw = klingEnv.value.checkedAt;
  if (!raw) return "";
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
});

/**
 * 重新检测可灵环境：模型清单（who_am_i）+ 账户信息（account）。
 *
 * 清单是**服务端动态下发**的，模型上新 / 下架只有这里能看出来；
 * 余额每次提交都会变，所以也一并刷新。
 */
async function checkKlingEnv(force = false) {
  if (klingChecking.value) return;
  klingChecking.value = true;
  try {
    const ok = await loadKlingModels(force ? { force: true } : undefined);
    if (ok) await refreshKlingAccount();
  } finally {
    klingChecking.value = false;
  }
}

onMounted(async () => {
  // 已有环境状态（启动时 bootstrapKlingEnv 已跑过）→ 直接显示，不重复检测
  if (klingEnv.value.checkedAt) return;
  // 全新安装 / 尚未检测过：先读持久化快照（有就秒显），再跑真实检测
  await restoreKlingEnvSnapshot();
  void checkKlingEnv();
});

// ---------- 提示词模板管理（"/" 触发；自定义上限 10 条） ----------
const {
  customTemplates,
  ensureLoaded,
  addCustomTemplate,
  removeCustomTemplate,
} = usePromptTemplates();
const tplLabel = ref("");
const tplTemplate = ref("");
const tplScope = ref<"video" | "image" | "both">("both");
const tplMessage = ref("");

const tplAddDisabled = computed(
  () =>
    customTemplates.value.length >= PROMPT_TEMPLATES_MAX ||
    !tplLabel.value.trim() ||
    !tplTemplate.value.trim(),
);

function addTemplate() {
  if (tplAddDisabled.value) return;
  const ok = addCustomTemplate({
    label: tplLabel.value.trim(),
    template: tplTemplate.value,
    scope: tplScope.value,
  });
  tplMessage.value = ok ? "✓ 已添加" : "添加失败（已达上限）";
  if (ok) {
    tplLabel.value = "";
    tplTemplate.value = "";
  }
}

function deleteTemplate(id: string) {
  removeCustomTemplate(id);
  tplMessage.value = "✓ 已删除";
}

onMounted(() => void ensureLoaded());

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

    <!-- 可灵 CLI 环境自检：装没装 / 登没登 / 还有多少灵感值 / 服务端给了哪些模型 -->
    <div class="feishu-block">
      <div class="feishu-title">可灵 CLI 环境</div>
      <div class="kling-status">
        <div class="kling-row">
          <span class="kling-k">状态</span>
          <span class="kling-v" :class="klingEnv.ready ? 'ok' : 'bad'">
            {{ klingEnv.ready ? '已就绪' : '未就绪' }}
          </span>
        </div>
        <div v-if="klingEnv.membershipType" class="kling-row">
          <span class="kling-k">会员</span>
          <span class="kling-v">
            {{ klingEnv.membershipDescription || klingEnv.membershipType }}
          </span>
        </div>
        <div v-if="klingEnv.credits !== undefined" class="kling-row">
          <span class="kling-k">灵感值余额</span>
          <span class="kling-v" :class="klingNoCredits ? 'bad' : klingLowCredits ? 'warn' : ''">
            {{ klingEnv.credits }}
          </span>
        </div>
        <div v-if="klingEnv.modelCount !== undefined" class="kling-row">
          <span class="kling-k">可用模型</span>
          <span class="kling-v">{{ klingEnv.modelCount }} 个</span>
        </div>
        <div v-if="klingEnv.checkedAt" class="kling-row">
          <span class="kling-k">上次检测</span>
          <span class="kling-v">{{ klingCheckedAtText }}</span>
        </div>
      </div>
      <!-- 未就绪原因：可灵未装 CLI / 未登录 / 清单拉取失败 -->
      <div v-if="!klingEnv.ready && klingEnv.message" class="kling-warn">
        {{ klingEnv.message }}
      </div>
      <!-- 余额不足：充值链接由服务端在错误文本里下发，不硬编码 -->
      <div v-if="klingLowCredits" class="kling-warn">
        {{
          klingNoCredits
            ? "灵感值已用尽，无法提交生成任务。"
            : `灵感值偏低（低于 ${KLING_LOW_CREDITS_THRESHOLD}），可能不足以完成一次生成。`
        }}
        <a
          v-if="klingEnv.rechargeUrl"
          :href="klingEnv.rechargeUrl"
          target="_blank"
          rel="noreferrer"
          >去充值</a
        >
        <span v-else class="kling-warn-hint">
          （充值入口由可灵服务端下发，提交一次后即可显示）
        </span>
      </div>
      <div class="settings-row">
        <button
          @click="checkKlingEnv(true)"
          :disabled="klingChecking"
          class="test-btn"
        >
          {{ klingChecking ? '检测中...' : '重新检测' }}
        </button>
      </div>
    </div>

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

    <!-- 提示词模板管理：输入 "/" 唤起；自定义上限 10 条 -->
    <div class="feishu-block">
      <div class="feishu-title">
        提示词模板
        <span class="tpl-count">{{ customTemplates.length }}/{{ PROMPT_TEMPLATES_MAX }}</span>
      </div>
      <div class="tpl-syntax-hint">
        语法：「甲或乙」视频模式取甲、图片模式取乙；{xxx} 插入后光标定位到该处并全选 xxx
      </div>
      <div v-if="customTemplates.length" class="tpl-list">
        <div v-for="t in customTemplates" :key="t.id" class="tpl-row">
          <span class="tpl-row-label">{{ t.label }}</span>
          <span class="tpl-row-scope">{{ t.scope === 'video' ? '视频' : t.scope === 'image' ? '图片' : '通用' }}</span>
          <span class="tpl-row-text">{{ t.template }}</span>
          <button class="tpl-del-btn" type="button" @click="deleteTemplate(t.id)">删除</button>
        </div>
      </div>
      <div v-else class="tpl-syntax-hint">暂无自定义模板</div>
      <div class="settings-row">
        <input v-model="tplLabel" type="text" placeholder="名称（如：移除物品）" class="input tpl-input-label" />
        <select v-model="tplScope" class="input tpl-scope-select">
          <option value="both">通用</option>
          <option value="video">视频</option>
          <option value="image">图片</option>
        </select>
      </div>
      <div class="settings-row">
        <input
          v-model="tplTemplate"
          type="text"
          placeholder="模板内容，如：请移除「视频或图片」中的{某个物品}"
          class="input"
        />
        <button @click="addTemplate" :disabled="tplAddDisabled" class="save-btn">添加</button>
      </div>
      <div v-if="tplMessage" class="message">{{ tplMessage }}</div>
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

/* 可灵 CLI 环境自检 */
.kling-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kling-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10px;
}

.kling-k {
  flex: 0 0 auto;
  min-width: 56px;
  opacity: 0.6;
}

.kling-v {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  &.ok {
    color: #6bcf7f;
  }
  &.warn {
    color: #ffcc66;
  }
  &.bad {
    color: #ff9f6b;
  }
}

.kling-warn {
  font-size: 10px;
  line-height: 1.4;
  color: #ff9f6b;
  word-break: break-all;
  a {
    color: var(--uxp-host-link-text-color, #4b9cf5);
  }
}

/* 提示词模板管理 */
.tpl-count {
  font-weight: 400;
  font-size: 10px;
  opacity: 0.6;
  margin-left: 4px;
}

.tpl-syntax-hint {
  font-size: 10px;
  line-height: 1.4;
  opacity: 0.6;
}

.tpl-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tpl-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 2px 4px;
  background: var(--uxp-host-background-color, #2b2b2b);
  border-radius: 3px;
}

.tpl-row-label {
  flex: 0 0 auto;
  font-weight: 500;
  color: var(--uxp-host-link-text-color, #4b9cf5);
}

.tpl-row-scope {
  flex: 0 0 auto;
  padding: 0 4px;
  opacity: 0.7;
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 2px;
}

.tpl-row-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.tpl-del-btn {
  flex: 0 0 auto;
  padding: 1px 5px;
  font-size: 10px;
  background: transparent;
  color: var(--uxp-host-text-color-secondary, #b0b0b0);
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 3px;
  cursor: pointer;
  &:hover {
    color: #ff6b6b;
    border-color: #ff6b6b;
  }
}

.tpl-input-label {
  flex: 0 0 38%;
}

.tpl-scope-select {
  flex: 0 0 auto;
  width: auto;
  padding: 3px 4px;
  font-size: 11px;
  background: var(--uxp-host-background-color, #2b2b2b);
  color: inherit;
  border: 1px solid var(--uxp-host-border-color, #454545);
  border-radius: 3px;
  font-family: inherit;
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
