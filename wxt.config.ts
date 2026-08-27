import { defineConfig } from "wxt";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

const actionIcons = {
  16: "assets/logo.png",
  32: "assets/logo.png",
  48: "assets/logo.png",
  128: "assets/logo.png",
};

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-vue"],
  vite: () => ({
    plugins: [
      Components({
        dts: false,
        resolvers: [ElementPlusResolver()],
      }),
    ],
  }),
  manifest: {
    name: "YiShe 多功能工具集",
    description: "一个模块化的多功能 Chrome 插件，支持不同网站的不同功能",
    permissions: [
      "activeTab",
      "storage",
      "scripting",
      "tabs",
      "alarms",
      "contextMenus",
      "downloads",
      "cookies",
    ],
    host_permissions: ["http://*/*", "https://*/*"],
    action: {
      default_title: "YiShe 工具集",
      default_icon: actionIcons,
    },
    icons: actionIcons,
    web_accessible_resources: [
      {
        resources: ["oauth-callback.html"],
        matches: ["http://localhost:1521/*", "https://admin.1s.design/*"],
      },
    ],
  },
});
