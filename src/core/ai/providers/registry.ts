/**
 * UXP 端 provider 注册中心
 */
import type { UxPProvider } from "./types";
import { DEFAULT_UXP_PROVIDER_ID } from "./types";

const providers = new Map<string, UxPProvider>();

export function registerUxPProvider(p: UxPProvider): void {
  providers.set(p.providerId, p);
}

export function getUxPProvider(id?: string): UxPProvider {
  const target = id || DEFAULT_UXP_PROVIDER_ID;
  const p = providers.get(target);
  if (p) return p;
  // fallback to default
  const fb = providers.get(DEFAULT_UXP_PROVIDER_ID);
  if (fb) {
    console.warn(
      `[uxp-providers] requested provider "${target}" not registered; falling back to default "${DEFAULT_UXP_PROVIDER_ID}"`,
    );
    return fb;
  }
  throw new Error(`No UXP provider registered for "${target}" (also no default)`);
}

export function unregisterUxPProvider(id: string): void {
  providers.delete(id);
}
