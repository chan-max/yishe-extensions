import type { SiteModule } from "../types";

export const baiduModule: SiteModule = {
  id: "baidu",
  name: "百度搜索适配",
  icon: "🔍",
  description: "针对百度搜索结果页的增强工具",
  match: (url) => url.hostname.includes("baidu.com"),
  actions: [
    {
      id: "focus-search",
      label: "聚焦搜索框",
      description: "一键选中并聚焦百度主搜索框",
      icon: "🎯",
      handler: async ({ tabId }) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const kw = document.querySelector("#kw") as HTMLInputElement | null;
            if (kw) {
              kw.focus();
              kw.select();
            }
          },
        });
      },
    },
    {
      id: "highlight-results",
      label: "高亮搜索结果",
      description: "为自然搜索结果区块增加高亮边框",
      icon: "✨",
      handler: async ({ tabId }) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const results = document.querySelectorAll("#content_left .c-container");
            results.forEach((el) => {
              (el as HTMLElement).style.outline = "2px solid #6366f1";
              (el as HTMLElement).style.borderRadius = "8px";
            });
          },
        });
      },
    },
  ],
};
