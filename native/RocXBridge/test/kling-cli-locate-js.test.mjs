// kling-cli-locate-js.test.mjs
// 验证 klingCli.ts 的 Windows 定位逻辑 —— 用假 addon 后端模拟 C++ 的 runCommand。
//
// 假 addon 用 node child_process 真实执行,模拟 C++ 的行为:
//   - exe 是 .cmd/.bat 时用 cmd.exe /d /s /c 包裹(对齐 BuildCommandLine)
//   - 其余直接 spawn
//
// 跑法: node native/RocXBridge/test/kling-cli-locate-js.test.mjs

import { spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

// ---- 复刻 klingCli.ts 的 pickPathLine ----
function pickPathLine(out, mustEndWith) {
  for (const raw of (out || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(line)) continue;
    if (mustEndWith && !line.toLowerCase().endsWith(mustEndWith.toLowerCase())) continue;
    return line;
  }
  return "";
}

// ---- 假 addon：模拟 C++ RocXBridgeCommandWin.cpp 的 RunCommandForPlatform ----
function isBatch(exe) {
  const lower = exe.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

const fakeAddon = {
  runCommand(opts) {
    const { exe, args = [], timeoutMs = 30000 } = opts;
    let cmd = exe;
    let cmdArgs = args;
    if (isBatch(exe)) {
      // 对齐 C++ BuildCommandLine：cmd.exe /d /s /c "exe args..."
      const line = [exe, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ");
      cmd = "cmd.exe";
      cmdArgs = ["/d", "/s", "/c", line];
    }
    const r = spawnSync(cmd, cmdArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return Promise.resolve({
      ok: r.status === 0,
      exitCode: r.status ?? -1,
      out: r.stdout || "",
      err: r.stderr || "",
      truncated: false,
      error: r.error ? String(r.error.message) : undefined,
    });
  },
};

// ---- 复刻 klingCli.ts 的 Windows 分支 ----
function pickAllPathLines(out) {
  const result = [];
  for (const raw of (out || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(line)) continue;
    result.push(line);
  }
  return result;
}

async function whichViaShell(shellCmd, mustEndWith) {
  const r = await fakeAddon.runCommand({
    exe: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", shellCmd],
    timeoutMs: 15000,
  });
  const found = pickPathLine(r.out || "", mustEndWith);
  if (found) return found;
  const all = pickAllPathLines(r.out || "");
  if (all.length) return all.join("\n");
  return "";
}

async function locateNode() {
  const viaWhere = await whichViaShell("where node", ".exe");
  if (viaWhere) return viaWhere;
  for (const p of [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    `${process.env.APPDATA || ""}\\nvm\\current\\node.exe`,
  ]) {
    if (!p) continue;
    const probe = await fakeAddon.runCommand({ exe: p, args: ["--version"], timeoutMs: 10000 });
    if (probe.ok) return p;
  }
  return "";
}

async function locateNpmRoot() {
  const candidates = [];
  const viaRoot = await whichViaShell("npm root -g");
  if (viaRoot) candidates.push(viaRoot);
  const npmCmds = await whichViaShell("where npm");
  if (npmCmds) {
    for (const cmdPath of npmCmds.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const dir = cmdPath.replace(/[\\/][^\\/]+$/, "");
      if (dir) candidates.push(`${dir}\\node_modules`);
    }
  }
  const appdata = process.env.APPDATA || "";
  if (appdata) candidates.push(`${appdata}\\npm\\node_modules`);
  const unique = Array.from(new Set(candidates.map((c) => c.replace(/\//g, "\\"))));
  console.log("  候选 npm 根:", unique);
  for (const root of unique) {
    const klingDir = `${root}\\@klingai`;
    const probe = await fakeAddon.runCommand({
      exe: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `if exist "${klingDir}" (echo yes) else (echo no)`],
      timeoutMs: 10000,
    });
    if (/\byes\b/i.test(probe.out || "")) {
      console.log("  ✅ 探测到 @klingai:", root);
      return root;
    }
  }
  return unique[0] || "";
}

async function locateCliEntry() {
  const nodePath = await locateNode();
  if (!nodePath) return null;
  const npmRoot = await locateNpmRoot();
  if (!npmRoot) return null;
  const sep = IS_WINDOWS ? "\\" : "/";
  for (const pkg of ["cli-cn", "cli-global"]) {
    const js = [npmRoot, "@klingai", pkg, "dist", "cli.js"].join(sep);
    const probe = await fakeAddon.runCommand({
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

// ---- 跑起来 ----
console.log("平台:", process.platform);
if (!IS_WINDOWS) {
  console.log("SKIP: 该测试针对 Windows");
  process.exit(0);
}

console.log("\n=== 旧逻辑对照: where kling 取第一行 ===");
const oldOut = await fakeAddon.runCommand({
  exe: "C:\\Windows\\System32\\cmd.exe",
  args: ["/d", "/s", "/c", "where kling"],
});
const oldFirst = (oldOut.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
console.log("  第一行:", oldFirst);
console.log("  是 .cmd 吗:", (oldFirst || "").toLowerCase().endsWith(".cmd"), "← 旧逻辑失败点");
console.log("  pickPathLine 修正后:", pickPathLine(oldOut.out || "", "kling.cmd"));

console.log("\n=== 新逻辑 locateCliEntry ===");
const entry = await locateCliEntry();
if (!entry) {
  console.log("RESULT: FAIL (未定位到可灵 CLI)");
  process.exit(1);
}
console.log("  exe       :", entry.exe);
console.log("  prefixArgs:", entry.prefixArgs);

console.log("\n=== 实际执行 who_am_i ===");
const r = await fakeAddon.runCommand({
  exe: entry.exe,
  args: [...entry.prefixArgs, "who_am_i", "--quiet"],
  timeoutMs: 60000,
});
console.log("  ok:", r.ok, "exitCode:", r.exitCode);
console.log("  stdout(前 200 字):", (r.out || "").slice(0, 200));
if (r.err) console.log("  stderr:", r.err.slice(0, 300));

let envelope = null;
try {
  envelope = JSON.parse((r.out || "").trim());
} catch {
  console.log("RESULT: FAIL (stdout 不是合法 JSON)");
  process.exit(1);
}
console.log("  envelope.ok:", envelope.ok, "status:", envelope.status);
if (!envelope.ok) {
  console.log("RESULT: FAIL (业务失败)");
  process.exit(1);
}
console.log("\nRESULT: OK");
