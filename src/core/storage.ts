/**
 * 持久化设置 + API Key 存储
 *
 * 实现方式：把整个 settings（含 API Key）写到 uxp.storage.localFileSystem.getDataFolder()
 * 下的 app-settings.json 文件。这是参考 vark-debug/jianming-adobePremierePro-Smart-Export
 * 项目采用的方式，跨项目/跨 PR 重启都持久，不需要 secureStorage（该 API 在某些 UXP runtime 上不稳定）。
 */
import { uxp } from "../globals";

const SETTINGS_FILENAME = "app-settings.json";

interface PersistedSettings {
  apiKey?: string;
  dryRun?: boolean;
}

async function readSettings(): Promise<PersistedSettings> {
  try {
    const fs: any = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();
    const settingsFile = await dataFolder.getEntry(SETTINGS_FILENAME);
    if (!settingsFile) return {};
    const content = await settingsFile.read({
      format: uxp.storage.formats.utf8,
    });
    if (!content) return {};
    return JSON.parse(content) as PersistedSettings;
  } catch (e) {
    console.warn("storage.readSettings failed", e);
    return {};
  }
}

async function writeSettings(settings: PersistedSettings): Promise<void> {
  const fs: any = uxp.storage.localFileSystem;
  const dataFolder = await fs.getDataFolder();
  const content = JSON.stringify(settings, null, 2);
  // createFile(name, { overwrite: true }) 直接覆盖已有文件
  const file = await dataFolder.createFile(SETTINGS_FILENAME, { overwrite: true });
  await file.write(content, { format: uxp.storage.formats.utf8 });
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
};