/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// TODO - not working in Svelte
import { HTMLWebViewElement as UXPHTMLWebViewElement } from "@adobe/cc-ext-uxp-types/uxp/index";

declare global {
  interface Window {
    webview: UXPHTMLWebViewElement;
    mainWebviewAPI?: any;
  }
}
