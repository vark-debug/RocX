/**
 * 图片生成提交 composable（阶段 2A 文生图 + 2B 图生图）
 *
 * 责任:
 * - submitImageGenerate(): 取 per-provider key / 归属工程 / 写 image record /
 *   经 image registry 取 provider 调 createImage / 启动轮询（复用 usePolling + inflight）
 * - 智能路由在 provider 内部（references 非空 → image-to-image）；
 *   这里只做素材准入：仅图片类参考参与，视频参考跳过并提示
 *
 * 与 useSubmit 的差异:
 * - key 按图片 provider（runninghub）读取，不用 shared.apiKey（那是视频 provider 的）
 * - count 固定 1（RunningHub 单次 1 张）；张数 UI 首版固定
 * - 图生图不走 fileId 引用：提交时读本地文件转 Base64 data URI 直传
 *   （RH 对外链 / 纯文件名引用均报 1007 无法识别，实测弃用）
 */
import { inject } from "vue";
import { bridge } from "../services/bridge";
import {
  getImageProviderSync,
  listImageProviders,
  DEFAULT_IMAGE_PROVIDER_ID,
} from "../providers/core/registry";
import {
  ratioToSize,
  billingTierOf,
  clampToApiMax,
  IMAGE_1K_MAX_PIXELS,
} from "../providers/runninghub/wireFormat";
import { ARK_1K_MAX_PIXELS } from "../providers/ark/wireFormat";
import { resetCaptureContext } from "./useCaptureContext";
import { safeProviderCall } from "./useProviderSafe";
import { SharedRefsKey } from "../providers/state";
import type { GenerationRecord } from "@shared/messages";
import type { ImageGenCreateRequest } from "../providers/core/types";

type RefAny<T> = { value: T };

