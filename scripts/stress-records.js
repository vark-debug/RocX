// scripts/stress-records.js
//
// UI 渲染压力测试数据生成器（Node 18+，依赖 PATH 上的 ffmpeg）。
//
// 两件事：
//   1. 用 ffmpeg 生成一批测试视频（横屏 / 竖屏 / 方形 / 不同分辨率）
//   2. 伪造 <项目名>.ai-gen.json，把 records 填充到指定条数
//
// 素材复用策略（重要）：
//   records 的 workFile 全部指向同一个视频文件。记录的视频路径与视频文件本身
//   在渲染压力上是解耦的 —— 缩略图缓存按 rec.id 建（webview-ui/src/composables/
//   useRecordPreview.ts），canvas 抽帧对每条记录独立执行，所以 200 条记录指向
//   同一个视频仍会跑 200 次抽帧，渲染压力照样压得出来。
//   rec.id 必须唯一，否则缩略图缓存互相顶掉，测出来会比真实情况轻很多。
//
// 用法：
//   node scripts/stress-records.js                    # 默认 120 条
//   node scripts/stress-records.js --count 300
//   node scripts/stress-records.js --videos 1--keep-records       # 最极端：1 个视频
//   node scripts/stress-records.js --project /path/to/B.prproj
//   node scripts/stress-records.js --restore# 恢复 --backup 指定的备份
//
// 注意：注入前请先在 Premiere 里卸载/关闭面板，PR 运行时会按 200ms 防抖把内存
// 里的记录写回磁盘，覆盖你注入的 JSON。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = {
    count: 120,
    videos: 3,
    project: "",
    mediaDir: "",
    keepRecords: false,
    restore: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") out.count = parseInt(argv[++i], 10);
    else if (a === "--videos") out.videos = parseInt(argv[++i], 10);
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--media-dir") out.mediaDir = argv[++i];
    else if (a === "--keep-records") out.keepRecords = true;
    else if (a === "--restore") out.restore = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) fail(`未知参数：${a}`);
  }
  if (!Number.isFinite(out.count) || out.count < 1) fail("--count 必须是正整数");
  if (!Number.isFinite(out.videos) || out.videos < 1) fail("--videos 必须是正整数");
  return out;
}

