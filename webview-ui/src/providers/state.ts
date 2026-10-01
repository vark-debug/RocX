/**
 * Webview 端共享状态 provide/inject key
 *
 * 顶层 (main-webview.vue) 持有高频 ref,各 composable 通过 inject 拿共享,
 * 减少 props 透传噪音。低频 ref (settingsOpen / refreshing / currentProvider /
 * providerModels / toastMsg / storageMode / currentProviderId) 不进 SharedRefs,
 * 保持局部,避免不必要共享。
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

export const SharedRefsKey: InjectionKey<SharedRefs> = Symbol("rocx-shared-refs");