/**
 * 图片生成提交 composable（阶段 2A 文生图 + 2B 图生图 + 可灵图片）
 *
 * 责任:
 * - submitImageGenerate(): 取 per-provider key / 归属工程 / 写 image record /
 *   经 image registry 取 provider 调 createImage / 启动轮询（复用 usePolling + inflight）
 * - 智能路由在 provider 内部（references 非空 → image-to-image）；
 *   这里只做素材准入：仅图片类参考参与，视频参考跳过并提示
 *
 * 与 useSubmit 的差异:
 * - key 按图片 provider 读取，不用 shared.apiKey（那是视频 provider 的）
 * - count 固定 1（RunningHub 单次 1 张）；张数 UI 首版固定
 * - 图生图不走 fileId 引用：提交时读本地文件转 Base64 data URI 直传
 *   （RH 对外链 / 纯文件名引用均报 1007 无法识别，实测弃用）
 *
 * ⚠ 可灵分支（provider = kling）与其余三家有四处根本差异：
 *   1. **没有 API Key**（走 CLI 的浏览器 OAuth 登录态）→ 跳过 key 校验
 *   2. **参考图不走 Base64**（CLI 的 resolveImageUrl 只认 http(s) 与本地路径，
 *      data URI 会被当成文件路径去上传而失败）→ 交给 provider 用 CDN 直链 / 本地路径
 *   3. **不认宽高像素**：用服务端声明的 img_resolution（"1k"/"2k"/"4k"）
 *   4. **提交即扣费**：creditsConsumed 随提交响应返回 → 落记录 + 立即上报飞书
 */
