/**
 * 任务轮询 composable
 * - 5s 间隔，连续失败做退避
 * - 状态变化通过回调通知
 * - 失败/取消时终止
 */
import { ref, onBeforeUnmount } from "vue";
import { MiniMaxAPI } from "../services/MiniMax";
import type { MiniMaxQueryResponse } from "@shared/messages";

export interface PollingOpts {
  taskId: string;
  apiKey: string;
  intervalMs?: number;
  onUpdate: (resp: MiniMaxQueryResponse) => void;
  onTerminal: (resp: MiniMaxQueryResponse | null, error?: Error) => void;
}

const POLL_INTERVAL = 5000;
const MAX_BACKOFF = 60000;

export function usePolling() {
  const active = ref(false);
  let timer: any = null;
  let currentKey = "";

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    active.value = false;
    currentKey = "";
  }

  async function start(opts: PollingOpts) {
    stop();
    currentKey = opts.taskId;
    active.value = true;
    let interval = opts.intervalMs ?? POLL_INTERVAL;
    let consecutiveError = 0;

    const tick = async () => {
      if (!active.value || currentKey !== opts.taskId) return;
      const api = new MiniMaxAPI(opts.apiKey);
      try {
        const resp = await api.queryTask(opts.taskId);
        consecutiveError = 0;
        interval = opts.intervalMs ?? POLL_INTERVAL;
        opts.onUpdate(resp);
        if (resp.status === "succeeded" || resp.status === "failed" || resp.status === "cancelled") {
          active.value = false;
          opts.onTerminal(resp);
          return;
        }
      } catch (e: any) {
        consecutiveError++;
        interval = Math.min(interval * 2, MAX_BACKOFF);
        if (consecutiveError >= 6) {
          active.value = false;
          opts.onTerminal(null, e);
          return;
        }
      }
      timer = setTimeout(tick, interval);
    };

    // 第一次立即查一次
    await tick();
  }

  onBeforeUnmount(() => stop());

  return { active, start, stop };
}