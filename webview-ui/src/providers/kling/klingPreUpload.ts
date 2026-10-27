/**
 * 可灵素材预上传（把「点生成 → 显示生成中」的空窗从 ~10s 压到 ~2s）
 *
 * 根因：素材以**本地路径**交给可灵 CLI 时，CLI 会在提交命令内部现传 CDN
 * （http.log 实测 `POST /api/mcp/files` durationMs 4.0-8.7s），
 * 这段时间全部落在「点生成 → 显示生成中」的空窗里。
 *
 * 破局点：CLI 的 resolveFileUrl 对 http(s) 是**直通不重传**的
 * （cli.js：`if (/^https?:\/\//.test(file)) return file;`）——
 * 所以抓素材时后台先传一次拿到 CDN 直链，提交时直接传 URL。
 *
 * 直链放在 ReferenceItem.klingFileUrl（**不**占用 fileId）：
 * fileId 语义是「provider 自家文件服务的 id」且与 uploadProvider 绑定，
 * 可灵没有这层服务，混用会污染 minimax 的换 provider 补传逻辑。
 *
 * 失败不阻断：直链拿不到就留空，提交时回退本地路径，由 CLI 自行上传
 * （与改造前完全一致的行为）。
 */
import { bridge } from "../../services/bridge";
import type { ReferenceItem } from "@shared/messages";

/**
 * 直链有效期（毫秒）。
 *
 * 可灵 CDN 侧实测对象过期在 16 天量级（`x-oss-expiration`），
 * 但签名参数（pkey）另有其有效期，旧直链实测会 403 —— 这里保守取 6 小时。
 * 过期后提交回退本地路径重传（宁可慢，不可错）。
 */
export const KLING_URL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 同时进行的预上传数上限。
 *
 * UXP 侧 CLI 信号量上限是 3（MAX_CONCURRENT_CLI），轮询也在抢同一批槽位 ——
 * 这里留 1 个槽给提交/轮询，避免预上传把提交堵在队列里。
 */
const MAX_CONCURRENT_PRE_UPLOAD = 2;

/** 一次预上传的状态（按 localPath 索引） */
interface UploadState {
  /** 上传任务本身（同一路径只起一次） */
  promise: Promise<string | null>;
  /** 成功时的直链 */
  url?: string;
  /** 直链的获取时刻（毫秒） */
  at?: number;
  /** 是否已确定失败（失败不再重试，提交时回退本地路径） */
  failed?: boolean;
}

const states = new Map<string, UploadState>();

/** 预上传排队器 */
let active = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT_PRE_UPLOAD) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue.push(resolve));
}

