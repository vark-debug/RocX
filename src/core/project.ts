/**
 * 项目状态 / 切换监听
 */
import { premierepro } from "../globals";
import type { Project } from "@adobe/premierepro";

let cachedProjectGuid: string | null = null;
let cachedProjectPath: string | null = null;
let listeners: Array<(p: { path: string; guid: string; name: string } | null) => void> = [];

async function fetchActiveProject(): Promise<Project | null> {
  try {
    return await premierepro.Project.getActiveProject();
  } catch (e) {
    console.warn("getActiveProject failed", e);
    return null;
  }
}

export const projectCore = {
  async getCurrent(): Promise<{
    path: string;
    guid: string;
    name: string;
  } | null> {
    const project = await fetchActiveProject();
    if (!project) return null;
    const path = project.path || "";
    const guid = project.guid ? String(project.guid) : "";
    const name = project.name || "";
    return { path, guid, name };
  },

  async getSequences(): Promise<{
    activeSequenceGuid: string | null;
    sequences: Array<{
      guid: string;
      name: string;
      videoTrackCount: number;
      audioTrackCount: number;
    }>;
  }> {
    try {
      const project = await fetchActiveProject();
      if (!project) return { activeSequenceGuid: null, sequences: [] };
      const sequences = await project.getSequences();
      const list: Array<{
        guid: string;
        name: string;
        videoTrackCount: number;
        audioTrackCount: number;
      }> = [];
      for (const seq of sequences) {
        const videoTracks = await seq.getVideoTrackCount();
        const audioTracks = await seq.getAudioTrackCount();
        list.push({
          guid: String(seq.guid),
          name: seq.name,
          videoTrackCount: videoTracks,
          audioTrackCount: audioTracks,
        });
      }
      let activeGuid: string | null = null;
      try {
        const active = await project.getActiveSequence();
        activeGuid = active ? String(active.guid) : null;
      } catch (e) {
        console.warn("getActiveSequence failed", e);
      }
      return { activeSequenceGuid: activeGuid, sequences: list };
    } catch (e) {
      console.warn("getSequences failed", e);
      return { activeSequenceGuid: null, sequences: [] };
    }
  },

  async queryProjectState() {
    const project = await this.getCurrent();
    const sequences = await this.getSequences();
    return {
      project,
      activeSequenceGuid: sequences.activeSequenceGuid,
      sequences: sequences.sequences,
    };
  },

  /** 注册切换监听；返回反注册函数 */
  onProjectChanged(
    cb: (p: { path: string; guid: string; name: string } | null) => void,
  ): () => void {
    listeners.push(cb);
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  },

  /** 启动期调用一次 + 由 entrypoints 触发初次推送 */
  async emitInitial(): Promise<void> {
    const cur = await this.getCurrent();
    if (cur) {
      cachedProjectGuid = cur.guid;
      cachedProjectPath = cur.path;
    } else {
      cachedProjectGuid = null;
      cachedProjectPath = null;
    }
    for (const cb of listeners) {
      try {
        cb(cur);
      } catch (e) {
        console.warn("project listener failed", e);
      }
    }
  },

  /** 内部：被 api 层周期性 / 事件驱动调用 */
  async _onChanged(): Promise<void> {
    const cur = await this.getCurrent();
    const newGuid = cur?.guid ?? null;
    const newPath = cur?.path ?? null;
    if (newGuid === cachedProjectGuid && newPath === cachedProjectPath) return;
    cachedProjectGuid = newGuid;
    cachedProjectPath = newPath;
    for (const cb of listeners) {
      try {
        cb(cur);
      } catch (e) {
        console.warn("project listener failed", e);
      }
    }
  },
};

export type ProjectCore = typeof projectCore;

/**
 * 启动项目切换监听；返回 cleanup 函数。
 * 调用方负责在 webview 重载时调用 cleanup。
 *
 * - 优先尝试事件绑定（premiereProjectChanged / onActiveProjectChange）
 * - 失败兜底：setInterval 周期性探测
 */
export function setupProjectWatchers(): () => void {
  let cleaned = false;
  const cleanups: Array<() => void> = [];

  const tryEventBind = (): boolean => {
    const app: any = premierepro as any;
    if (app?.app?.eventManager?.on) {
      try {
        const handler = () => { projectCore._onChanged().catch(() => {}); };
        app.app.eventManager.on("premiereProjectChanged", handler);
        cleanups.push(() => {
          try {
            const off = app.app.eventManager.off || app.app.eventManager.removeListener;
            if (typeof off === "function") off("premiereProjectChanged", handler);
          } catch (e) {
            console.warn("[project] unbind premiereProjectChanged failed", e);
          }
        });
        return true;
      } catch (e) {
        console.warn("bind premiereProjectChanged failed", e);
      }
    }
    if (app?.Project?.onActiveProjectChange) {
      try {
        const handler = () => { projectCore._onChanged().catch(() => {}); };
        app.Project.onActiveProjectChange(handler);
        cleanups.push(() => {
          try {
            const off = app.Project.offActiveProjectChange || app.Project.removeActiveProjectChangeListener;
            if (typeof off === "function") off(handler);
          } catch (e) {
            console.warn("[project] unbind onActiveProjectChange failed", e);
          }
        });
        return true;
      } catch (e) {
        console.warn("bind onActiveProjectChange failed", e);
      }
    }
    return false;
  };

  if (!tryEventBind()) {
    // 兜底：每 2s 探测一次，提供 cleanup
    const id = setInterval(() => {
      projectCore._onChanged().catch(() => {});
    }, 2000);
    cleanups.push(() => clearInterval(id));
  }

  return () => {
    if (cleaned) return;
    cleaned = true;
    for (const c of cleanups) {
      try { c(); } catch (e) { console.warn("[project] cleanup error", e); }
    }
  };
}