/**
 * 持久化设置 + API Key 存储
 *
 * 密钥存储策略：UXP secureStorage（macOS Keychain）为唯一明文落点；
 * 兜底文件 app-settings.sec.json 在 secureStorage 可用时**剥离全部密钥字段**，
 * 仅存非敏感设置；secureStorage 不可用时密钥以 OBF: 前缀混淆写入（XOR+base64，
 * 只防 grep / 误打开，非真加密）。历史遗留的明文密钥文件在首次读取时自动清理。
 */
import { uxp } from "../globals";
import { DEFAULT_UXP_PROVIDER_ID } from "./ai/providers/types";

const SETTINGS_FILENAME = "app-settings.json";
const SETTINGS_FALLBACK_FILENAME = "app-settings.sec.json";

interface PersistedSettings {
  apiKey?: string;
  /** per-provider API Key 表（key = providerId）；旧单 key 仍作为默认 provider 兜底 */
  apiKeys?: Record<string, string>;
  dryRun?: boolean;
  /** 飞书多维表格自动化 webhook 地址 */
  feishuWebhookUrl?: string;
  /** 飞书 webhook 凭证校验（Authorization: Bearer <token>） */
  feishuToken?: string;
  /** 剪辑师（自定义字段，全局生效） */
  editorName?: string;
}

const SECURE_KEY = "rocx.apiKey";
/** per-provider key 表整体作为一个 JSON blob 存 secureStorage（读时无需枚举 provider 列表） */
const SECURE_API_KEYS_KEY = "rocx.apiKeys";
const SECURE_FEISHU_TOKEN_KEY = "rocx.feishu.token";

/** 飞书团队设置（对外读写结构） */
export interface FeishuConfig {
  webhookUrl: string;
  token: string;
  editorName: string;
}

// 简单混淆（不是真加密；只防 grep / 误打开看）
function obfuscate(s: string): string {
  const KEY = 0x5a;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ KEY);
  }
  return btoa(out);
}
function deobfuscate(b64: string): string {
  try {
    const raw = atob(b64);
    const KEY = 0x5a;
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ KEY);
    }
    return out;
  } catch {
    return "";
  }
}

// 检测 secureStorage 是否可用（runtime 探测，避免 build-time 检测不一致）
function hasSecureStorage(): boolean {
  try {
    const sec: any = (uxp as any)?.storage?.secureStorage;
    if (!sec) return false;
    return (
      typeof sec.getPassword === "function" ||
      typeof sec.getSecret === "function" ||
      typeof sec.getString === "function"
    );
  } catch {
    return false;
  }
}

