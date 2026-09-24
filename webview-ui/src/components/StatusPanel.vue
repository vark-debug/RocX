<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import type { GenerationRecord } from "../services/messages";

const props = defineProps<{
  generating: GenerationRecord | null;
  polling: boolean;
}>();

const now = ref(Date.now());
let timer: any = null;

function startTimer() {
  if (timer) clearInterval(timer);
  if (!props.generating) return;
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

onMounted(() => {
  if (props.generating) startTimer();
});
onBeforeUnmount(stopTimer);
watch(
  () => props.generating,
  (g) => {
    if (g) startTimer();
    else stopTimer();
  },
);

const elapsed = computed(() => {
  if (!props.generating?.submittedAt) return "";
  void now.value;
  const ms = Date.now() - new Date(props.generating.submittedAt).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
});
</script>

<template>
  <section v-if="generating" class="status-section">
    <div class="status-row">
      <span class="status-label">生成中</span>
      <span class="status-elapsed">{{ elapsed }}</span>
    </div>
    <div class="status-prompt">{{ generating.prompt.slice(0, 40) }}{{ generating.prompt.length > 40 ? '...' : '' }}</div>
    <div class="status-bar">
      <div class="status-bar-fill" />
    </div>
  </section>
</template>

<style lang="scss" scoped>
.status-section {
  padding: 4px 8px;
  border-bottom: 1px solid var(--uxp-host-border-color, #454545);
  background: var(--uxp-host-border-color, #383838);
  flex-shrink: 0;
}

.status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  .status-label {
    font-weight: 500;
  }
  .status-elapsed {
    opacity: 0.7;
  }
}

.status-prompt {
  font-size: 11px;
  opacity: 0.7;
  margin: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-bar {
  height: 2px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 1px;
  overflow: hidden;
  margin-top: 2px;
}

.status-bar-fill {
  height: 100%;
  width: 100%;
  background: var(--uxp-host-link-text-color, #4b9cf5);
  animation: indeterminate 1.5s infinite ease-in-out;
}

@keyframes indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
</style>