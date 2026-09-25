/**
 * UXP 端 Webview Host 初始化
 * 注入主题初始化、项目切换监听并主动推送到 Webview
 */
import * as Comlink from "comlink";
import { api } from "./api/api";

import type { WebviewToUxPAPI } from "../webview-ui/src/webview";
import { config } from "../uxp.config";
import { getColorScheme } from "./api/uxp";
import { uxp } from "./globals";
import { projectCore, setupProjectWatchers } from "./core/project";

interface UXPHTMLWebViewElement extends HTMLElement {
  uxpAllowInspector: string;
  src: string;
  postMessage: (msg: any) => void;
}

export const webviewInitHost = (params: {
  multi: boolean | string[];
}): Promise<WebviewToUxPAPI[]> => {
  const multi = params ? params.multi : false;
  const id = uxp.entrypoints._pluginInfo.id;
  return new Promise((resolve, reject) => {
    let cleanupWatchers: (() => void) | null = null;
    let pages = ["main"];
    if (multi === true || Array.isArray(multi)) {
      pages = config.manifest.entrypoints.map(
        (point) => point.id.split(".")!.pop()!,
      );
      console.log("webviewInitHost multi pages", pages);
    }
    console.log("setup webview for", pages);
    let apis: WebviewToUxPAPI[] = [];
    pages.map((page, i) => {
      let webview = document.createElement("webview") as UXPHTMLWebViewElement;
      webview.className = "webview-ui";
      webview.id = `webview-${i}`;
      webview.uxpAllowInspector = "true";
      const origin =
        import.meta.env.VITE_BOLT_MODE === "dev"
          ? `http://localhost:${import.meta.env.VITE_BOLT_WEBVIEW_PORT}/?page=${page}`
          : `plugin:/webview-ui/${page}.html`;
      webview.src = origin;

      const appElement = document.getElementById("app")!;
      let parent: HTMLElement | null = null;
      if (i === 0) {
        parent = appElement;
      } else {
        const panelElements = Array.from(
          document.getElementsByTagName("uxp-panel"),
        );
        const found = panelElements.find((item) => {
          return item.getAttribute("panelid") === `${id}.${page}`;
        });
        if (found) parent = found as HTMLElement;
      }
      if (parent === null) {
        return console.error("cannot find parent");
      }
      webview = parent!.appendChild(webview) as UXPHTMLWebViewElement;

      webview.addEventListener("message", (e: any) => {
        console.log("webview message", page, e?.message);
      });

      const setupListeners = () => {
        const backendAPI = { api };
        const backendEndpoint = {
          postMessage: (msg: any, transferrables: any) => {
            void transferrables;
            return webview!.postMessage(msg);
          },
          addEventListener: (type: string, handler: any) => {
            webview!.addEventListener("message", handler);
          },
          removeEventListener: (type: string, handler: any) => {
            webview!.removeEventListener("message", handler);
          },
        };

        const endpoint = Comlink.windowEndpoint(backendEndpoint);
        //@ts-ignore
        const comlinkAPI = Comlink.wrap(endpoint) as WebviewToUxPAPI;
        apis.push(comlinkAPI);

        Comlink.expose(
          backendAPI,
          endpoint,
          [origin],
        );

        if (apis.length === pages.length) {
          // 主题变更
          for (const a of apis) {
            getColorScheme().then((scheme) => a.updateColorScheme(scheme));
            //@ts-ignore
            document.theme.onUpdated.addListener(() =>
              getColorScheme().then((scheme) => a.updateColorScheme(scheme)),
            );
          }
          // 项目切换
          projectCore.onProjectChanged(async (p) => {
            for (const a of apis) {
              // 直接推送到 webview 端注册的回调
              //@ts-ignore
              await a.onProjectChanged(p);
            }
          });
          // 启动期首次推送
          projectCore.emitInitial().catch((e) => console.warn(e));
          // 新增：显式启动 watcher 并保留 cleanup
          cleanupWatchers = setupProjectWatchers();
          resolve(apis);
        }
      };

      setupListeners();
    });
  });
};