function fail(msg) {
  console.error(`[stress] ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 路径工具

/** 复刻 src/core/records.ts 的 splitProjectPath：取末段并去扩展名 */
function jsonBaseName(projectPath) {
  const lastSeg = projectPath.split(/[\\/]/).pop() || "";
  const dot = lastSeg.lastIndexOf(".");
  return dot > 0 ? lastSeg.slice(0, dot) : lastSeg;
}

function recordsJsonPath(projectPath) {
  const dir = path.dirname(projectPath);
  return path.join(dir, `${jsonBaseName(projectPath)}.ai-gen.json`);
}

/** src/core/pathUtils.pathToFileUrl 的等价物：转 file:// URL，空格转 %20 */
function pathToFileUrl(p) {
  return "file://" + p.replace(/ /g, "%20");
}

// ---------------------------------------------------------------- ffmpeg

function haveFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * 视频规格。刻意混入横屏 / 竖屏 / 方形与高低分辨率：
 * 记录区预览是强制 16:9（竖屏走letterbox），不同比例能压出缩放与letterbox 分支。
 */
const VIDEO_SPECS = [
  { name: "landscape-1920x1080", w: 1920, h: 1080, ratio: "16:9", resolution: "768P", duration: 5 },
  { name: "portrait-1080x1920", w: 1080, h: 1920, ratio: "9:16", resolution: "768P", duration: 5 },
  { name: "square-1080x1080", w: 1080, h: 1080, ratio: "1:1", resolution: "768P", duration: 4 },
  { name: "landscape-3840x2160", w: 3840, h: 2160, ratio: "16:9", resolution: "2K", duration: 5 },
  { name: "landscape-640x360", w: 640, h: 360, ratio: "16:9", resolution: "480P", duration: 3 },
];

function makeVideo(ffmpeg, spec, outPath) {
  // testsrc2 是ffmpeg 内置测试图源，无需外部素材；drawbox + drawtext 便于肉眼区分
  const label = spec.name;
  const fontSize = Math.max(18, Math.round(spec.w / 40));
  const filter = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=${spec.w > spec.h ? "#1f6feb" : "#8957e5"}:t=fill`,
    `drawbox=x=0:y=0:w=iw:h=${Math.round(spec.h / 8)}:color=black@0.55:t=fill`,
    // 字体文件不一定存在，失败则退回无文字版本
    `drawtext=text='${label}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2-40:box=1:boxcolor=black@0.45:boxborderw=16`,
    `drawtext=text='${spec.w}x${spec.h} ${spec.duration}s':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2+40:box=1:boxcolor=black@0.45:boxborderw=16`,
  ].join(",");

  const baseArgs = [
    "-y",
    "-f", "lavfi",
    "-i", `testsrc2=size=${spec.w}x${spec.h}:rate=24:duration=${spec.duration}`,
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    // 关键：压测要的是解码与渲染压力，不要码率成为瓶颈
    "-crf", "28",
    "-movflags", "+faststart",
    outPath,
  ];

  let r = spawnSync(ffmpeg, baseArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    // drawtext 失败（缺字体等）→ 去掉文字层重试
    const noText = [
      "-y",
      "-f", "lavfi",
      "-i", `testsrc2=size=${spec.w}x${spec.h}:rate=24:duration=${spec.duration}`,
      "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=${spec.w > spec.h ? "#1f6feb" : "#8957e5"}:t=fill`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-crf", "28",
      "-movflags", "+faststart",
      outPath,
    ];
    r = spawnSync(ffmpeg, noText, { encoding: "utf8" });
  }
  if (r.status !== 0) {
    console.warn(`[stress] ffmpeg 生成失败：${label}`);
    console.warn(String(r.stderr || "").split("\n").slice(-6).join("\n"));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 记录构造

const MODELS = [
  { model: "MiniMax-H3", ratio: "16:9", resolution: "768P", duration: 5 },
  { model: "MiniMax-H3", ratio: "9:16", resolution: "768P", duration: 5 },
  { model: "MiniMax-H3-max", ratio: "1:1", resolution: "2K", duration: 6 },
  { model: "MiniMax-H3", ratio: "16:9", resolution: "2K", duration: 8 },
];

const PROMPTS = [
  "镜头缓慢推进穿过雾气笼罩的森林，晨光透过树冠形成体积光",
  "城市夜景航拍，霓虹灯在雨后的柏油路面上产生湿反射，镜头平移跟随",
  "特写：咖啡杯表面热气升腾，浅景深，背景虚化成柔和光斑",
  "延时摄影：云层在山谷中快速流动，光影在山体上移动",
  "人物剪影站在逆光窗前，窗帘被微风轻轻吹动",
  "微观视角：昆虫翅膀振动的高速摄影，背景为绿色叶片",
  "雪原上的孤树，风吹起雪雾，镜头缓慢环绕360 度",
  "老旧书店内部，木质书架与暖色灯光，镜头向深处推进",
];

/**
 * 状态分布。刻意混入各状态：
 *   generated  —— 正常路径，走 canvas 抽帧 + 16:9 预览
 *   imported   —— 同样有预览，但带 importedFile 语义
 *   generating —— 显示进度，无预览
 *   failed     —— 错误卡片
 */
function buildStatus(i) {
  const m = i % 20;
  if (m === 5) return "generating";
  if (m === 11) return "failed";
  if (m === 17) return "imported";
  return "generated";
}

function buildRecord(i, ctx) {
  const spec = ctx.specs[i % ctx.specs.length];
  const model = MODELS[i % MODELS.length];
  const status = buildStatus(i);
  const createdAt = new Date(Date.now() - i * 60_000).toISOString();

  const rec = {
    id: `stress-${String(i + 1).padStart(4, "0")}-${randomUUID().slice(0, 8)}`,
    createdAt,
    prompt: PROMPTS[i % PROMPTS.length],
    kind: "video",
    params: {
      model: model.model,
      ratio: model.ratio,
      duration: model.duration,
      resolution: model.resolution,
      provider: "minimax",
    },
    references: [],
    status,
    submittedAt: createdAt,
    usage: {
      total_seconds: model.duration,
    },
    projectGuid: ctx.projectGuid,
    projectPath: ctx.projectPath,
  };

  if (status === "generating") {
    rec.taskId = `stress-task-${i}`;
    rec.lastPolledAt = createdAt;
    return rec;
  }

  if (status === "failed") {
    rec.taskId = `stress-task-${i}`;
    rec.error = {
      message: "鉴权失败（401）— API Key 无效或不正确",
      requestId: randomUUID().replace(/-/g, ""),
      httpStatus: 401,
      errorType: "authorized_error",
    };
    return rec;
  }

  // generated / imported 都指向同一个视频文件 —— 这是刻意的，见文件头说明
  rec.workFile = ctx.workFile;

  if (status === "imported") {
    rec.importedFile = ctx.importedFile;
  } else {
    rec.taskId = `stress-task-${i}`;
    rec.usage = { total_seconds: model.duration };
  }
  return rec;
}

// ---------------------------------------------------------------- 主流程

function findDefaultProject() {
  // 优先找仓库内 压力测试/ 目录，其次扫描 scripts 的同级目录
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidate = path.resolve(here, "..", "压力测试", "A.prproj");
  if (fs.existsSync(candidate)) return candidate;
  fail(
    "未找到默认工程。请用 --project /path/to/X.prproj 指定，" +
      "或确认 压力测试/A.prproj 存在",
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "用法：node scripts/stress-records.js [选项]",
        "",
        "  --count N       生成的记录条数（默认 120）",
        "  --videos N      生成的视频个数（默认 3，最多 5；1 = 全部记录共用一个视频）",
        "  --project P     .prproj 路径（默认为 压力测试/A.prproj）",
        "  --media-dir D   视频输出目录（默认为工程旁的 stress-media/）",
        "  --keep-records  保留 JSON 里已有记录（默认替换）",
        "  --restore F     从备份文件恢复并退出",
        "",
        "示例：",
        "  node scripts/stress-records.js --count 300 --videos 1",
      ].join("\n"),
    );
    return;
  }

  const ffmpeg = "ffmpeg";
  if (!haveFfmpeg()) fail("未找到 ffmpeg。请先安装并确保在 PATH 上（brew install ffmpeg）");

  const projectPath = path.resolve(args.project || findDefaultProject());
  if (!fs.existsSync(projectPath)) fail(`工程不存在：${projectPath}`);

  const jsonPath = recordsJsonPath(projectPath);
  const projectDir = path.dirname(projectPath);

  // --restore：恢复备份后退出
  if (args.restore) {
    const src = path.resolve(args.restore);
    if (!fs.existsSync(src)) fail(`备份不存在：${src}`);
    fs.copyFileSync(src, jsonPath);
    console.log(`[stress] 已恢复：${jsonPath}`);
    return;
  }

  console.log(`[stress] 工程      ${projectPath}`);
  console.log(`[stress] 记录文件  ${jsonPath}`);

  if (!fs.existsSync(jsonPath)) {
    fail(
      `记录文件不存在：${jsonPath}\n` +
        "        请先在 Premiere 里打开该工程并生成过一次，或手动创建空壳 JSON",
    );
  }

  // 读现有 JSON，拿 projectGuid
  const raw = fs.readFileSync(jsonPath, "utf8");
  let current;
  try {
    current = JSON.parse(raw);
  } catch (e) {
    fail(`现有 JSON 解析失败：${e.message}`);
  }

  // 备份
  const backup = `${jsonPath}.stress-backup`;
  fs.copyFileSync(jsonPath, backup);
  console.log(`[stress] 已备份    ${backup}`);

  const ctx = {
    projectPath,
    projectGuid: current.projectGuid || "",
    specs: [],
    workFile: "",
    importedFile: "",
  };

  // ---- 生成视频
  const mediaDir = path.resolve(args.mediaDir || path.join(projectDir, "stress-media"));
  fs.mkdirSync(mediaDir, { recursive: true });
  const importDir = path.join(projectDir, "AI-Generated-Media", "Imports");
  fs.mkdirSync(importDir, { recursive: true });

  const specCount = Math.min(args.videos, VIDEO_SPECS.length);
  const madePaths = [];
  for (let i = 0; i < specCount; i++) {
    const spec = VIDEO_SPECS[i];
    const outPath = path.join(mediaDir, `${spec.name}.mp4`);
    if (fs.existsSync(outPath)) {
      console.log(`[stress] 视频已存在，跳过：${spec.name}.mp4`);
    } else {
      process.stdout.write(`[stress] 生成视频 ${spec.name} (${spec.w}x${spec.h}) ... `);
      if (!makeVideo(ffmpeg, spec, outPath)) continue;
      process.stdout.write("完成\n");
    }
    madePaths.push(outPath);
    ctx.specs.push(spec);
  }
  if (madePaths.length === 0) fail("没有可用视频，无法生成记录");

  ctx.workFile = madePaths[0];
  // imported 记录指向 Imports/ 下的副本，避免与 workFile 同路径
  const importedCopy = path.join(importDir, path.basename(madePaths[0]));
  if (!fs.existsSync(importedCopy)) fs.copyFileSync(madePaths[0], importedCopy);
  ctx.importedFile = importedCopy;

  console.log(
    `[stress] 视频 ${madePaths.length} 个，输出目录 ${mediaDir}\n` +
      `[stress] 全部记录的 workFile 指向：${ctx.workFile}`,
  );

  // ---- 构造记录
  const existing = args.keepRecords && Array.isArray(current.records) ? current.records : [];
  const generated = [];
  for (let i = 0; i < args.count; i++) {
    generated.push(buildRecord(i, ctx));
  }

  const next = {
    projectGuid: ctx.projectGuid,
    projectPath,
    records: [...existing, ...generated],
    storageMode: current.storageMode || "primary",
    promptOptimizations: current.promptOptimizations || [],
  };

  fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2), "utf8");

  // ---- 统计输出
  const byStatus = {};
  for (const r of next.records) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const size = fs.statSync(jsonPath).size;
  console.log(`\n[stress] 已写入 ${next.records.length} 条记录（JSON ${(size / 1024).toFixed(1)} KB）`);
  console.log(
    `[stress] 状态分布  ` +
      Object.entries(byStatus)
        .map(([k, v]) => `${k}=${v}`)
        .join("  "),
  );
  console.log(`\n[stress] 下一步：`);
  console.log(`  1. 确认 Premiere 里的 RocX 面板已关闭（否则运行时会写回覆盖）`);
  console.log(`  2. 打开工程 ${path.basename(projectPath)}，打开面板，观察记录区渲染`);
  console.log(`  3. 恢复：node scripts/stress-records.js --restore ${backup}`);
}

main();