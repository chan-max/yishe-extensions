// @ts-nocheck
(function initProductExtractor() {
  "use strict";

  if (window.CoreProductExtractor) {
    return;
  }

  // ========== 平台检测 ==========
  function detectPlatform(url) {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("amazon.")) return "amazon";
    if (hostname.includes("aliexpress.")) return "aliexpress";
    if (hostname.includes("1688.com")) return "1688";
    if (hostname.includes("taobao.com") || hostname.includes("tmall.com"))
      return "taobao";
    if (hostname.includes("ebay.")) return "ebay";
    if (hostname.includes("shopee.")) return "shopee";
    if (hostname.includes("temu.com")) return "temu";
    if (hostname.includes("shein.com")) return "shein";
    if (hostname.includes("etsy.com")) return "etsy";
    if (hostname.includes("walmart.")) return "walmart";
    if (hostname.includes("target.com")) return "target";
    if (hostname.includes("jd.com")) return "jd";
    if (hostname.includes("pinduoduo.com") || hostname.includes("pdd."))
      return "pinduoduo";
    if (hostname.includes("dhgate.com")) return "dhgate";
    if (hostname.includes("made-in-china.com")) return "made-in-china";
    if (hostname.includes("alibaba.com")) return "alibaba";
    return "general";
  }

  // ========== JSON-LD 提取 ==========
  function extractJsonLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    const results = [];

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data) {
          if (Array.isArray(data)) {
            results.push(...data);
          } else if (data["@graph"]) {
            results.push(...data["@graph"]);
          } else {
            results.push(data);
          }
        }
      } catch (e) {
        // skip invalid JSON-LD
      }
    }

    // 找到 Product 类型
    const product = results.find((item) => {
      const type = item["@type"];
      if (Array.isArray(type)) return type.includes("Product");
      return type === "Product";
    });

    return product || null;
  }

  // ========== Open Graph 提取 ==========
  function extractOpenGraph() {
    const meta = {};
    const ogTags = document.querySelectorAll('meta[property^="og:"]');
    for (const tag of ogTags) {
      const property = tag.getAttribute("property").replace("og:", "");
      const content = tag.getAttribute("content");
      if (content) {
        meta[property] = content;
      }
    }
    return Object.keys(meta).length > 0 ? meta : null;
  }

  // ========== 智能标题提取 ==========
  function guessTitle() {
    // 优先级: h1 > og:title > document.title
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) {
      return h1.textContent.trim();
    }

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) {
      return ogTitle.content.trim();
    }

    return document.title.trim();
  }

  // ========== 智能价格提取 ==========
  function guessPrice() {
    // 常见价格选择器
    const priceSelectors = [
      // Amazon
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      ".a-price-whole",
      // 通用
      "[data-price]",
      ".price",
      ".product-price",
      ".sale-price",
      ".current-price",
      ".special-price",
      ".price-current",
      ".priceNow",
      ".now-price",
      ".p-price",
      ".tb-rmb-num",
      ".tm-price",
      ".J_Price",
      ".price-value",
      '[itemprop="price"]',
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const priceMatch = text.match(/[\$\€\£\¥\₹\₽\￥]?\s*[\d,]+\.?\d*/);
        if (priceMatch) {
          return {
            text: text,
            value: priceMatch[0],
          };
        }
      }
    }

    // 正则匹配整个页面
    const bodyText = document.body.innerText;
    const pricePattern = /[\$\¥\€\£]\s*[\d,]+\.?\d{0,2}/g;
    const matches = bodyText.match(pricePattern);
    if (matches && matches.length > 0) {
      return {
        text: matches[0],
        value: matches[0],
      };
    }

    return null;
  }

  // ========== 图片收集 ==========
  function collectImages() {
    const images = new Set();
    const url = window.location.href;

    // 主图区域
    const mainImageSelectors = [
      "#landingImage",
      "#imgBlkFront",
      "#main-image",
      ".product-image img",
      ".product-main-image img",
      ".gallery-image",
      "#product-images img",
      ".product-gallery img",
      ".item-gallery img",
      '[data-hook="cr-product-image"] img',
      ".detail-gallery img",
      ".tb-main-pic img",
      ".J_TBigProp img",
      "[data-main-image]",
    ];

    for (const selector of mainImageSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const src =
          el.src ||
          el.dataset.src ||
          el.dataset.original ||
          el.getAttribute("data-a-dynamic-image");
        if (src) {
          try {
            // 处理 data-a-dynamic-image (Amazon JSON 格式)
            if (el.getAttribute("data-a-dynamic-image")) {
              const imageData = JSON.parse(
                el.getAttribute("data-a-dynamic-image"),
              );
              for (const imgUrl of Object.keys(imageData)) {
                const normalized = normalizeImageUrl(imgUrl);
                if (normalized) images.add(normalized);
              }
            } else {
              const normalized = normalizeImageUrl(src);
              if (normalized) images.add(normalized);
            }
          } catch (e) {
            /* skip */
          }
        }
      }
    }

    // 如果主图选择器没找到，收集页面所有大图
    if (images.size < 3) {
      const allImgs = document.querySelectorAll("img");
      for (const img of allImgs) {
        if (img.width >= 200 && img.height >= 200) {
          const src = img.src || img.dataset.src || img.dataset.original;
          if (src) {
            const normalized = normalizeImageUrl(src);
            if (normalized) images.add(normalized);
          }
        }
      }
    }

    return Array.from(images).slice(0, 20);
  }

  function normalizeImageUrl(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("data:")) return "";

    try {
      const url = new URL(trimmed, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      // 过滤小图标/追踪像素
      if (
        url.pathname.includes("favicon") ||
        url.pathname.includes("pixel") ||
        url.pathname.includes("1x1")
      )
        return "";
      return url.href;
    } catch (e) {
      return "";
    }
  }

  // ========== 规格参数提取 ==========
  function extractSpecifications() {
    const specs = {};

    // 方式1: 结构化表格
    const tableSelectors = [
      "#productDetails_techSpec_section_1",
      "#productDetails_detailBullets_sections1",
      ".a-keyvalue",
      ".product-specs",
      ".specification-table",
      ".spec-table",
      ".attr-list",
      ".product-attribute",
      ".detail-attr-list",
      ".tb-attr-list",
      '[data-hook="product-specification-table"]',
      "table.a-bordered",
    ];

    for (const selector of tableSelectors) {
      const tables = document.querySelectorAll(selector);
      for (const table of tables) {
        const rows = table.querySelectorAll("tr, .a-spacing-small");
        for (const row of rows) {
          const cells = row.querySelectorAll(
            "td, th, .a-span3, .a-span9, .attr-name, .attr-value, .spec-name, .spec-value",
          );
          if (cells.length >= 2) {
            const key = cells[0].textContent.trim().replace(/[:\s]+$/, "");
            const value = cells[1].textContent.trim();
            if (key && value) {
              specs[key] = value;
            }
          }
        }
      }
    }

    // 方式2: 列表形式的规格
    const listSelectors = [
      ".detail-attr-list li",
      ".tb-attr-list li",
      ".product-attribute li",
      ".spec-list li",
      '[data-hook="detail-specification"] li',
    ];

    for (const selector of listSelectors) {
      const items = document.querySelectorAll(selector);
      for (const item of items) {
        const text = item.textContent.trim();
        const colonMatch = text.match(/^([^:：]+)[：:]\s*(.+)$/);
        if (colonMatch) {
          specs[colonMatch[1].trim()] = colonMatch[2].trim();
        }
      }
    }

    return Object.keys(specs).length > 0 ? specs : null;
  }

  // ========== 评分/评论提取 ==========
  function extractRating() {
    const ratingSelectors = [
      "#acrPopover",
      ".a-icon-star",
      '[data-hook="rating-out-of-text"]',
      ".product-rating",
      ".rating-value",
      ".star-rating",
      ".average-rating",
    ];

    for (const selector of ratingSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const ratingMatch = text.match(
          /(\d+\.?\d*)\s*(?:out of|\/|星|stars?)?\s*(\d+)?/i,
        );
        if (ratingMatch) {
          return {
            value: ratingMatch[1],
            max: ratingMatch[2] || "5",
            text: text,
          };
        }
      }
    }

    return null;
  }

  function extractReviewCount() {
    const reviewSelectors = [
      "#acrCustomerReviewCount",
      '[data-hook="total-review-count"]',
      ".review-count",
      ".reviews-count",
      ".rating-count",
    ];

    for (const selector of reviewSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const countMatch = text.match(/([\d,]+)/);
        if (countMatch) {
          return {
            count: countMatch[1].replace(/,/g, ""),
            text: text,
          };
        }
      }
    }

    return null;
  }

  // ========== 品牌提取 ==========
  function extractBrand() {
    const brandSelectors = [
      "#bylineInfo",
      ".po-brand .po-break-word",
      '[data-hook="brand-name"]',
      ".brand-name",
      ".product-brand",
      '[itemprop="brand"]',
    ];

    for (const selector of brandSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        return el.textContent.trim().replace(/^(Visit the |Brand:\s*)/i, "");
      }
    }

    return null;
  }

  // ========== 卖家信息提取 ==========
  function extractSeller() {
    const sellerSelectors = [
      "#sellerProfileTriggerId",
      "#merchant-info a",
      ".seller-name",
      ".shop-name",
      '[data-hook="seller-name"]',
      ".store-name",
    ];

    for (const selector of sellerSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        return {
          name: el.textContent.trim(),
          url: el.href || null,
        };
      }
    }

    return null;
  }

  // ========== 分类面包屑提取 ==========
  function extractCategory() {
    const breadcrumbSelectors = [
      "#wayfinding-breadcrumbs_feature_div a",
      ".a-breadcrumb a",
      '[data-hook="breadcrumb"] a',
      ".breadcrumb a",
      ".breadcrumbs a",
      ".cat-breadcrumb a",
    ];

    const categories = [];
    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 0) {
        for (const link of links) {
          const text = link.textContent.trim();
          if (text && !categories.includes(text)) {
            categories.push(text);
          }
        }
        break;
      }
    }

    return categories.length > 0 ? categories : null;
  }

  // ========== 精简页面文本提取 ==========
  function extractMainText() {
    // 尝试找到主要内容区域
    const mainSelectors = [
      "main",
      "#main-content",
      "#productDescription",
      "#feature-bullets",
      ".product-description",
      ".product-details",
      ".product-info",
      '[data-hook="description"]',
      ".detail-desc",
      ".product-desc",
      "#aplus",
      "#descriptionAndDetails",
    ];

    const textParts = [];

    // 1. 先尝试提取主要内容区域
    for (const selector of mainSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.innerText.trim();
        if (text.length > 50) {
          textParts.push(`[${selector}]\n${text}`);
        }
      }
    }

    // 2. 如果找到了主要内容，返回
    if (textParts.length > 0) {
      return textParts.join('\n\n').substring(0, 15000);
    }

    // 3. fallback: 提取整个 body（排除导航、页脚等）
    const excludeSelectors = [
      'nav', 'footer', 'header',
      '.nav', '.footer', '.header',
      '#nav', '#footer', '#header',
      '.sidebar', '#sidebar',
      'script', 'style', 'noscript'
    ];

    // 克隆 body 并排除不需要的元素
    const bodyClone = document.body.cloneNode(true);
    for (const selector of excludeSelectors) {
      const elements = bodyClone.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    }

    const bodyText = bodyClone.innerText.trim();
    return bodyText.substring(0, 15000);
  }

  // ========== 主提取函数 ==========
  function extract() {
    const url = window.location.href;
    const platform = detectPlatform(url);

    // JSON-LD 数据
    const jsonLd = extractJsonLd();

    // Open Graph 数据
    const og = extractOpenGraph();

    // 从 JSON-LD 和智能猜测中组合数据
    const title = (jsonLd && jsonLd.name) || guessTitle();

    let price = null;
    let currency = null;
    if (jsonLd && jsonLd.offers) {
      const offers = Array.isArray(jsonLd.offers)
        ? jsonLd.offers[0]
        : jsonLd.offers;
      if (offers.price) {
        price = String(offers.price);
        currency = offers.priceCurrency || null;
      }
    }
    if (!price) {
      const guessedPrice = guessPrice();
      if (guessedPrice) {
        price = guessedPrice.value;
        // 尝试从价格文本中提取货币符号
        const currencyMatch = guessedPrice.text.match(/^[\$\€\£\¥\₹\₽\￥]/);
        if (currencyMatch) {
          currency = currencyMatch[0];
        }
      }
    }

    const images = collectImages();
    const specifications = extractSpecifications();
    const rating =
      jsonLd && jsonLd.aggregateRating
        ? {
            value: String(jsonLd.aggregateRating.ratingValue || ""),
            max: String(jsonLd.aggregateRating.bestRating || "5"),
            text: `${jsonLd.aggregateRating.ratingValue}/${jsonLd.aggregateRating.bestRating || 5}`,
          }
        : extractRating();
    const reviewCount =
      jsonLd && jsonLd.aggregateRating
        ? {
            count: String(jsonLd.aggregateRating.reviewCount || ""),
            text: `${jsonLd.aggregateRating.reviewCount} reviews`,
          }
        : extractReviewCount();
    const brand =
      jsonLd && jsonLd.brand
        ? typeof jsonLd.brand === "string"
          ? jsonLd.brand
          : jsonLd.brand.name
        : extractBrand();
    const seller = extractSeller();
    const category = extractCategory();
    const description = (jsonLd && jsonLd.description) || null;

    const result = {
      // 基本信息
      url,
      platform,
      title,
      description,

      // 价格
      price,
      currency,

      // 媒体
      images,
      coverImage: images.length > 0 ? images[0] : (og && og.image) || null,

      // 规格
      specifications,
      brand,

      // 评价
      rating,
      reviewCount,

      // 卖家
      seller,

      // 分类
      category,

      // 来源页面信息
      sourceTitle: document.title,
      ogImage: (og && og.image) || null,

      // 原始数据（供 AI 分析）
      jsonLd,
      og,

      // 精简文本（供 AI 分析）
      mainText: extractMainText(),
    };

    return result;
  }

  // ========== 暴露到全局 ==========
  window.CoreProductExtractor = {
    extract,
    detectPlatform,
    extractJsonLd,
    extractOpenGraph,
    guessTitle,
    guessPrice,
    collectImages,
    extractSpecifications,
    extractRating,
    extractReviewCount,
    extractBrand,
    extractSeller,
    extractCategory,
  };
})();
