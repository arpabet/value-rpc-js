import { createApp } from "vue";
import { createVrpc } from "@arpabet/vrpc-vue";
import App from "./App.vue";

const url =
  import.meta.env.VITE_VRPC_URL ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;

createApp(App)
  .use(createVrpc({ url, timeoutMs: 5000 }))
  .mount("#app");