import { inject } from "vue";
import { bridge } from "../services/bridge";
import {
  getImageProviderSync,
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
import { matchTemplateGate } from "./usePromptTemplates";
import { safeProviderCall } from "./useProviderSafe";
import { SharedRefsKey } from "../providers/state";
import { checkKlingReady, loadKlingModels } from "../providers/kling";
import { KLING_PROVIDER_ID } from "@shared/messages";
import type { GenerationRecord } from "@shared/messages";
import type { ImageGenCreateRequest } from "../providers/core/types";

type RefAny<T> = { value: T };

export function useImageSubmit(opts: {
  /** 当前图片 model id（main-webview 顶层持有） */
  imageModel: RefAny<string>;
  /** 当前图片平台 id（显式状态，不再按 modelId 反查） */
  imageProviderId: RefAny<string>;
  /** 图片提示词（独立于视频 prompt） */
  imagePrompt: RefAny<string>;
  /** 宽高比 */
  imageRatio: RefAny<string>;
  /** 尺寸档位（其余平台 "智能"/"1K"/"2K"；可灵 "1k"/"2k"/"4k"） */
  imageSize: RefAny<string>;
  /** toast */
  showToast: (msg: string | unknown) => void;
  /** 复用 useSubmit 的归属解析（抓素材锁定 > 实时活动工程） */
  resolveSubmitOwner: () => Promise<{ path: string; guid: string; name: string } | null>;
  /** 共享轮询（与视频生成同一个 inflight / polling_ 单例） */
  inflightApi: {
    resumePolling: (rec: GenerationRecord) => void;
  };
  /**
   * 可灵图片「提交即上报」回调（提交成功拿到实扣灵感值的瞬间调用）。
   * 可灵在提交时即扣费且失败不退 —— 不立即上报就会「扣了钱但查无记录」。
   */
  reportKlingSubmitted?: (rec: GenerationRecord) => void;
}) {
  const sharedRaw = inject(SharedRefsKey);
  if (!sharedRaw) {
    throw new Error("useImageSubmit requires SharedRefs provider in main-webview");
  }
  const shared = sharedRaw;

  // ---------- 提交图片生成 ----------
  async function submitImageGenerate() {
    // 模板闸门：提示词与模板原样一致（未改 {xxx} 预填）时拦截
    const gate = matchTemplateGate(opts.imagePrompt.value, "image");
    if (gate) {
      opts.showToast(
        gate.anchor
          ? `提示词与模板「${gate.label}」一致，请先修改模板中的「${gate.anchor}」再生成`
          : `提示词与模板「${gate.label}」完全一致，请先修改后再生成`,
      );
      return;
    }
    const activeModelId = opts.imageModel.value;
    // 图片平台是**显式状态**（平台栏里选的），不再按 modelId 反查 ——
    // 反查在两个平台存在同名模型时会有歧义。
    const imageProviderId =
      opts.imageProviderId.value || DEFAULT_IMAGE_PROVIDER_ID;
    const isKling = imageProviderId === KLING_PROVIDER_ID;
    // 可灵走 CLI 的浏览器 OAuth 登录态，没有 API Key 槽位 → 不查 key、不校验
    const apiKey = isKling ? "" : (await bridge.getApiKey(imageProviderId)) || "";
    if (!isKling && !apiKey) {
      opts.showToast(
        `请在设置里配置 ${imageProviderId === "ark" ? "火山方舟" : "RunningHub"} API Key`,
      );
      return;
    }
    // 可灵提交前自检：CLI 未装 / 未登录 / 余额不足 → 明确提示并阻断
    if (isKling) {
      const env = await checkKlingReady();
      if (!env.ok) {
        opts.showToast(env.message);
        return;
      }
      // 图片模型清单与视频侧共用同一份 who_am_i；这里确保已加载（失败由 provider 抛错）
      await loadKlingModels();
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
    const modelDesc = provider.models.find((m) => m.modelId === activeModelId);
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
    // ⚠ 可灵不走 Base64 —— CLI 的 resolveImageUrl 只认 http(s) 与本地路径，
    //   data URI 会被当成文件路径去上传，必然失败。可灵用 CDN 直链 / 本地路径。
    const dataUris: string[] = [];
    if (imageRefs.length > 0 && !isKling) {
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
    // ⚠ 可灵不认宽高像素 —— 它用服务端声明的 img_resolution 档位（"1k"/"2k"/"4k"）。
    //   实测可灵的像素表与 ratioToSize 完全不同（1k 16:9 = 1360×768，不是 1280×720），
    //   所以这里不给可灵算像素，档位直接透传给 provider。
    let outWidth = 0;
    let outHeight = 0;
    let resolutionTier = opts.imageSize.value;
    if (!isKling) {
      if (opts.imageSize.value === "智能") {
        const seq = await bridge.getActiveSequenceSize();
        if (!seq) {
          opts.showToast(
            "未能获取活动序列分辨率，请确认当前项目已打开且含活动序列",
          );
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
      resolutionTier = billingTierOf(outWidth, outHeight, tierThreshold);
    }

    const newRec: GenerationRecord = {
      id,
      createdAt: now,
      prompt: opts.imagePrompt.value,
      kind: "image",
      params: {
        model: activeModelId,
        ratio: opts.imageRatio.value as GenerationRecord["params"]["ratio"],
        duration: 0,
        resolution: resolutionTier,
        provider: imageProviderId,
      },
      // 可灵的实际像素由服务端决定（提交时不知道），不写 imageParams ——
      // 记录列表会退回展示 ratio 档位，而不是编一个像素数出来
      ...(isKling
        ? {}
        : {
            imageParams: {
              width: outWidth,
              height: outHeight,
              resolution: resolutionTier,
              outputFormat: "png",
            },
          }),
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
      model: activeModelId,
      prompt: newRec.prompt,
      ratio: opts.imageRatio.value,
      width: outWidth,
      height: outHeight,
      outputFormat: "png",
      count: 1,
      references: imageRefs,
      referencesDataUris: dataUris,
      // 可灵：把服务端声明的档位（"1k"/"2k"/"4k"）直接透传
      ...(isKling ? { resolutionTier } : {}),
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
    // 可灵提交即扣费：实扣灵感值随提交响应返回，必须落进记录
    // （随 records 持久化；终态失败时用于本地对账）
    const credits = r.data.creditsConsumed;
    const patch: Partial<GenerationRecord> = {
      taskId: task_id,
      status: "generating",
      ...(typeof credits === "number" ? { creditsConsumed: credits } : {}),
    };
    if (idx >= 0) {
      shared.records.value[idx] = {
        ...shared.records.value[idx],
        ...patch,
      };
    }
    const runRec: GenerationRecord = { ...newRec, ...patch };
    // 可灵：提交即上报（积分在提交时已扣且失败不退，等终态会「扣了钱但查无记录」；
    // 终态路径对可灵不再上报，避免同一笔费用记两次）
    if (isKling) {
      opts.reportKlingSubmitted?.(runRec);
    }
    opts.inflightApi.resumePolling(runRec);
  }

  return {
    submitImageGenerate,
  };
}
