/**
 * Webview 端共享状态 provide/inject key
 *
 * 顶层 (main-webview.vue) 持有高频 ref,各 composable 通过 inject 拿共享,
 * 减少 props 透传噪音。低频 ref (settingsOpen / refreshing / currentProvider /
 * providerModels / toastMsg / storageMode / currentProviderId) 不进 SharedRefs,
 * 保持局部,避免不必要共享。
 *
 * 为什么用 Symbol.for(...) 而不是 Symbol(...):
 * Vite dev mode HMR 时,如果某 composable 被重载但 state.ts 也被连带重载,
 * 顶层 Symbol("rocx-shared-refs") 会重新求值,生成新 Symbol 实例;
 * 而 main-webview.vue 如果没改就没 HMR,仍持有旧 Symbol 引用 → provide/inject 失配。
 * Symbol.for(...) 走全局 symbol registry,跨 module 实例 + 跨 HMR 重载始终唯一。
 *
 * 使用:
 *   // main-webview.vue
 *   import { provide } from "vue";
 *   import { SharedRefsKey } from "./providers/state";
 *   provide(SharedRefsKey, {
 *     apiKey, projectInfo, records, prompt, model, ratio,
 *     duration, resolution, references, selectedRecordId,
 *   });
 *
 *   // composables
 *   import { inject } from "vue";
 *   import { SharedRefsKey, type SharedRefs } from "../providers/state";
 *   const shared = inject(SharedRefsKey);
 *   if (!shared) throw new Error("requires SharedRefs provider");
 *   // shared.records.value ...
 */
import type { InjectionKey, Ref } from "vue";
import type {
  GenerationRecord,
  ReferenceItem,
} from "@shared/messages";

export interface SharedRefs {
  apiKey: Ref<string | null>;
  projectInfo: Ref<{ path: string; guid: string; name: string } | null>;
  records: Ref<GenerationRecord[]>;
  prompt: Ref<string>;
  model: Ref<any>;
  ratio: Ref<any>;
  duration: Ref<number>;
  resolution: Ref<any>;
  references: Ref<ReferenceItem[]>;
  selectedRecordId: Ref<string | null>;
}

/**
 * 使用 Symbol.for("...") 而非 Symbol("...") — 全局 registry 让跨 HMR
 * 重载的 module 实例始终引用同一 Symbol。这是 Vite dev mode 下
 * 修复 "useXxx requires SharedRefs provider" 错误的关键。
 */
export const SharedRefsKey: InjectionKey<SharedRefs> = Symbol.for(
  "rocx-shared-refs",
);