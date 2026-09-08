import type { SiteModule } from "../types";

const ECOMMERCE_HOSTS = [
  "taobao.com",
  "tmall.com",
  "jd.com",
  "1688.com",
  "pinduoduo.com",
  "yangkeduo.com",
];

export const ecommerceModule: SiteModule = {
  id: "ecommerce",
  name: "电商素材适配",
  icon: "🛍️",
  description: "淘宝、京东、1688 等电商平台的素材与主图提取",
  match: (url) => ECOMMERCE_HOSTS.some((h) => url.hostname.includes(h)),
  actions: [
    {
      id: "extract-product-images",
      label: "提取商品主图与详情图",
      description: "批量捕获商品的主图轮播、SKU 图及详情大图",
      icon: "📸",
      primary: true,
      badge: "推荐",
      handler: async ({ tabId }) => {
        await chrome.tabs.sendMessage(tabId, {
          type: "yishe:page-image-collector:open",
        });
      },
    },
    {
      id: "copy-clean-url",
      label: "复制纯净商品链接",
      description: "去除冗余追踪参数后复制商品原始链接",
      icon: "🔗",
      handler: async ({ url }) => {
        try {
          const parsed = new URL(url);
          // 常见商品 id 参数：id, itemId, skuId 等
          const id =
            parsed.searchParams.get("id") ||
            parsed.searchParams.get("itemId") ||
            parsed.searchParams.get("skuId");
          const cleanUrl = id
            ? `${parsed.origin}${parsed.pathname}?id=${id}`
            : `${parsed.origin}${parsed.pathname}`;
          await navigator.clipboard.writeText(cleanUrl);
        } catch {
          await navigator.clipboard.writeText(url);
        }
      },
    },
  ],
};
