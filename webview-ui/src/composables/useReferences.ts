/**
 * 参考素材 composable：从 main-webview.vue 抽出
 * - 增删参考（addReference / removeReference / useAsReference）
 * - 抓帧 / 抓视频作为参考（captureFrameAsReference / captureVideoAsReference）
 *   * 智能填写生成时长 / 画面比例（按 provider + model.capability 与合法 ratio 列表匹配）
 *   * 抓视频后自动写回 duration / ratio 到全局表单
 * - gcd / ratioStringFromSize / pickClosestRatio 工具函数
 * - 内部 uploadInBackground：把"先 push 进 UI + 后台异步上传"的逻辑抽出来，
 *   captureFrame / captureVideo 两条路径共享
 *
 * 行为与原 main-webview.vue 内的函数完全一致。
 */
import { type Ref, ref } from "vue";
import { bridge } from "../services/bridge";
import {
  type ReferenceItem,
  type FileKind,
  type GenerationRecord,
  type MiniMaxParamConstraints,
} from "@shared/messages";
import type { ModelDescriptor } from "../providers/core/types";

export function useReferences(opts: {
  references: Ref<ReferenceItem[]>;
  constraints: Ref<MiniMaxParamConstraints>;
  /** 抓视频后自动写回 duration / ratio */
  duration: Ref<number>;
  ratio: Ref<string>;
  /** 顶层 model 的当前值（用于按 provider 中性查找合法 ratio 列表） */
  getModelId: () => string;
  currentProviderId: Ref<string>;
  /** 查找 model descriptor（用于按 provider 中性查找合法 ratio 列表） */
  findModelDescriptor: (modelId: string, providerId?: string) => ModelDescriptor | null;
  /** toast */
  showToast: (msg: string | unknown) => void;
}) {
  // ---------- 增删 ----------
  async function addReference(kind: FileKind) {
    const r = await bridge.pickAndUploadReference(kind);
    if (r.ok && r.reference) {
      // 校验总数上限
      const v = opts.references.value.filter((x) => x.type === "reference_video").length;
      const i = opts.references.value.filter((x) => x.type === "reference_image").length;
      if (kind === "video" && v >= 3) {
        opts.showToast("视频参考最多 3 个");
        return;
      }
      if (kind === "image" && i >= 9) {
        opts.showToast("图片参考最多 9 个");
        return;
      }
      opts.references.value.push(r.reference);
    } else if (r.error && !r.error.includes("取消")) {
      opts.showToast(`上传失败: ${r.error}`);
    }
  }

  function removeReference(idx: number) {
    opts.references.value.splice(idx, 1);
  }

  // ---------- 工具：把已生成的视频上传为参考 ----------
  async function useAsReference(rec: GenerationRecord) {
    if (!rec.workFile) return;
    const kind = await bridge.detectFileKind(rec.workFile);
    if (!kind) {
      opts.showToast("无法识别文件类型");
      return;
    }
    const r = await bridge.uploadExistingFileAsReference({
      localPath: rec.workFile,
      fileName: rec.workFile.split("/").pop() || "ref.bin",
      kind,
    });
    if (r.ok && r.reference) {
      opts.references.value.push(r.reference);
    } else {
      opts.showToast(`上传失败: ${r.error}`);
    }
  }

  // ---------- 工具：gcd / ratio 字符串 / 最接近 ratio 匹配 ----------
  function gcd(a: number, b: number): number {
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }
  function ratioStringFromSize(w: number, h: number): string | null {
    if (!w || !h) return null;
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
  }

  /**
   * 把参考视频的宽高比与当前模型合法 ratio 列表匹配，返回最接近的一个。
   * - 完全相等时直接返回
   * - 否则按"实际比值 vs 合法比值"的差值排序，取最小
   * - 与"adaptive"不比较（adaptive 不是具体比值）
   * - candidates 不是数组时返回 null（防御性）
   */
  function pickClosestRatio(
    actual: string,
    candidates: readonly string[] | undefined | null,
  ): string | null {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const valid = candidates.filter((r) => r !== "adaptive");
    if (valid.length === 0) return null;
    const exact = valid.find((r) => r === actual);
    if (exact) return exact;
    const m = actual.match(/^(\d+):(\d+)$/);
    if (!m) return null;
    const aw = Number(m[1]);
    const ah = Number(m[2]);
    const ar = aw / ah;
    let best: { ratio: string; diff: number } | null = null;
    for (const r of valid) {
      const cm = r.match(/^(\d+):(\d+)$/);
      if (!cm) continue;
      const cr = Number(cm[1]) / Number(cm[2]);
      const diff = Math.abs(ar - cr);
      if (!best || diff < best.diff) best = { ratio: r, diff };
    }
    return best?.ratio ?? null;
  }

  // ---------- 内部：后台上传参考素材（共享给 captureFrame / captureVideo） ----------
  /**
   * 把 references 数组中最新 push 的那一条扔到后台做 uploadReferenceFile。
   * 关键：拿数组里的 reactive proxy 引用（不是 bridge 返回的 plain object），
   * 这样引用比较 (===) 永远找得到，且属性赋值触发响应式更新。
   */
  function uploadInBackground(): void {
    const refToUpdate = opts.references.value[opts.references.value.length - 1];
    refToUpdate.uploading = true;
    bridge
      .uploadReferenceFile({
        filePath: refToUpdate.localPath,
        fileName: refToUpdate.fileName,
      })
      .then((up) => {
        const idx = opts.references.value.findIndex((x) => x === refToUpdate);
        if (idx < 0) return;
        if (!up.ok || !up.fileId) {
          console.warn("[webview] reference upload failed:", up.error);
          refToUpdate.uploading = false;
          opts.showToast(`参考素材上传失败: ${up.error || "未知错误"}`);
          return;
        }
        refToUpdate.fileId = up.fileId;
        refToUpdate.uploadedAt = up.uploadedAt;
        refToUpdate.uploading = false;
      })
      .catch((e) => {
        const idx = opts.references.value.findIndex((x) => x === refToUpdate);
        if (idx >= 0) {
          refToUpdate.uploading = false;
        }
        console.error("[webview] upload threw:", e);
        opts.showToast(`参考素材上传异常: ${String(e?.message || e)}`);
      });
  }

  // ---------- 抓帧 ----------
  async function captureFrameAsReference() {
    // 校验图片数量上限
    const i = opts.references.value.filter((x) => x.type === "reference_image").length;
    if (i >= 9) {
      opts.showToast("图片参考最多 9 个");
      return;
    }
    // 阶段 1：UXP 端只导出（不等上传），立即拿到本地 reference，UI 立即显示
    const r = await bridge.captureFrameOnlyAsReference();
    if (!r.ok || !r.reference) {
      opts.showToast(`抓帧失败: ${r.error}`);
      return;
    }
    opts.references.value.push(r.reference);
    uploadInBackground();
  }

  // ---------- 抓帧→PS ----------
  /**
   * 抓帧按钮的 2 秒防抖锁。
   * - 防止用户在 launcher 脚本中转 args JSON 完成前再次点击导致并发 PS 实例。
   * - 暴露 psLocked 给 UI 绑定按钮 :disabled。
   */
  const psLocked = ref(false);

  /**
   * 抓帧 + 用系统关联打开 Photoshop，UI 显示「✏ PS 中 · 修改完成」按钮。
   * 与 captureFrameAsReference 的关键区别：push 到 references 时打 pendingUpload=true，
   * **不**调 uploadInBackground；只有用户在面板点「修改完成」后才上传到 MiniMax。
   * references 数组本身不持久化，刷新/重载/webview reload 会自动丢 pendingUpload 状态，
   * 杜绝「刷新错传之前缓存的图片」。
   */
  async function captureFrameAndOpenInPs() {
    // 防抖:2 秒内已有点击,直接忽略。避免并发写 args JSON / 重复启动 PS。
    if (psLocked.value) return;
    psLocked.value = true;
    setTimeout(() => {
      psLocked.value = false;
    }, 2000);

    // 校验图片数量上限
    const i = opts.references.value.filter((x) => x.type === "reference_image").length;
    if (i >= 9) {
      opts.showToast("图片参考最多 9 个");
      return;
    }
    // 阶段 1：UXP 端只导出（不等上传），立即拿到本地 reference，UI 立即显示
    const r = await bridge.captureFrameOnlyAsReference();
    if (!r.ok || !r.reference) {
      opts.showToast(`抓帧失败: ${r.error}`);
      return;
    }
    // 关键：标记 pendingUpload=**true**、不调 uploadInBackground
    r.reference.pendingUpload = true;
    opts.references.value.push(r.reference);
    // 阶段 3：调系统关联启动 PS（fire-and-forget；失败仅 console.warn，不污染 toast）
    bridge.openInPhotoshop(r.reference.localPath).then((rs) => {
      if (!rs.ok) {
        console.warn(
          "[webview][ps-launch] ❌ 拉起 PS 失败:",
          rs.error,
        );
      } else {
        const via =
          rs.source === "native"
            ? "C++ Hybrid addon"
            : rs.source === "launcher"
              ? "launcher 脚本"
              : "系统关联兜底";
        console.log(`[webview][ps-launch] ✅ 拉起 PS 走的是: ${via} (source=${rs.source})`);
      }
    });
  }

  // ---------- 用户在面板点「修改完成」：上传 pendingUpload ref ----------
  /**
   * 把 pendingUpload=true 的 ref 推到上传流程；与 uploadInBackground 区别在于：
   * - 拿 ref 用绝对下标 idx（不是「最新 push 的那一条」），因为 ref 可能不在数组末尾
   * - 成功后清掉 pendingUpload（uploading 由自身流程管）
   * - 失败时保留 pendingUpload=true 让用户重试
   */
  async function confirmPendingUpload(idx: number) {
    const ref = opts.references.value[idx];
    if (!ref || !ref.pendingUpload) return;
    if (ref.uploading) return; // 防重复点
    ref.uploading = true;
    try {
      const up = await bridge.uploadReferenceFile({
        filePath: ref.localPath,
        fileName: ref.fileName,
      });
      if (up.ok && up.fileId) {
        ref.fileId = up.fileId;
        ref.uploadedAt = up.uploadedAt;
        ref.uploading = false;
        ref.pendingUpload = false;
      } else {
        ref.uploading = false;
        // pendingUpload 保持 true，让用户可以再点「修改完成」重试
        opts.showToast(`参考素材上传失败: ${up.error || "未知错误"}`);
      }
    } catch (e: any) {
      ref.uploading = false;
      console.error("[webview] confirmPendingUpload threw:", e);
      opts.showToast(`参考素材上传异常: ${String(e?.message || e)}`);
    }
  }

  // ---------- 抓视频 ----------
  async function captureVideoAsReference() {
    // 校验视频数量上限
    const v = opts.references.value.filter((x) => x.type === "reference_video").length;
    if (v >= 3) {
      opts.showToast("视频参考最多 3 个");
      return;
    }
    // 阶段 1：UXP 端只导出，立即显示
    const r = await bridge.captureWorkAreaOnlyAsReference();
    if (!r.ok || !r.reference) {
      opts.showToast(`抓视频失败: ${r.error}`);
      return;
    }
    // 仅当当前没有任何视频参考（即本次是第一个视频参考）时，才智能填写生成时长
    const isFirstVideoRef = opts.references.value.every(
      (x) => x.type !== "reference_video",
    );
    if (r.durationSec !== undefined) {
      const t = Math.round(r.durationSec * 10) / 10;
      console.log(
        `[webview] captured ${t}s of work area${isFirstVideoRef ? " (auto-fill duration)" : ""}`,
      );
    }
    opts.references.value.push(r.reference);
    // 智能填写生成时长：用出入点时长向上取整到当前模型合法档位（6.8s→7s）；
    // 超过最大档位时取最大档并提示，但不阻止流程
    if (isFirstVideoRef && r.durationSec && r.durationSec > 0) {
      const sec = r.durationSec;
      const ds = opts.constraints.value.durations;
      const maxD = ds[ds.length - 1];
      if (sec > maxD) {
        opts.duration.value = maxD;
        opts.showToast(
          `素材时长 ${sec.toFixed(1)}s 超过当前模型最大档 ${maxD}s，生成时长已设为 ${maxD}s，流程继续`,
        );
        console.log(
          `[webview] work area ${sec.toFixed(2)}s exceeds max duration, clamped to ${maxD}s`,
        );
      } else {
        opts.duration.value = ds.find((d) => d >= sec) ?? maxD;
      }
      console.log(
        `[webview] auto-filled duration=${opts.duration.value}s from work area ${sec.toFixed(2)}s`,
      );
    }
    // 智能填写画面比例：仅当当前没有任何视频参考且 width/height 已知
    // 与抓视频 duration 自动填写一致：通用能力，不绑定具体 provider
    if (
      isFirstVideoRef &&
      r.width &&
      r.height &&
      r.width > 0 &&
      r.height > 0
    ) {
      const actual = ratioStringFromSize(r.width, r.height);
      if (actual) {
        // 优先从当前 model descriptor 拿合法 ratio（provider 中性、Task 5 后的权威来源）；
        // fallback 到旧 MINIMAX_PARAM_CONSTRAINTS（向后兼容）
        const currentModel = opts.findModelDescriptor(
          opts.getModelId(),
          opts.currentProviderId.value,
        );
        const validRatios =
          currentModel?.paramConstraints?.ratios ?? opts.constraints.value?.ratios;
        if (Array.isArray(validRatios)) {
          const closest = pickClosestRatio(actual, validRatios);
          if (closest && opts.ratio.value !== closest) {
            opts.ratio.value = closest;
            console.log(
              `[webview] auto-filled ratio=${closest} from work area ${r.width}x${r.height} (${actual})`,
            );
          }
        } else {
          console.warn(
            `[webview] skip ratio auto-fill: no valid ratios list for model=${opts.getModelId()}`,
          );
        }
      }
    }
    uploadInBackground();
  }

  return {
    addReference,
    removeReference,
    useAsReference,
    captureFrameAsReference,
    captureFrameAndOpenInPs,
    captureVideoAsReference,
    confirmPendingUpload,
    psLocked,
  };
}
