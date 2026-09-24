<script setup lang="ts">
import { onMounted } from "vue";
import { webviewInitHost } from "./webview-setup-host";
import type { WebviewAPI } from "../webview-ui/src/webview";

const webviewUI = import.meta.env.VITE_BOLT_WEBVIEW_UI === "true";

let webviewAPIs: WebviewAPI[];
let mainWebviewAPI: WebviewAPI;
onMounted(async () => {
  if (webviewUI) {
    webviewAPIs = await webviewInitHost({ multi: true });
    [mainWebviewAPI] = webviewAPIs;
    window.mainWebviewAPI = mainWebviewAPI;
  }
});
</script>

<template>
  <div class="uxp-host-root"></div>
</template>

<style lang="scss">
@use "./variables.scss" as *;

.uxp-host-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>