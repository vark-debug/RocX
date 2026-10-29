/**
 * 可灵 CLI 调用封装（UXP 端）
 *
 * 职责：
 *   1. 探测 C++ Hybrid addon 是否可用（不可用 → addon_unavailable）
 *   2. 定位本机可灵 CLI 的执行入口（找不到 → cli_not_installed）
 *   3. 执行 CLI 命令并解析其 JSON 输出（解析失败 → bad_output + raw）
 *
 * 为什么不用 `kling` 这个命令名直接跑：
 *   `kling` 是 `#!/usr/bin/env node` 的 shebang 脚本（npm 全局安装的软链）。
 *   Adobe PR 从 Dock 启动时继承的是精简 PATH，既没有 npm 全局 bin 目录
 *   （`~/.npm-global/bin`），也常常没有 node 本身 —— 直接执行会得到
 *   `env: node: No such file or directory`（实测）。
 *   所以这里改为定位「node 可执行文件绝对路径」+「CLI 的 JS 入口绝对路径」，
 *   用 node 直接跑 JS 入口，绕开 PATH 与 shebang。
 *
 * 定位策略（均为实测结论，见 spec「事实来源」）：
 *   - node：`zsh -l -c 'command -v node'`（login shell 会执行 /etc/zprofile 的
 *     path_helper，恢复完整 PATH）；非交互式 login shell **不**加载 .zshrc，
 *     所以拿不到 `~/.npm-global/bin` —— 这正是不能直接跑 `kling` 的根因。
 *   - npm 全局包根：`npm root -g` → `<root>/@klingai/cli-{cn,global}/dist/cli.js`
 *   - 登录态：`~/.kling/.credentials`（CLI 自行读取，本模块不碰也不回显）
 */
import type { KlingCliCode, KlingCliExecResult } from "@shared/messages";

/** addon 暴露的 runCommand 返回结构（与 C++ 侧 MakeCommandResult 对齐） */
export interface AddonCommandResult {
  ok: boolean;
  exitCode: number;
  out: string;
  err: string;
  truncated: boolean;
  error?: string;
}

