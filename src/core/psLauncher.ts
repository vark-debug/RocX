/**
 * Photoshop 启动器:从抓帧文件拉起 PS 编辑
 *
 * 启动顺序(走 C++ Hybrid Plugin 路径,cpp-hybrid-plugin-ps-launch spec):
 *   1) C++ Hybrid addon (`RocXBridge.openFileInPhotoshop`):
 *      macOS NSWorkspace + bundle id "com.adobe.Photoshop" 强制命中;
 *      Windows 注册表扫描 + ShellExecuteExW。
 *   2) launcher 脚本:把 `{path, ts}` 写到 pluginDataFolder/rocx-launcher-args.json,
 *      再 `shell.openPath(launcher.ps1 / launcher.command)`,脚本读 JSON 强制命中。
 *   3) 系统兜底:`shell.openPath(localPath)` 按 jpg 关联启动。
 *
 * 任何异常 / 失败均 console.warn,不污染 UI;返回 `{ok, source}` 供诊断日志。
 */
import { uxp } from "../globals";
import { getFs } from "./pathUtils";
import { getPluginDataFolder } from "./storage";

export const psLauncherCore = {
  /**
   * 用系统关联启动 Photoshop 打开指定本地文件。
   *
   * UXP 实际可用姿势:
   *   - `shell.openExternal(scheme://...)` 仅支持 manifest `launchProcess.schemes`
   *     白名单里的 scheme;`file://` 不被接受(即使在 schemes 里)
   *   - `shell.openPath(localPath)` 按系统文件关联启动应用,依赖
   *     `launchProcess.extensions` 白名单里的扩展名(jpg/jpeg/png/webp 已在白名单)
   *
   * 失败原因一般是系统未把 jpg 关联到 PS(罕见),webview 端仅 console.warn,不污染 UI。
   */
  async openWithPhotoshop(localPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!localPath) return { ok: false, error: "路径为空" };
    const uxpAny: any = require("uxp");
    if (!uxpAny?.shell?.openPath) return { ok: false, error: "uxp.shell.openPath 不可用" };
    try {
      await uxpAny.shell.openPath(localPath);
      return { ok: true };
    } catch (e: any) {
      console.warn("[files] openWithPhotoshop openPath failed:", e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 把要打开的图片绝对路径写入 pluginDataFolder/rocx-launcher-args.json,
   * 然后通过 `shell.openPath` 启动 launcher.ps1 / launcher.command。
   * UXP `shell.openPath` 不支持参数,所以走 JSON 中转。
   * Windows 下 manifest 已加 `.ps1` 到 launchProcess.extensions 白名单;
   * macOS 下加 `.command` / `.sh`。
   *
   * launcher 脚本路径:与 manifest.json 同级(即 ccx/dist 根目录下的 launcher.ps1 /
   * launcher.command,由 public-zip/ 经 vite-uxp-plugin 的 copyZipAssets 拷进来)。
   */
  async openWithPhotoshopLauncher(
    localPath: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const folder = await getPluginDataFolder();
      if (!folder) return { ok: false, error: "pluginDataFolder 不可用" };
      const argsJson = JSON.stringify({ path: localPath, ts: Date.now() });
      const file = await folder.createFile("rocx-launcher-args.json", {
        overwrite: true,
      });
      await file.write(argsJson, { format: uxp.storage.formats.utf8 });

      // 解析 launcher 脚本的 nativePath(与 manifest.json 同级)
      // Windows 用 .cmd 作为 UXP shell.openPath 入口(.ps1 在某些 UXP 版本会被拒),
      // .cmd 内部再调 launcher.ps1 做实际工作。
      const launcherName = process.platform === "win32" ? "launcher.cmd" : "launcher.command";
      const uxpAny: any = require("uxp");
      if (!uxpAny?.shell?.openPath) return { ok: false, error: "uxp.shell.openPath 不可用" };

      // 用 UXP 官方 API fs.getPluginFolder() 拿 plugin 内容根目录。
      // 这是 launcher.cmd / launcher.command / manifest.json 真正所在的位置。
      // 不能从 pluginDataFolder 的 nativePath 反推,因为 pluginDataFolder 在 PR 上
      // 是按 app/version 拆目录管理的(<userData>\Adobe\UXP\PluginsStorage\PPRO\<ver>\Developer\<id>\PluginData),
      // 与 plugin 内容目录完全无关。
      const uxpFs = getFs();
      let pluginFolder: any = null;
      try {
        if (typeof uxpFs.getPluginFolder === "function") {
          pluginFolder = await uxpFs.getPluginFolder();
        }
      } catch (e) {
        pluginFolder = null;
      }
      if (!pluginFolder) {
        return {
          ok: false,
          error: "fs.getPluginFolder 不可用 (PR < 7.5 或 或 权限不足)",
        };
      }
      let pluginRoot = "";
      try {
        pluginRoot = (pluginFolder as any).nativePath || (await uxpFs.getNativePath(pluginFolder));
      } catch {
        pluginRoot = "";
      }
      if (!pluginRoot) {
        return { ok: false, error: "无法解析 pluginFolder nativePath" };
      }
      const sep = pluginRoot.includes("\\") ? "\\" : "/";
      const launcherPath = `${pluginRoot.replace(/[\/\\]+$/, "")}${sep}${launcherName}`;
      console.log(`[files][ps-launch] launcher 脚本路径: ${launcherPath}`);
      // 探测 launcher 是否在 plugin root 内,失败给出清晰错误
      const probeUrl = `file:///${pluginRoot.replace(/\\/g, "/").replace(/^\//, "")}/${launcherName}`;
      try {
        await uxpFs.getEntryWithUrl(probeUrl);
      } catch {
        return {
          ok: false,
          error: `launcher 脚本不在 plugin root: ${launcherPath}`,
        };
      }
      await uxpAny.shell.openPath(launcherPath);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  /**
   * 走 C++ Hybrid Plugin 路径打开 Photoshop。
   *
   * 返回值 `{ok, source}`:source ∈ {"native","launcher","fallback"},供诊断日志。
   */
  async openWithPhotoshopNative(
    localPath: string,
  ): Promise<{ ok: boolean; source: "native" | "launcher" | "fallback"; error?: string }> {
    if (!localPath) return { ok: false, source: "fallback", error: "路径为空" };
    console.log(`[files][ps-launch] 开始拉起 PS, localPath=${localPath}`);

    // 1) C++ Hybrid Plugin
    try {
      // UXP Hybrid Plugin:`require("name.uxpaddon")` 返回 Promise,必须 await
      const addon: any = await (require as any)("RocXBridge.uxpaddon");
      if (addon && typeof addon.openFileInPhotoshop === "function") {
        const r = await addon.openFileInPhotoshop(localPath);
        if (r && r.ok) {
          console.log("[files][ps-launch] ✅ 命中路径: C++ Hybrid addon");
          return { ok: true, source: "native" };
        }
        if (r && r.error) {
          console.warn("[files] hybrid addon returned error, fallback to launcher:", r.error);
        }
      } else {
        console.warn("[files] hybrid addon loaded but openFileInPhotoshop missing");
      }
    } catch (e: any) {
      // MODULE_NOT_FOUND / Addon is not supported / PR 版本过低 / uxpaddon 缺失
      console.warn(
        "[files][ps-launch] C++ Hybrid 不可用, 降级 launcher 脚本:",
        e?.message || e,
      );
    }

    // 2) Launcher 脚本
    const l = await this.openWithPhotoshopLauncher(localPath);
    if (l.ok) {
      console.log("[files][ps-launch] ✅ 命中路径: launcher 脚本 (launcher.cmd/.command)");
      return { ok: true, source: "launcher" };
    }
    if (l.error) {
      console.warn(
        `[files][ps-launch] launcher 脚本失败, 降级系统关联: ${l.error}`,
      );
    }

    // 3) 系统兜底
    const f = await this.openWithPhotoshop(localPath);
    console.log(
      `[files][ps-launch] ${f.ok ? "✅" : "❌"} 命中路径: 系统关联兜底 (shell.openPath)${f.error ? `, error=${f.error}` : ""}`,
    );
    return { ok: f.ok, source: "fallback", error: f.error };
  },
};