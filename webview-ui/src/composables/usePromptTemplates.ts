/**
 * 提示词模板（输入 "/" 唤起）
 *
 * - 内置模板：常量，随版本发布
 * - 自定义模板：走 bridge 持久化（全局，上限 10 条）
 * - 两种锚定符仅在模板内有效，插入时解析、不进入最终提示词：
 *   「甲或乙」→ 按生成模式二选一；{xxx} → 光标锚点，xxx 作为预填文本全选
 *
 * composable 采用模块级单例状态：PromptInput / ImagePromptInput / SettingsPanel
 * 共享同一份自定义模板列表，避免重复加载与跨组件不同步。
 */
import { ref, computed } from "vue";
import type { PromptTemplate } from "@shared/messages";
import { bridge } from "../services/bridge";

/** 自定义模板上限（与宿主侧 PROMPT_TEMPLATES_MAX 一致） */
export const PROMPT_TEMPLATES_MAX = 10;

/** 内置模板（只读） */
export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin-remove-object",
    label: "移除物品",
    template: "请移除「视频或图片」中的{某个物品}",
    scope: "both",
  },
  {
    id: "builtin-replace-style",
    label: "替换风格",
    template: "保持「视频或图片」主体与构图不变，将整体风格替换为{风格描述}",
    scope: "both",
  },
  {
    id: "builtin-lighting",
    label: "环境光",
    template: "{黄昏}黄金时刻自然光，柔和阴影，电影感色调",
    scope: "both",
  },
  {
    id: "builtin-push-in",
    label: "镜头推近",
    template: "相机缓慢推近主体，浅景深，画面稳定，突出{主体}",
    scope: "video",
  },
  {
    id: "builtin-closeup",
    label: "特写镜头",
    template: "「视频或图片」主体特写，背景虚化，突出{主体细节}",
    scope: "both",
  },
];

// ---- 模块级单例状态 ----
const customTemplates = ref<PromptTemplate[]>([]);
let loaded = false;

export function usePromptTemplates() {
  /** 首次调用时拉取自定义模板（幂等；失败静默，仅内置可用） */
  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const list = await bridge.getPromptTemplates();
      if (Array.isArray(list)) customTemplates.value = list;
    } catch (e) {
      console.warn("[templates] 加载自定义模板失败", e);
    }
  }

  /** 全量模板（内置 + 自定义；内置在前） */
  const allTemplates = computed<PromptTemplate[]>(() => [
    ...BUILTIN_TEMPLATES,
    ...customTemplates.value,
  ]);

  /**
   * 按模式 + 关键词过滤。
   * mode 为 null 时不做 scope 过滤（设置面板管理列表用）
   */
  function filterTemplates(
    mode: "video" | "image" | null,
    query: string,
  ): PromptTemplate[] {
    const q = query.trim().toLowerCase();
    return allTemplates.value.filter((t) => {
      if (mode && t.scope !== "both" && t.scope !== mode) return false;
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        t.template.toLowerCase().includes(q)
      );
    });
  }

  /**
   * 解析模板锚定符，返回插入文本与光标区间（相对插入文本的偏移）。
   * - 「甲或乙」：视频取甲、图片取乙（无「或」时保留原文）
   * - {xxx}：去掉花括号，xxx 保留为预填文本 → cursorStart..cursorEnd 全选
   * - 无锚点：光标落在插入文本末尾
   */
  function resolveTemplate(
    tpl: string,
    mode: "video" | "image",
  ): { text: string; cursorStart: number; cursorEnd: number } {
    let out = "";
    let cursorStart = -1;
    let cursorEnd = -1;
    let i = 0;
    while (i < tpl.length) {
      const ch = tpl[i];
      if (ch === "「") {
        const close = tpl.indexOf("」", i + 1);
        if (close === -1) {
          out += ch;
          i++;
          continue;
        }
        const inner = tpl.slice(i + 1, close);
        const parts = inner.split("或");
        out += mode === "video" ? parts[0] : parts[1] ?? parts[0];
        i = close + 1;
      } else if (ch === "{") {
        const close = tpl.indexOf("}", i + 1);
        if (close === -1) {
          out += ch;
          i++;
          continue;
        }
        const inner = tpl.slice(i + 1, close);
        cursorStart = out.length;
        out += inner;
        cursorEnd = out.length;
        i = close + 1;
      } else {
        out += ch;
        i++;
      }
    }
    if (cursorStart === -1) cursorStart = cursorEnd = out.length;
    return { text: out, cursorStart, cursorEnd };
  }

  /** 保存自定义模板（宿主侧兜底截断到上限） */
  async function saveCustomTemplates(list: PromptTemplate[]) {
    customTemplates.value = list.slice(0, PROMPT_TEMPLATES_MAX);
    try {
      await bridge.setPromptTemplates(customTemplates.value);
    } catch (e) {
      console.warn("[templates] 保存自定义模板失败", e);
    }
  }

  /** 设置面板：新增一条（返回 false 表示超限） */
  function addCustomTemplate(t: Omit<PromptTemplate, "id">): boolean {
    if (customTemplates.value.length >= PROMPT_TEMPLATES_MAX) return false;
    customTemplates.value = [
      ...customTemplates.value,
      { ...t, id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
    ];
    void saveCustomTemplates(customTemplates.value);
    return true;
  }

  /** 设置面板：删除一条 */
  function removeCustomTemplate(id: string) {
    customTemplates.value = customTemplates.value.filter((t) => t.id !== id);
    void saveCustomTemplates(customTemplates.value);
  }

  /**
   * 模板闸门：提示词与某模板（按模式解析后，忽略首尾空白）完全一致时返回命中信息，
   * 用于提交前拦截"模板原样未改就发送"的情况。
   * anchor 取模板第一个 {xxx} 的内容（提示用户修改哪里）；无锚点时为空串。
   */
  function matchTemplateGate(
    prompt: string,
    mode: "video" | "image",
  ): { label: string; anchor: string } | null {
    const p = prompt.trim();
    if (!p) return null;
    for (const t of allTemplates.value) {
      if (t.scope !== "both" && t.scope !== mode) continue;
      if (resolveTemplate(t.template, mode).text.trim() === p) {
        const m = t.template.match(/\{([^}]*)\}/);
        return { label: t.label, anchor: m ? m[1] : "" };
      }
    }
    return null;
  }

  return {
    customTemplates,
    allTemplates,
    ensureLoaded,
    filterTemplates,
    resolveTemplate,
    matchTemplateGate,
    addCustomTemplate,
    removeCustomTemplate,
  };
}