function releaseSlot(): void {
  const next = queue.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

/**
 * 从 CLI 响应里取直链。
 *
 * CLI 的 file_upload 返回 `{ok, status, body}`，body 上：
 * - `url`   —— CLI 归一化后的直链（`{...parsed, url: extracted}`，最可靠）
 * - `data.url` —— 原始响应体里的直链
 * 两者取到任意一个即可。
 */
function extractUrl(data: unknown): string | null {
  const body = data as any;
  for (const c of [body?.url, body?.data?.url]) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return null;
}

/** 拿到（或起）某个本地文件的上传状态 */
function stateOf(localPath: string): UploadState {
  const existing = states.get(localPath);
  if (existing) return existing;

  // 先落一个空壳再挂真实 promise：异步任务体里要回写 state 的字段，
  // state 必须先完成赋值（否则就是 TDZ）。
  const state: UploadState = { promise: Promise.resolve(null) };
  states.set(localPath, state);
  state.promise = (async (): Promise<string | null> => {
    await acquireSlot();
    try {
      const res = await bridge.klingCliExec(["file_upload", localPath, "--quiet"], {
        timeoutMs: 180000,
        // 后台预热：可被用户点「生成」后的前台请求插队
        priority: "background",
      });
      if (!res.ok) {
        console.warn("[kling] 素材预上传失败:", res.error || res.code);
        state.failed = true;
        return null;
      }
      const url = extractUrl(res.data);
      if (!url) {
        console.warn("[kling] 素材预上传未返回直链");
        state.failed = true;
        return null;
      }
      state.url = url;
      state.at = Date.now();
      return url;
    } catch (e) {
      console.warn("[kling] 素材预上传异常:", e);
      state.failed = true;
      return null;
    } finally {
      releaseSlot();
    }
  })();
  return state;
}

/**
 * 直链是否已过期（无上传时间视为过期 —— 判断不了新鲜度就退回本地路径）。
 */
export function isKlingUrlExpired(uploadedAt?: string | number): boolean {
  const t = typeof uploadedAt === "number" ? uploadedAt : uploadedAt ? Date.parse(uploadedAt) : NaN;
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > KLING_URL_TTL_MS;
}

/**
 * 丢掉某个路径上已过期的缓存直链。
 *
 * 过期 ≠ 失败：过期直链要重新传一次才能拿到新的；
 * 而「失败」是确定性的（重试也没用），由调用方各自决定不重试。
 * 这里把过期状态整个删掉，下次 `stateOf` 会重新起一次上传。
 */
function dropExpiredState(localPath: string): void {
  const st = states.get(localPath);
  if (!st?.url) return;
  if (typeof st.at === "number" && !isKlingUrlExpired(st.at)) return;
  states.delete(localPath);
}

/**
 * 后台启动一次预上传并把直链回填到 ref（不 await，调用方不阻塞）。
 *
 * 用于「抓素材时」启动 —— 用户写 prompt 的那几十秒正好覆盖上传耗时，
 * 点生成时直链已就绪。
 */
export function startKlingPreUpload(ref: ReferenceItem): void {
  // 同一路径已经传过且直链还新鲜 → 直接复用，不要再让 UI 闪一下「上传中…」
  const existing = states.get(ref.localPath);
  if (
    existing?.url &&
    typeof existing.at === "number" &&
    !isKlingUrlExpired(existing.at)
  ) {
    ref.klingFileUrl = existing.url;
    ref.klingUploadedAt = new Date(existing.at).toISOString();
    ref.uploading = false;
    return;
  }
  // 缓存直链过期 → 丢掉，重新传一次拿新的
  dropExpiredState(ref.localPath);
  ref.uploading = true;
  const state = stateOf(ref.localPath);
  state.promise.then((url) => {
    ref.uploading = false;
    if (!url) return;
    ref.klingFileUrl = url;
    ref.klingUploadedAt = new Date().toISOString();
  });
}

/**
 * 提交前补齐直链：已有新鲜直链的直接用；在途的**等它跑完**再回填。
 *
 * 「等在途」而不是「重新传一遍」：用户抓完素材立刻点生成时，
 * 在途任务已经传了一部分，等它比重传快；且失败的任务不重试
 * （state.failed），避免同一次提交里连传两遍。
 *
 * 没有直链也没有在途任务的（换 provider 抓的素材 / 从未预上传过）→
 * 保持为空，提交时回退本地路径由 CLI 自行上传。
 */
export async function ensureKlingUrls(refs: ReferenceItem[]): Promise<void> {
  await Promise.all(
    refs.map(async (ref) => {
      // ref 自带的直链过期了 → 清掉，提交时回退本地路径由 CLI 重传
      if (ref.klingFileUrl && isKlingUrlExpired(ref.klingUploadedAt)) {
        delete ref.klingFileUrl;
        delete ref.klingUploadedAt;
      }
      // 已有新鲜直链 → 什么都不用做
      if (ref.klingFileUrl) return;

      const state = states.get(ref.localPath);
      // 从未预上传过 → 保持本地路径，CLI 自行上传（与改造前一致）
      if (!state) return;
      // 已确定失败 → 不重试，交给 CLI 传本地路径
      if (state.failed) return;

      // 缓存直链过期 → 丢掉（不回填过期直链），提交时回退本地路径重传
      if (state.url) {
        if (typeof state.at !== "number" || isKlingUrlExpired(state.at)) {
          dropExpiredState(ref.localPath);
          return;
        }
        ref.klingFileUrl = state.url;
        ref.klingUploadedAt = new Date(state.at).toISOString();
        return;
      }

      // 在途 → 等它跑完再回填
      ref.uploading = true;
      const url = await state.promise;
      ref.uploading = false;
      if (!url) return;
      ref.klingFileUrl = url;
      ref.klingUploadedAt = new Date().toISOString();
    }),
  );
}
