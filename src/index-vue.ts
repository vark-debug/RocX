import { createApp } from "vue";
import App from "./main.vue";
import "./app.css";
import "./index.scss";
import { initUXP } from "./api/uxp";
// 副作用注册：默认 MiniMax UxPProvider（必须在 uploadCore/downloadCore 被首次调用前 import）
import "./core/ai/providers/minimax";
import "./core/ai/providers/runninghub";
import "./core/ai/providers/ark";

console.clear(); // Clear logs on each reload

createApp(App).mount("#app");
initUXP();
