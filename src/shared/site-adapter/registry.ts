import type { SiteModule } from "./types";
import { commonModule } from "./modules/common";
import { baiduModule } from "./modules/baidu";
import { ecommerceModule } from "./modules/ecommerce";

// 注册的站点适配模块列表（按照匹配优先级排序）
const registeredModules: SiteModule[] = [
  baiduModule,
  ecommerceModule,
  // 新模块直接在此注册添加即可...
];

/**
 * 动态注册新的站点模块（供后续扩展）
 */
export function registerSiteModule(module: SiteModule) {
  registeredModules.unshift(module);
}

/**
 * 根据传入的 URL 自动匹配最适合的站点模块
 */
export function getMatchedSiteModule(urlStr?: string): SiteModule {
  if (!urlStr) {
    return commonModule;
  }

  try {
    const url = new URL(urlStr);
    for (const mod of registeredModules) {
      if (mod.match(url)) {
        return mod;
      }
    }
  } catch (_) {
    // 非标准 URL 或空链接
  }

  return commonModule;
}
