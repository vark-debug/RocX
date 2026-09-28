/**
 * 持久化设置 + API Key 存储
 *
 * 实现方式：UXP secureStorage 优先，runtime 不支持时回退到
 * localFileSystem 加密字段（base64 + 固定 XOR 混淆）。
 * 旧明文 app-settings.json 会在首次读取时自动迁移到 secureStorage。
 */
import { uxp } from "../globals";

const SETTINGS_FILENAME = "app-settings.json";
const SETTINGS_FALLBACK_FILENAME = "app-settings.sec.json";

interface PersistedSettings {
  apiKey?: string;
  dryRun?: boolean;
  /** 飞书多维表格自动化 webhook 地址 */
  feishuWebhookUrl?: string;
  /** 飞书 webhook 凭证校验（Authorization: Bearer <token>） */
  feishuToken?: string;
  /** 剪辑师（自定义字段，全局生效） */
  editorName?: string;
}

const SECURE_KEY = "rocx.apiKey";
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
    // 兼容旧版本的 obfuscate 混淆格式（重构前的过渡格式）：如果存在混淆前缀则还原
    if (parsed?.apiKey && typeof parsed.apiKey === "string" && parsed.apiKey.startsWith("OBF:")) {
      parsed.apiKey = deobfuscate(parsed.apiKey.slice(4));
    }
    return parsed as PersistedSettings;
  } catch (e) {
    console.warn("storage.readFallbackFile failed", e);
    return {};
  }
}

async function writeFallbackFile(settings: PersistedSettings): Promise<void> {
  const fs: any = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  // 明文落盘：UXP plugin-data 目录是插件私有、外部不可读；如需加密可走 secureStorage
  const content = JSON.stringify(settings, null, 2);
  // UXP 的 createFile 直接返回 file entry，无需再 getEntry（后者在 entry 不存在时 throw）
  const file = await dataFolder.createFile(SETTINGS_FALLBACK_FILENAME, {
    overwrite: true,
  });
  await file.write(content, { format: uxp.storage.formats.utf8 });
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
  } catch (e) {
    console.warn("[storage] secureStorage read failed, fallback:", e);
  }
  return merged;
}

async function writeSettings(settings: PersistedSettings): Promise<void> {
  // 写入兜底文件（明文）；plugin-data 是插件私有目录
  await writeFallbackFile(settings);

  if (!hasSecureStorage()) return;
  // 密钥类字段同步写入 secureStorage（如可用），作为冗余备份
  if (settings.apiKey) {
    const ok = await secureSet(SECURE_KEY, settings.apiKey);
    if (!ok) console.warn("[storage] secureStorage 写入失败，仅落兜底文件");
  } else {
    await secureDelete(SECURE_KEY);
  }
  if (settings.feishuToken) {
    await secureSet(SECURE_FEISHU_TOKEN_KEY, settings.feishuToken);
  } else {
    await secureDelete(SECURE_FEISHU_TOKEN_KEY);
  }
}

export const storage = {
  async getApiKey(): Promise<string | null> {
    const s = await readSettings();
    return s.apiKey || null;
  },

  async setApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const trimmed = (key || "").trim();
      const s = await readSettings();
      if (trimmed) {
        s.apiKey = trimmed;
      } else {
        delete s.apiKey;
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