async function secureGet(key: string): Promise<string | null> {
  const sec: any = (uxp as any).storage.secureStorage;
  if (!sec) return null;
  try {
    if (typeof sec.getPassword === "function") return await sec.getPassword(key);
    if (typeof sec.getSecret === "function") return await sec.getSecret(key);
    if (typeof sec.getString === "function") return await sec.getString(key);
    return null;
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<boolean> {
  const sec: any = (uxp as any).storage.secureStorage;
  if (!sec) return false;
  try {
    if (typeof sec.setPassword === "function") {
      await sec.setPassword(key, value);
      return true;
    }
    if (typeof sec.setSecret === "function") {
      await sec.setSecret(key, value);
      return true;
    }
    if (typeof sec.setString === "function") {
      await sec.setString(key, value);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function secureDelete(key: string): Promise<void> {
  const sec: any = (uxp as any).storage.secureStorage;
  if (!sec) return;
  try {
    if (typeof sec.removePassword === "function") await sec.removePassword(key);
    else if (typeof sec.removeSecret === "function") await sec.removeSecret(key);
    else if (typeof sec.removeString === "function") await sec.removeString(key);
    else if (typeof sec.deletePassword === "function")
      await sec.deletePassword(key);
  } catch {
    // ignore
  }
}

// 兜底文件读写（明文存储）
async function readFallbackFile(): Promise<PersistedSettings> {
  try {
    const fs: any = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();
    let entry: any = null;
    try {
      entry = await dataFolder.getEntry(SETTINGS_FALLBACK_FILENAME);
    } catch {
      entry = null;
    }
    if (!entry) {
      // 兼容旧文件名（含本轮重构前的明文 app-settings.json）
      try {
        entry = await dataFolder.getEntry(SETTINGS_FILENAME);
      } catch {
        entry = null;
      }
    }
    if (!entry) return {};
    const content = await entry.read({ format: uxp.storage.formats.utf8 });
    if (!content) return {};
    const parsed = JSON.parse(content);
    // OBF: 前缀 = secureStorage 不可用时的混淆密钥格式，读时还原
    if (typeof parsed?.apiKey === "string" && parsed.apiKey.startsWith("OBF:")) {
      parsed.apiKey = deobfuscate(parsed.apiKey.slice(4));
    }
    if (typeof parsed?.feishuToken === "string" && parsed.feishuToken.startsWith("OBF:")) {
      parsed.feishuToken = deobfuscate(parsed.feishuToken.slice(4));
    }
    if (parsed?.apiKeys && typeof parsed.apiKeys === "object") {
      for (const [k, v] of Object.entries(parsed.apiKeys)) {
        if (typeof v === "string" && v.startsWith("OBF:")) {
          parsed.apiKeys[k] = deobfuscate(v.slice(4));
        }
      }
    }
    // 历史遗留：早期 RunningHub 单 key 明文字段，读取时即剔除（后续写盘自动消失）
    delete parsed.rhApiKey;
    return parsed as PersistedSettings;
  } catch (e) {
    console.warn("storage.readFallbackFile failed", e);
    return {};
  }
}

/**
 * 获取插件私有数据目录（pluginDataFolder）。
 * - 用于 launcher 脚本中转 args JSON，避开 UXP `shell.openPath` 不能传参的限制。
 * - UXP `fs.getDataFolder()` 返回的就是插件私有目录（macOS ~/Library/Application Support/UXP/<id>/，
 *   Windows %APPDATA%\Adobe\UXP\<id>\），外部不可读，可安全写入敏感临时文件。
 * - 缓存 promise 防止重复 IO；目录已存在则 noop。
 */
let _pluginDataFolderPromise: Promise<any> | null = null;
export async function getPluginDataFolder(): Promise<any | null> {
  if (_pluginDataFolderPromise) return _pluginDataFolderPromise;
  _pluginDataFolderPromise = (async () => {
    try {
      const fs: any = (uxp as any)?.storage?.localFileSystem;
      if (!fs?.getDataFolder) return null;
      const folder = await fs.getDataFolder();
      // getDataFolder 在 PR 上总是返回已存在的目录；写 JSON 时 createFile 会自动建文件
      // 这里保险做一次 isFolder 探测（UXP File 接口提供 .isFolder / .name）
      if (folder && typeof folder.isFolder === "function" && folder.isFolder() === false) {
        return null;
      }
      return folder;
    } catch (e) {
      console.warn("[storage] getPluginDataFolder failed:", e);
      return null;
    }
  })();
  return _pluginDataFolderPromise;
}

async function writeFallbackFile(settings: PersistedSettings): Promise<void> {
  const fs: any = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  // 调用方保证 settings 已剥离/混淆密钥；本函数只负责落盘
  const content = JSON.stringify(settings, null, 2);
  // UXP 的 createFile 直接返回 file entry，无需再 getEntry（后者在 entry 不存在时 throw）
  const file = await dataFolder.createFile(SETTINGS_FALLBACK_FILENAME, {
    overwrite: true,
  });
  await file.write(content, { format: uxp.storage.formats.utf8 });
}

/** 剥离全部密钥字段（含历史遗留 rhApiKey），返回可安全落盘的设置副本 */
function stripSecrets(s: PersistedSettings): PersistedSettings {
  const out: any = { ...s };
  delete out.apiKey;
  delete out.apiKeys;
  delete out.feishuToken;
  delete out.rhApiKey;
  return out;
}

/** secureStorage 不可用时的兜底混淆：密钥加 OBF: 前缀（XOR+base64，防 grep 非真加密） */
function obfuscateSecrets(s: PersistedSettings): PersistedSettings {
  const out: any = { ...s };
  if (out.apiKey) out.apiKey = "OBF:" + obfuscate(out.apiKey);
  if (out.feishuToken) out.feishuToken = "OBF:" + obfuscate(out.feishuToken);
  if (out.apiKeys && typeof out.apiKeys === "object") {
    out.apiKeys = Object.fromEntries(
      Object.entries(out.apiKeys).map(([k, v]) => [k, "OBF:" + obfuscate(String(v))]),
    );
  }
  return out;
}

async function readSettings(): Promise<PersistedSettings> {
  // 兜底文件是非密钥字段（dryRun / 飞书设置）的唯一来源，必须先读
  const fb = await readFallbackFile();
  if (!hasSecureStorage()) return fb;

  // 密钥类字段以 secureStorage 为准
  const merged: PersistedSettings = { ...fb };
  try {
    const apiKey = await secureGet(SECURE_KEY);
    if (apiKey) {
      merged.apiKey = apiKey;
    } else if (fb.apiKey) {
      // 自动迁移旧明文 apiKey 到 secureStorage（如果可用）
      const ok = await secureSet(SECURE_KEY, fb.apiKey);
      if (ok)
        console.warn("[storage] 已从 app-settings.json 迁移到 secureStorage");
    }
    const feishuToken = await secureGet(SECURE_FEISHU_TOKEN_KEY);
    if (feishuToken) merged.feishuToken = feishuToken;
    const apiKeysRaw = await secureGet(SECURE_API_KEYS_KEY);
    if (apiKeysRaw) {
      try {
        const map = JSON.parse(apiKeysRaw);
        if (map && typeof map === "object") merged.apiKeys = map;
      } catch {
        // blob 损坏时忽略，回落兜底文件 / 旧单 key
      }
    } else if (fb.apiKeys) {
      // 自动迁移兜底文件里的 apiKeys 到 secureStorage
      const ok = await secureSet(SECURE_API_KEYS_KEY, JSON.stringify(fb.apiKeys));
      if (ok) console.warn("[storage] apiKeys 已迁移到 secureStorage");
    }
  } catch (e) {
    console.warn("[storage] secureStorage read failed, fallback:", e);
  }
  // 历史遗留明文密钥清理：secureStorage 可用时把兜底文件重写为无密钥版本
  // （迁移已在上面完成；secureStorage 已有 key 但文件仍留明文的旧版本也会被清掉）
  if (fb.apiKey || fb.apiKeys || fb.feishuToken) {
    try {
      await writeFallbackFile(stripSecrets(fb));
    } catch (e) {
      console.warn("[storage] 清理兜底文件明文密钥失败:", e);
    }
  }
  return merged;
}

async function writeSettings(settings: PersistedSettings): Promise<void> {
  const secAvailable = hasSecureStorage();
  // 兜底文件：secureStorage 可用时剥离全部密钥字段（明文密钥不落盘）；
  // 不可用时密钥混淆写入作为兜底
  await writeFallbackFile(
    secAvailable ? stripSecrets(settings) : obfuscateSecrets(settings),
  );

  if (!secAvailable) return;
  // 密钥类字段写入 secureStorage（明文唯一落点）
  if (settings.apiKey) {
    const ok = await secureSet(SECURE_KEY, settings.apiKey);
    if (!ok)
      console.warn(
        "[storage] secureStorage 写入失败，且兜底文件不含密钥，重启后需重新配置",
      );
  } else {
    await secureDelete(SECURE_KEY);
  }
  if (settings.feishuToken) {
    await secureSet(SECURE_FEISHU_TOKEN_KEY, settings.feishuToken);
  } else {
    await secureDelete(SECURE_FEISHU_TOKEN_KEY);
  }
  if (settings.apiKeys && Object.keys(settings.apiKeys).length > 0) {
    await secureSet(SECURE_API_KEYS_KEY, JSON.stringify(settings.apiKeys));
  } else {
    await secureDelete(SECURE_API_KEYS_KEY);
  }
}

export const storage = {
  /**
   * 取 provider 的 API Key。
   * - 不传 providerId：返回旧单 key（兼容既有调用方）
   * - 传 providerId：优先 apiKeys[providerId]；缺省时默认 provider 回落旧单 key
   *   （老用户只配过一个 key，它就是默认 provider 的 key），其它 provider 返回 null
   */
  async getApiKey(providerId?: string): Promise<string | null> {
    const s = await readSettings();
    if (providerId) {
      const k = s.apiKeys?.[providerId];
      if (k) return k;
      if (providerId === DEFAULT_UXP_PROVIDER_ID) return s.apiKey || null;
      return null;
    }
    return s.apiKey || null;
  },

  /**
   * 写 provider 的 API Key。
   * - 不传 providerId：写旧单 key，并同步进 apiKeys[默认 provider]（两处保持一致）
   * - 传 providerId：只写 apiKeys[providerId]
   */
  async setApiKey(
    key: string,
    providerId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const trimmed = (key || "").trim();
      const s = await readSettings();
      if (!providerId) {
        if (trimmed) {
          s.apiKey = trimmed;
          s.apiKeys = { ...(s.apiKeys || {}), [DEFAULT_UXP_PROVIDER_ID]: trimmed };
        } else {
          delete s.apiKey;
          if (s.apiKeys) delete s.apiKeys[DEFAULT_UXP_PROVIDER_ID];
        }
      } else {
        s.apiKeys = { ...(s.apiKeys || {}) };
        if (trimmed) s.apiKeys[providerId] = trimmed;
        else delete s.apiKeys[providerId];
      }
      await writeSettings(s);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  async getDryRun(): Promise<boolean> {
    const s = await readSettings();
    return s.dryRun ?? true;
  },

  async setDryRun(v: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const s = await readSettings();
      s.dryRun = v;
      await writeSettings(s);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  async getFeishuConfig(): Promise<FeishuConfig> {
    const s = await readSettings();
    return {
      webhookUrl: s.feishuWebhookUrl || "",
      token: s.feishuToken || "",
      editorName: s.editorName || "",
    };
  },

  async setFeishuConfig(
    cfg: FeishuConfig,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const webhookUrl = (cfg?.webhookUrl || "").trim();
      const token = (cfg?.token || "").trim();
      const editorName = (cfg?.editorName || "").trim();
      const s = await readSettings();
      if (webhookUrl) s.feishuWebhookUrl = webhookUrl;
      else delete s.feishuWebhookUrl;
      if (token) s.feishuToken = token;
      else delete s.feishuToken;
      if (editorName) s.editorName = editorName;
      else delete s.editorName;
      await writeSettings(s);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
};