export function useImageSubmit(opts: {
  /** 当前图片 model id（main-webview 顶层持有） */
  imageModel: RefAny<string>;
  /** 图片提示词（独立于视频 prompt） */
  imagePrompt: RefAny<string>;
  /** 宽高比 */
  imageRatio: RefAny<string>;
  /** 尺寸档位 "智能" | "1K" | "2K" */
  imageSize: RefAny<string>;
  /** toast */
  showToast: (msg: string | unknown) => void;
  /** 复用 useSubmit 的归属解析（抓素材锁定 > 实时活动工程） */
  resolveSubmitOwner: () => Promise<{ path: string; guid: string; name: string } | null>;
  /** 共享轮询（与视频生成同一个 inflight / polling_ 单例） */
  inflightApi: {
    resumePolling: (rec: GenerationRecord) => void;
  };
}) {
  const sharedRaw = inject(SharedRefsKey);
  if (!sharedRaw) {
    throw new Error("useImageSubmit requires SharedRefs provider in main-webview");
  }
  const shared = sharedRaw;

  // ---------- 提交图片生成 ----------
  async function submitImageGenerate() {
    // 多图片 provider：按当前选中模型推导所属 provider（选中即路由），未命中回落默认
    const imageProviderId =
      listImageProviders().find((p) =>
        p.models.some((m) => m.modelId === opts.imageModel.value),
      )?.providerId ?? DEFAULT_IMAGE_PROVIDER_ID;
    const apiKey = await bridge.getApiKey(imageProviderId);
    if (!apiKey) {
      opts.showToast(`请在设置里配置 ${imageProviderId === "ark" ? "火山方舟" : "RunningHub"} API Key`);
      return;
    }
    const owner = await opts.resolveSubmitOwner();
    if (!owner || !owner.path) {
      opts.showToast("无活动 PR 项目，无法记录生成历史");
      return;
    }
    const provider = getImageProviderSync(imageProviderId);
    if (!provider) {
      opts.showToast("图片 provider 未注册");
      return;
    }
    const modelDesc = provider.models.find((m) => m.modelId === opts.imageModel.value);
    if (!modelDesc || !modelDesc.capabilities.includes("imageGeneration")) {
      opts.showToast("当前图片模型不支持生成");
      return;
    }
    // 素材准入：仅图片类参考参与图生图；视频参考在图片模式下跳过
    const imageRefs = shared.references.value.filter(
      (r) => r.type === "reference_image",
    );
    const videoRefs = shared.references.value.filter(
      (r) => r.type === "reference_video",
    );
    if (videoRefs.length > 0) {
      opts.showToast(
        `已忽略 ${videoRefs.length} 个视频参考素材（图片生成仅支持图片参考）`,
      );
    }
    if (!opts.imagePrompt.value.trim()) return;

    // 图生图走 Base64 直传：读本地文件转 data URI（外链/文件名引用会被 RH 1007 拒绝）
    const dataUris: string[] = [];
    if (imageRefs.length > 0) {
      let readFailed = 0;
      for (const r of imageRefs) {
        const dr = await bridge.readAsDataUrl(r.localPath);
        if (dr.ok && dr.dataUrl) dataUris.push(dr.dataUrl);
        else readFailed++;
      }
      if (dataUris.length === 0) {
        opts.showToast("参考素材读取失败，无法作为图生图输入");
        return;
      }
      if (readFailed > 0) {
        opts.showToast(`${readFailed} 个参考素材读取失败，已跳过`);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // 输出像素：智能档 = 提交时实时取活动序列分辨率；预设档 = 比例×档位映射
    let outWidth: number;
    let outHeight: number;
    if (opts.imageSize.value === "智能") {
      const seq = await bridge.getActiveSequenceSize();
      if (!seq) {
        opts.showToast("未能获取活动序列分辨率，请确认当前项目已打开且含活动序列");
        return;
      }
      // 超 API 像素上限（4194304，实测 4K 序列报错）时等比缩放到上限内
      const clamped = clampToApiMax(seq.width, seq.height);
      if (clamped.scaled) {
        opts.showToast(
          `序列分辨率 ${seq.width}×${seq.height} 超出模型上限，已等比缩放为 ${clamped.width}×${clamped.height}`,
        );
      }
      outWidth = clamped.width;
      outHeight = clamped.height;
    } else {
      const size = ratioToSize(opts.imageRatio.value, opts.imageSize.value);
      outWidth = size.width;
      outHeight = size.height;
    }
    // 计价档位由输出像素总数决定；1K 分界像素各 provider 不同
    // （RunningHub 236 万 / Ark 261 万），按当前 provider 选用阈值
    const tierThreshold =
      imageProviderId === "ark" ? ARK_1K_MAX_PIXELS : IMAGE_1K_MAX_PIXELS;
    const billingTier = billingTierOf(outWidth, outHeight, tierThreshold);

    const newRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: opts.imagePrompt.value,
      kind: "image",
      params: {
        model: opts.imageModel.value,
        ratio: opts.imageRatio.value as GenerationRecord["params"]["ratio"],
        duration: 0,
        resolution: billingTier,
        provider: imageProviderId,
      },
      imageParams: {
        width: outWidth,
        height: outHeight,
        resolution: billingTier,
        outputFormat: "png",
      },
      references: imageRefs,
      // 同步生成型 provider（如 Ark，无轮询）：直接进入 generating 展示伪计时，跳过排队态
      status: provider.syncGeneration ? "generating" : "pending",
      submittedAt: now,
      projectGuid: owner.guid,
      projectPath: owner.path,
    };
    shared.records.value.unshift(newRec);
    // 一次提交 = 一次完整的输入清空（与视频提交同语义）
    opts.imagePrompt.value = "";
    shared.references.value = [];
    resetCaptureContext();

    const req: ImageGenCreateRequest = {
      model: opts.imageModel.value,
      prompt: newRec.prompt,
      ratio: opts.imageRatio.value,
      width: outWidth,
      height: outHeight,
      outputFormat: "png",
      count: 1,
      references: imageRefs,
      referencesDataUris: dataUris,
    };
    const r = await safeProviderCall(() => provider.createImage(req, apiKey));
    if (!r.ok) {
      const idx = shared.records.value.findIndex((rec) => rec.id === id);
      if (idx >= 0) {
        shared.records.value[idx] = {
          ...shared.records.value[idx],
          status: "failed",
          error: r.error,
        };
      }
      return;
    }
    const task_id = r.data.taskId;
    const idx = shared.records.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      shared.records.value[idx] = {
        ...shared.records.value[idx],
        taskId: task_id,
        status: "generating",
      };
    }
    opts.inflightApi.resumePolling({
      ...newRec,
      taskId: task_id,
      status: "generating",
    });
  }

  return {
    submitImageGenerate,
  };
}
