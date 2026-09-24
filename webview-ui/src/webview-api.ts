/**
 * Webview 端暴露给 UXP 层的 API
 */
export interface ProjectInfo {
  path: string;
  guid: string;
  name: string;
}

let _onProjectChangedCb: ((p: ProjectInfo | null) => void) | null = null;
let _onThemeChangedCb: ((v: { theme: string; colors: Record<string, string> }) => void) | null = null;

export const pingWebview = () => {
  console.log("pingWebview called");
  return "hello from webview";
};

export const onProjectChanged = (
  cb: (p: ProjectInfo | null) => void,
): void => {
  _onProjectChangedCb = cb;
};

export const _emitProjectChanged = (p: ProjectInfo | null) => {
  if (_onProjectChangedCb) {
    try {
      _onProjectChangedCb(p);
    } catch (e) {
      console.warn("onProjectChanged cb error", e);
    }
  }
};

export const updateColorScheme = (val: {
  theme: string;
  colors: Record<string, string>;
}) => {
  const { theme, colors } = val;
  const root = document.querySelector(":root") as HTMLElement;
  if (root) {
    for (const key in colors) {
      root.style.setProperty(key, colors[key]);
    }
  }
  document.documentElement.dataset.theme = theme;
  if (_onThemeChangedCb) {
    try {
      _onThemeChangedCb(val);
    } catch (e) {
      console.warn("onThemeChanged cb error", e);
    }
  }
  return "color scheme updated";
};

export const onThemeChanged = (
  cb: (val: { theme: string; colors: Record<string, string> }) => void,
) => {
  _onThemeChangedCb = cb;
};