/** 提交闸门的独立导出（内部状态为模块级单例，直接调用安全） */
export function matchTemplateGate(
  prompt: string,
  mode: "video" | "image",
): { label: string; anchor: string } | null {
  return usePromptTemplates().matchTemplateGate(prompt, mode);
}

/**
 * 输入框 "/" 触发器（PromptInput / ImagePromptInput 复用）。
 *
 * 触发条件：输入 "/" 且其前面是开头 / 空白字符（为后续 @素材 触发保留词法空间）。
 * 弹层打开期间继续输入作为过滤词（输入空白字符关闭）；
 * Enter/Tab 插入高亮项，↑↓ 导航，Esc 关闭；未选择时 "/" 原样保留。
 */
export function useTemplateTrigger(opts: {
  textareaRef: { value: HTMLTextAreaElement | null };
  mode: "video" | "image";
  /** 把替换后的完整提示词交回组件（组件 emit update:prompt 后再设光标） */
  onReplace: (next: string, selStart: number, selEnd: number) => void;
}) {
  const { filterTemplates, resolveTemplate, ensureLoaded } = usePromptTemplates();

  const open = ref(false);
  const triggerStart = ref(0);
  const query = ref("");
  const activeIndex = ref(0);
  const filtered = computed(() => filterTemplates(opts.mode, query.value));

  function close() {
    open.value = false;
  }

  function insertTemplate(t: PromptTemplate) {
    const el = opts.textareaRef.value;
    close();
    if (!el) return;
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    const resolved = resolveTemplate(t.template, opts.mode);
    const next =
      v.slice(0, triggerStart.value) + resolved.text + v.slice(caret);
    opts.onReplace(
      next,
      triggerStart.value + resolved.cursorStart,
      triggerStart.value + resolved.cursorEnd,
    );
  }

  function onInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    if (open.value) {
      const q = v.slice(triggerStart.value + 1, caret);
      // 空白字符视为正常输入继续写提示词，过滤词过长也自动收起
      if (/\s/.test(q) || q.length > 30) {
        close();
        return;
      }
      query.value = q;
      activeIndex.value = 0;
      if (!filtered.value.length) close();
    } else if (
      caret >= 1 &&
      v[caret - 1] === "/" &&
      (caret === 1 || /\s/.test(v[caret - 2]))
    ) {
      open.value = true;
      triggerStart.value = caret - 1;
      query.value = "";
      activeIndex.value = 0;
      void ensureLoaded();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open.value) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex.value = Math.min(
        activeIndex.value + 1,
        Math.max(filtered.value.length - 1, 0),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const t = filtered.value[activeIndex.value];
      if (t) insertTemplate(t);
      else close();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return { open, filtered, activeIndex, onInput, onKeydown, insertTemplate, close };
}
