import type { SiteModule } from "../types";

export const commonModule: SiteModule = {
  id: "common",
  name: "通用页面",
  icon: "🌐",
  match: () => true, // 通用兜底
  actions: [],
};