/** addon 的 runCommand 入参 */
export interface AddonRunOptions {
  exe: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

/** addon 能力子集（便于测试注入假实现） */
export interface KlingCliAddon {
  runCommand(opts: AddonRunOptions): Promise<AddonCommandResult>;
}

/** CLI 顶层信封：{ ok, status, body } */
interface KlingEnvelope<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

/** 已定位好的 CLI 执行入口 */
interface CliEntry {
  /** 可执行文件绝对路径（node） */
  exe: string;
  /** 执行入口的后缀参数（CLI 的 JS 入口绝对路径） */
  prefixArgs: string[];
}

const ADDON_MODULE = "RocXBridge.uxpaddon";

/** addon 加载结果缓存（成功才缓存；失败允许重试） */
let addonPromise: Promise<KlingCliAddon | null> | null = null;

/** CLI 入口定位结果缓存 */
let entryPromise: Promise<CliEntry | null> | null = null;

/** 判定当前平台 */
function isWindows(): boolean {
  try {
    const os: any = require("os");
    return typeof os?.platform === "function" && os.platform() === "win32";
  } catch {
    return false;
  }
}

/**
 * 读一个环境变量。
 *
 * UXP 的 process shim 不保证有 env（process.platform 有，process.env 未必），
 * 所以优先走 require("os").env()，再退回 process.env。
 */
function envOf(name: string): string {
  try {
    const os: any = require("os");
    if (typeof os?.env === "function") {
      const v = os.env(name);
      if (typeof v === "string" && v) return v;
    }
  } catch {
    // ignore
  }
  try {
    const v = (process as any)?.env?.[name];
    if (typeof v === "string" && v) return v;
  } catch {
    // ignore
  }
  return "";
}

/**
 * 加载 C++ Hybrid addon。
 * 失败返回 null（不抛），调用方转成 addon_unavailable。
 */
async function loadAddon(): Promise<KlingCliAddon | null> {
  if (addonPromise) return addonPromise;
  addonPromise = (async () => {
    try {
      // UXP Hybrid Plugin：`require("name.uxpaddon")` 返回 Promise，必须 await
      const addon: any = await (require as any)(ADDON_MODULE);
      if (addon && typeof addon.runCommand === "function") {
        return addon as KlingCliAddon;
      }
      console.warn("[klingCli] addon 已加载但缺少 runCommand");
      return null;
    } catch (e: any) {
      // MODULE_NOT_FOUND / Addon is not supported / PR 版本过低
      console.warn("[klingCli] C++ Hybrid addon 不可用:", e?.message || e);
      return null;
    }
  })();
  const result = await addonPromise;
  if (!result) {
    // 失败不缓存，允许下次重试（如用户升级 PR 后立即生效）
    addonPromise = null;
  }
  return result;
}

/**
 * 从 stdout 中挑出第一个绝对路径行。
 * 用于过滤 shell profile 脚本可能打印的噪声行。
 */
function pickPathLine(out: string, mustEndWith?: string): string {
  for (const raw of (out || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(line)) continue;
    if (mustEndWith && !line.toLowerCase().endsWith(mustEndWith.toLowerCase())) {
      continue;
    }
    return line;
  }
  return "";
}

/**
 * 从 stdout 中挑出所有绝对路径行（按出现顺序）。
 * 用于 `where npm` 这类会返回多个结果的命令。
 */
function pickAllPathLines(out: string): string[] {
  const result: string[] = [];
  for (const raw of (out || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(line)) continue;
    result.push(line);
  }
  return result;
}

/**
 * 通过 shell 探测一条命令的绝对路径。
 *
 * 依次尝试：
 *   - `/bin/zsh -l -c`  （login shell：执行 /etc/zprofile，path_helper 恢复完整 PATH）
 *   - `/bin/zsh -i -l -c`（额外加载 .zshrc，覆盖 nvm 等在 .zshrc 里改 PATH 的场景）
 *   - `/bin/sh -l -c`
 */
async function whichViaShell(
  addon: KlingCliAddon,
  shellCmd: string,
  mustEndWith?: string,
): Promise<string> {
  if (isWindows()) {
    const r = await addon.runCommand({
      // 用绝对路径:C++ 侧 ResolveExecutable 虽已支持 PATH 搜索,
      // 但 PR 拉起的进程环境变量可能不完整,绝对路径最稳。
      exe: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", shellCmd],
      timeoutMs: 15000,
    });
    // 必须复用 pickPathLine —— 不能只取第一行:
    //   1) `where kling` 会返回多行,第一行是无扩展名的 `kling`(npm 的 sh shim),
    //      它是 unix shell 脚本,CreateProcessW 根本执行不了;
    //      真正能跑的是 `kling.cmd`。
    //   2) `where` 找不到时 cmd.exe 会往 stdout 打印
    //      "INFO: Could not find files for the given pattern(s).",
    //      取第一行会把这个提示当成路径。
    // pickPathLine 会过滤掉非路径行,并按 mustEndWith 筛选后缀。
    const found = pickPathLine(r.out || "", mustEndWith);
    if (found) return found;

    // mustEndWith 没匹配上时,退而求其次返回**所有**路径行(多行)。
    // `where npm` 需要全部结果:它会同时返回 node 自带的 npm 和用户全局的 npm,
    // 全局包装在后者 —— 只取第一项会指向错误的 node_modules。
    const all = pickAllPathLines(r.out || "");
    if (all.length) return all.join("\n");

    return "";
  }

  const attempts: Array<{ exe: string; args: string[] }> = [
    { exe: "/bin/zsh", args: ["-l", "-c", shellCmd] },
    { exe: "/bin/sh", args: ["-l", "-c", shellCmd] },
  ];

  for (const attempt of attempts) {
    let r: AddonCommandResult;
    try {
      r = await addon.runCommand({ ...attempt, timeoutMs: 15000 });
    } catch {
      continue;
    }
    const found = pickPathLine(r.out || "", mustEndWith);
    if (found) return found;
  }
  return "";
}

/**
 * 定位 node 可执行文件绝对路径。
 * 优先用 login shell 查 PATH；查不到时退到常见安装位置（含 nvm/volta）。
 */
async function locateNode(addon: KlingCliAddon): Promise<string> {
  if (isWindows()) {
    // Windows: `where node` 找的是真正的 .exe
    const viaWhere = await whichViaShell(addon, "where node", ".exe");
    if (viaWhere) return viaWhere;

    // 常见安装位置兜底
    const appdata = envOf("APPDATA");
    for (const p of [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
      appdata ? `${appdata}\\nvm\\current\\node.exe` : "",
    ]) {
      if (!p) continue;
      const probe = await addon.runCommand({
        exe: p,
        args: ["--version"],
        timeoutMs: 10000,
      });
      if (probe.ok) return p;
    }
    return "";
  }

  const viaShell = await whichViaShell(addon, "command -v node", "node");
  if (viaShell) return viaShell;

  // nvm / volta 等把 node 装在用户目录下，且只在 .zshrc 里改 PATH —— 显式探测
  const viaVersionManager = await whichViaShell(
    addon,
    'for p in ~/.nvm/versions/node/*/bin/node ~/.volta/bin/node ~/.local/bin/node; do [ -x "$p" ] && echo "$p" && break; done',
    "node",
  );
  if (viaVersionManager) return viaVersionManager;

  for (const p of [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
  ]) {
    const probe = await addon.runCommand({
      exe: p,
      args: ["--version"],
      timeoutMs: 10000,
    });
    if (probe.ok) return p;
  }
  return "";
}

/**
 * 定位 npm 全局包根目录（含 @klingai/ 的那一层）。
 *
 * 用 node 直接跑 npm 自带的 npm-cli.js，不要求 `npm` 本身在 PATH 里
 * （npm 同样是 `#!/usr/bin/env node` 脚本，PATH 精简时同样跑不起来）。
 */
async function locateNpmRoot(
  addon: KlingCliAddon,
  nodePath: string,
): Promise<string> {
  if (isWindows()) {
    // Windows: npm 全局根不能用 node 目录推导（node 安装目录布局与 unix 完全不同）。
    //
    // 收集所有可能的候选根，逐个探测 @klingai 是否真在里面：
    //   - `npm root -g` 的输出（最准，但依赖 PATH 里有 npm）
    //   - `where npm` 的每一项的同级 node_modules
    //     （注意 where npm 会返回多项：node 自带的 C:\Program Files\nodejs\npm.cmd
    //      和用户全局的 %APPDATA%\npm\npm.cmd，全局包在后者）
    //   - %APPDATA%\npm\node_modules（标准全局安装位置）
    const candidates: string[] = [];

    const viaRoot = await whichViaShell(addon, "npm root -g");
    if (viaRoot) candidates.push(viaRoot);

    const npmCmds = await whichViaShell(addon, "where npm");
    if (npmCmds) {
      for (const cmdPath of npmCmds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        const dir = cmdPath.replace(/[\\/][^\\/]+$/, "");
        if (dir) candidates.push(`${dir}\\node_modules`);
      }
    }

    const appdata = envOf("APPDATA");
    if (appdata) candidates.push(`${appdata}\\npm\\node_modules`);

    // 去重
    const unique = Array.from(new Set(candidates.map((c) => c.replace(/\//g, "\\"))));

    // 探测 @klingai 是否在其中 —— 这比任何单一来源都可靠
    for (const root of unique) {
      const klingDir = `${root}\\@klingai`;
      const probe = await addon.runCommand({
        exe: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", `if exist "${klingDir}" (echo yes) else (echo no)`],
        timeoutMs: 10000,
      });
      if (/\byes\b/i.test(probe.out || "")) {
        return root;
      }
    }

    // 都没探到 @klingai 时返回第一个候选（让上层用探测 JS 入口的方式再试一次）
    return unique[0] || "";
  }

  const nodeDir = nodePath.replace(/[\\/][^\\/]+$/, "");
  const npmCli = `${nodeDir}/../lib/node_modules/npm/bin/npm-cli.js`;
  const r = await addon.runCommand({
    exe: nodePath,
    args: [npmCli, "root", "-g"],
    timeoutMs: 20000,
  });
  const fromCli = pickPathLine(r.out || "");
  if (fromCli) return fromCli;

  // 兜底：<nodeDir>/../lib/node_modules（标准 node 安装布局）
  return `${nodeDir}/../lib/node_modules`;
}


/**
 * 定位 CLI 的执行入口：node 可执行文件 + CLI 的 JS 入口。
 * 找不到返回 null。
 */
async function locateCliEntry(addon: KlingCliAddon): Promise<CliEntry | null> {
  // Windows 与 macOS 走同一套「node 绝对路径 + CLI 的 JS 入口」策略。
  //
  // 为什么 Windows 不用 kling.cmd:
  //   npm 全局装出来的 kling.cmd 内部靠 PATH 找 node
  //   (`IF EXIST "%dp0%\node.exe" ... ELSE SET "_prog=node"`),
  //   而 PR 从桌面启动时继承的是精简 PATH,可能没有 node —— 结果是
  //   CLI 跑起来但报 "node 不是内部或外部命令"。
  //   直接用 node 绝对路径执行 JS 入口可以完全绕开 PATH 依赖。
  //
  // 也不能直接用 `where kling` 的结果:它第一行是无扩展名的 `kling`
  // (npm 的 unix shim),CreateProcessW 执行不了。

  const nodePath = await locateNode(addon);
  if (!nodePath) {
    console.warn("[klingCli] 未找到 node（shell 的 PATH 中也没有）");
    return null;
  }

  const npmRoot = await locateNpmRoot(addon, nodePath);
  if (!npmRoot) return null;

  // 国内站 @klingai/cli-cn / 海外站 @klingai/cli-global 二选一
  // 路径分隔符按平台:Windows 用反斜杠,避免 node 在某些路径下解析异常
  const sep = isWindows() ? "\\" : "/";
  for (const pkg of ["cli-cn", "cli-global"]) {
    const js = [npmRoot, "@klingai", pkg, "dist", "cli.js"].join(sep);
    const probe = await addon.runCommand({
      exe: nodePath,
      args: [js, "--version"],
      timeoutMs: 20000,
    });
    if (probe.ok && /kling-cli/i.test(probe.out || "")) {
      return { exe: nodePath, prefixArgs: [js] };
    }
  }
  return null;
}

/** 取得（并缓存）CLI 入口 */
async function getCliEntry(addon: KlingCliAddon): Promise<CliEntry | null> {
  if (!entryPromise) {
    entryPromise = locateCliEntry(addon).catch((e) => {
      console.warn("[klingCli] CLI 定位失败:", e?.message || e);
      return null;
    });
  }
  const entry = await entryPromise;
  if (!entry) {
    entryPromise = null; // 失败不缓存，允许重试
  }
  return entry;
}

/** 从文本判断是否为「未登录」 */
function looksLikeNotLoggedIn(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("登录态") ||
    t.includes("access_token") ||
    t.includes("kling login") ||
    t.includes("not logged in") ||
    t.includes("unauthorized") ||
    t.includes("no valid login")
  );
}

// ---------- 并发限流 ----------
//
// 为什么需要：每次 CLI 调用都会 fork 一个独立的 node 进程，
// 单进程峰值 RSS 实测 312MB（query_tasks）/ 352MB（who_am_i）——
// node 要加载 CLI 那份 17k 行 esbuild 产物 + 111 个依赖。
// 16 个并发实测吃掉 2.2GB 内存，在 Premiere 里再叠加渲染/编解码就会明显卡顿。
//
// 限流点选在**真正要起进程之前**（runCommand 之前）：
// locateNode / locateNpmRoot 那些探测步骤虽也起进程，但只在首次定位时跑一次，
// 且必须串行（它们共享 entryPromise），不必纳入业务限流。
//
// 排队超时：不能让请求无限等 —— 超过阈值直接失败并提示，
// 否则用户会看到「生成中」卡死，实际是排在队列里。

/** 同时存活的 CLI 业务进程数上限 */
const MAX_CONCURRENT_CLI = 3;

/**
 * CLI 请求的优先级。
 *
 * foreground：用户直接感知的请求（提交生成 / 轮询查询）。
 * background：后台预热请求（素材预上传），**可被前台插队**。
 *
 * 为什么需要分级：预上传与提交抢同一批槽位，若不做优先级区分，
 * 用户点「生成」时槽位可能被预上传占满 → 提交排队 → 又变成「排队 N 秒」。
 * 分级后前台永远优先，后台只在有富余槽位时才跑。
 */
export type KlingCliPriority = "foreground" | "background";

/** 排队等待的最长时间（毫秒）—— 超过则放弃并报错 */
let QUEUE_WAIT_TIMEOUT_MS = 30000;

/** 仅测试用：缩短排队超时，避免测试要等 30s */
export function __setKlingCliQueueTimeout(ms: number): void {
  QUEUE_WAIT_TIMEOUT_MS = ms;
}

/** 当前在跑的进程数 */
let runningCount = 0;

/** 等待中的队列条目 */
interface WaitEntry {
  resolve: (ok: boolean) => void;
  timer: any;
  settled: boolean;
  priority: KlingCliPriority;
}

/** 等待中的队列（前台优先，后台次之；同优先级内先进先出） */
const fgQueue: WaitEntry[] = [];
const bgQueue: WaitEntry[] = [];

/** 取得一个执行槽位。
 *
 * 队列满 / 等待超时都返回 false（调用方应据此放弃本次执行）。
 * 等待超时后会把该等待者从队列里摘掉，避免占位。
 */
async function acquireSlot(priority: KlingCliPriority): Promise<boolean> {
  // 有富余槽位时：后台请求要让位给排队中的前台请求
  if (runningCount < MAX_CONCURRENT_CLI) {
    if (priority === "background" && fgQueue.length > 0) {
      // 前台在等 → 后台不插队，进队列
    } else {
      runningCount++;
      return true;
    }
  }
  return await new Promise<boolean>((resolve) => {
    const queue = priority === "foreground" ? fgQueue : bgQueue;
    const entry: WaitEntry = {
      resolve: (ok: boolean) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        // 拿到槽位：计数已在释放方交接时 +1
        resolve(ok);
      },
      timer: null as any,
      settled: false,
      priority,
    };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      resolve(false);
    }, QUEUE_WAIT_TIMEOUT_MS);
    queue.push(entry);
  });
}

/** 释放槽位；若有等待者则直接交接给它（保持并发数不变），前台优先 */
function releaseSlot(): void {
  const next = fgQueue.shift() || bgQueue.shift();
  if (next) {
    next.resolve(true);
  } else {
    runningCount = Math.max(0, runningCount - 1);
  }
}

/** 当前限流状态（测试 / 诊断用） */
export function getKlingCliConcurrencyState(): {
  running: number;
  queued: number;
  max: number;
} {
  return {
    running: runningCount,
    queued: fgQueue.length + bgQueue.length,
    max: MAX_CONCURRENT_CLI,
  };
}

/** 仅测试用：清空限流状态 */
export function __resetKlingCliConcurrency(): void {
  for (const w of [...fgQueue, ...bgQueue]) {
    w.settled = true;
    if (w.timer) clearTimeout(w.timer);
  }
  fgQueue.length = 0;
  bgQueue.length = 0;
  runningCount = 0;
}

/**
 * 用指定 addon 执行一条可灵 CLI 命令（可注入假 addon，便于测试）。
 *
 * @param args   CLI 子命令 + 参数（如 ["who_am_i", "--quiet"]）
 * @param opts.timeoutMs 超时（默认 60s）
 * @param opts.priority 优先级（默认 foreground；预上传等后台任务用 background）
 */
export async function execKlingCliWith(
  addon: KlingCliAddon | null,
  args: string[],
  opts?: { timeoutMs?: number; priority?: KlingCliPriority },
): Promise<KlingCliExecResult> {
  if (!addon) {
    return {
      ok: false,
      code: "addon_unavailable",
      error:
        "C++ Hybrid addon 不可用：可灵功能需要 Adobe PR ≥ 26.2（uxpaddon 未加载）。",
    };
  }

  const entry = await getCliEntry(addon);
  if (!entry) {
    return {
      ok: false,
      code: "cli_not_installed",
      error:
        "未找到可灵 CLI。请先安装：国内站 npm i -g @klingai/cli-cn，海外站 npm i -g @klingai/cli-global。",
    };
  }

  // 并发限流：排队等槽位，避免同时起太多 node 进程把内存吃满
  // 后台任务（预上传）可被前台请求插队
  const gotSlot = await acquireSlot(opts?.priority ?? "foreground");
  if (!gotSlot) {
    return {
      ok: false,
      code: "command_failed",
      error: `可灵 CLI 请求排队超时（等待超过 ${Math.round(
        QUEUE_WAIT_TIMEOUT_MS / 1000,
      )}s）。请稍后重试。`,
    };
  }

  let r: AddonCommandResult;
  try {
    r = await addon.runCommand({
      exe: entry.exe,
      args: [...entry.prefixArgs, ...args],
      timeoutMs: opts?.timeoutMs ?? 60000,
    });
  } catch (e: any) {
    releaseSlot();
    return {
      ok: false,
      code: "command_failed",
      error: `执行可灵 CLI 异常: ${e?.message || e}`,
    };
  }
  releaseSlot();

  if (r.error === "timeout") {
    return {
      ok: false,
      code: "timeout",
      error: "可灵 CLI 执行超时。",
      raw: r.out,
    };
  }

  const stdout = (r.out || "").trim();

  // stdout 为空：CLI 走了 stderr 报错路径（AuthError 等）
  if (!stdout) {
    const stderr = (r.err || "").trim();
    if (looksLikeNotLoggedIn(stderr)) {
      return {
        ok: false,
        code: "not_logged_in",
        error: `可灵 CLI 未登录。请在终端执行 \`kling login\` 完成登录。${stderr}`,
      };
    }
    return {
      ok: false,
      code: "command_failed",
      error: stderr || `可灵 CLI 执行失败（exit ${r.exitCode}）。`,
    };
  }

  // stdout 非 JSON
  let envelope: KlingEnvelope;
  try {
    envelope = JSON.parse(stdout) as KlingEnvelope;
  } catch {
    return {
      ok: false,
      code: "bad_output",
      error: "可灵 CLI 输出不是合法 JSON。",
      raw: stdout,
    };
  }

  // 业务失败（envelope.ok === false）：body 可能是字符串或对象
  if (!envelope.ok) {
    const bodyText =
      typeof envelope.body === "string"
        ? envelope.body
        : JSON.stringify(envelope.body ?? "");
    if (looksLikeNotLoggedIn(bodyText)) {
      return {
        ok: false,
        code: "not_logged_in",
        error: `可灵 CLI 未登录。请在终端执行 \`kling login\` 完成登录。${bodyText}`,
        raw: stdout,
      };
    }
    return {
      ok: false,
      code: "command_failed",
      error: bodyText || `可灵 CLI 返回失败（status ${envelope.status}）。`,
      raw: stdout,
    };
  }

  return {
    ok: true,
    code: "ok",
    data: envelope.body,
    raw: stdout,
  };
}

/**
 * 执行一条可灵 CLI 命令（自动探测 addon）。
 */
export async function execKlingCli(
  args: string[],
  opts?: { timeoutMs?: number; priority?: KlingCliPriority },
): Promise<KlingCliExecResult> {
  const addon = await loadAddon();
  return execKlingCliWith(addon, args, opts);
}

/** 供 UI 展示用：把错误码翻译成一句人话 */
export function describeKlingCliCode(code: KlingCliCode): string {
  switch (code) {
    case "addon_unavailable":
      return "C++ Hybrid addon 不可用（需 Adobe PR ≥ 26.2）";
    case "cli_not_installed":
      return "未安装可灵 CLI";
    case "not_logged_in":
      return "可灵 CLI 未登录";
    case "bad_output":
      return "可灵 CLI 输出解析失败";
    case "timeout":
      return "可灵 CLI 执行超时";
    case "command_failed":
      return "可灵 CLI 执行失败";
    default:
      return "正常";
  }
}

/** 仅测试用：清空入口缓存 */
export function __resetKlingCliCache(): void {
  entryPromise = null;
  addonPromise = null;
}
