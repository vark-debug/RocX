/**
 * 任务轮询 composable（多任务并行）
 * - Map<taskId, poller> 结构：每个 taskId 一个独立定时器 / 独立连续失败计数 / 独立退避间隔
 * - start() 不会掐断其它任务；重复 start 同一 taskId 只重启它自己
 * - 5s 起始间隔（可按任务覆盖），连续失败按任务各自做指数退避
 * - 状态变化通过回调通知；终态（succeeded/failed/cancelled）或连续失败 6 次后结束该任务
 */
import { computed, onBeforeUnmount, shallowReactive } from "vue";
import { MiniMaxProvider } from "../providers/minimax";
import type { VideoGenQueryResponse } from "../providers/core/types";

export interface PollingOpts {
  taskId: string;
  apiKey: string;
  intervalMs?: number;
  onUpdate: (resp: VideoGenQueryResponse) => void;
  onTerminal: (resp: VideoGenQueryResponse | null, error?: Error) => void;
}

const POLL_INTERVAL = 5000;
const MAX_BACKOFF = 60000;

/** 单个任务的轮询状态：定时器与退避计数都按 taskId 独立保存 */
interface PollerState {
  timer: any;
  stopped: boolean;
  /** 当前退避后的间隔（ms），请求成功后重置为初始值 */
  interval: number;
  /** 连续失败次数 */
  consecutiveError: number;
}

export function usePolling() {
  // shallowReactive：让 set/delete 触发 computed 重算（普通 Map 变更不会被 Vue 追踪），
  // 且 shallow 保证 get() 返回原始 state 对象，identity 比较（!== state）才成立
  const pollers = shallowReactive(new Map<string, PollerState>());
  // 派生值：还有任意任务在轮询即为 active（Map 非空 ⇔ 存在活跃轮询）
  const active = computed(() => pollers.size > 0);

  /** 只停掉指定 taskId，不影响其它任务 */
  function stopOne(taskId: string) {
    const state = pollers.get(taskId);
    if (!state) return;
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    pollers.delete(taskId);
  }

  /** 停止全部任务（遍历中逐个从 map 移除） */
  function stop() {
    for (const taskId of Array.from(pollers.keys())) {
      stopOne(taskId);
    }
  }

  async function start(opts: PollingOpts) {
    // 同任务重复 start：只重启它自己，不动其它任务
    stopOne(opts.taskId);

    const state: PollerState = {
      timer: null,
      stopped: false,
      interval: opts.intervalMs ?? POLL_INTERVAL,
      consecutiveError: 0,
    };
    pollers.set(opts.taskId, state);

    const tick = async () => {
      // 只认自己的 state：既防被 stopOne 掐断，也防同 taskId 重新 start 后旧 tick 复活
      if (state.stopped || pollers.get(opts.taskId) !== state) return;
      const api = new MiniMaxProvider();
      try {
        const resp = await api.queryTask(opts.taskId, opts.apiKey);
        state.consecutiveError = 0;
        state.interval = opts.intervalMs ?? POLL_INTERVAL;
        opts.onUpdate(resp);
        if (resp.status === "succeeded" || resp.status === "failed" || resp.status === "cancelled") {
          stopOne(opts.taskId);
          opts.onTerminal(resp);
          return;
        }
      } catch (e: any) {
        state.consecutiveError++;
        state.interval = Math.min(state.interval * 2, MAX_BACKOFF);
        if (state.consecutiveError >= 6) {
          stopOne(opts.taskId);
          opts.onTerminal(null, e);
          return;
        }
      }
      if (state.stopped) return;
      state.timer = setTimeout(tick, state.interval);
    };

    // 第一次立即查一次
    await tick();
  }

  onBeforeUnmount(() => {
    // 组件卸载：清掉所有残留定时器
    stop();
  });

  return { active, start, stop, stopOne };
}
