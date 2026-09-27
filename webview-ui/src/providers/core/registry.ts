/**
 * Provider 注册中心
 */
import type { VideoGenProvider } from "./VideoGenProvider";
import type { ModelDescriptor } from "./types";

const providers = new Map<string, VideoGenProvider>();
const loaders = new Map<string, () => Promise<VideoGenProvider>>();

export function registerProvider(provider: VideoGenProvider): void {
  providers.set(provider.providerId, provider);
}

export function registerProviderLoader(
  providerId: string,
  loader: () => Promise<VideoGenProvider>,
): void {
  loaders.set(providerId, loader);
}

/** 按 id 取 provider；同步优先，缺失时尝试 dynamic load 一次 */
export async function getProvider(id: string): Promise<VideoGenProvider | null> {
  const cached = providers.get(id);
  if (cached) return cached;
  const loader = loaders.get(id);
  if (!loader) return null;
  try {
    const p = await loader();
    providers.set(id, p);
    return p;
  } catch (e) {
    console.warn(`[providers] failed to load ${id}:`, e);
    return null;
  }
}

export function getProviderSync(id: string): VideoGenProvider | null {
  return providers.get(id) ?? null;
}

export function unregisterProvider(id: string): void {
  providers.delete(id);
  loaders.delete(id);
}

export function listProviders(): VideoGenProvider[] {
  return Array.from(providers.values());
}

export function listModels(providerId?: string): ModelDescriptor[] {
  if (providerId) {
    const p = providers.get(providerId);
    return p ? p.models : [];
  }
  const all: ModelDescriptor[] = [];
  for (const p of providers.values()) all.push(...p.models);
  return all;
}

/** 默认 provider id（兜底） */
export const DEFAULT_PROVIDER_ID = "minimax";

/** 当前主 provider（首次注册的第一个；fallback 到默认） */
export async function getActiveProvider(): Promise<VideoGenProvider> {
  const ids = Array.from(providers.keys());
  if (ids.length > 0) {
    return (await getProvider(ids[0]))!;
  }
  // 试图加载 loader
  const fallback = await getProvider(DEFAULT_PROVIDER_ID);
  if (fallback) return fallback;
  throw new Error("No video-gen provider registered");
}