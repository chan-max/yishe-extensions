// @ts-nocheck
// product-collector.ts: 商品采集站点模块
// 采集 + AI 分析一体化

if (!window.CoreSiteModules) {
  window.CoreSiteModules = {};
}

window.CoreSiteModules.productCollector = {
  init(siteInfo) {
    console.log("[Core ProductCollector] 商品采集模块已加载", siteInfo);
  },

  async getMenuItems(siteInfo) {
    return [
      {
        icon: "🤖",
        label: "采集并分析",
        action: () => {
          this.collectAndAnalyze();
        },
      },
    ];
  },

  async collectAndAnalyze() {
    if (!window.CoreProductExtractor) {
      window.CoreToast?.show?.({ message: "商品提取器未加载", type: "error" });
      return;
    }

    const loadingId = window.CoreLoading?.show?.("正在采集商品信息...");

    try {
      // 1. 提取商品数据
      const productData = window.CoreProductExtractor.extract();

      if (!productData.title) {
        throw new Error("未能提取到商品标题，可能不是商品页面");
      }

      // 2. AI 分析
      window.CoreLoading?.update?.(loadingId, "正在进行 AI 分析...");
      const aiResult = await this.performAiAnalysis(productData);

      // 3. 发送到 background 保存到服务端
      window.CoreLoading?.update?.(loadingId, "正在保存到服务端...");

      const collectData = {
        action: "collectProduct",
        data: {
          collectType: "product",
          sourceUrl: productData.url,
          sourceTitle: (productData.title || "").substring(0, 500),
          data: {
            // 基本信息
            title: productData.title,
            description: productData.description,
            platform: productData.platform,
            
            // 价格信息
            price: productData.price,
            currency: productData.currency,
            
            // 媒体
            images: productData.images,
            coverImage: productData.coverImage,
            
            // 规格参数
            specifications: productData.specifications,
            brand: productData.brand,
            
            // 评价
            rating: productData.rating,
            reviewCount: productData.reviewCount,
            
            // 卖家
            seller: productData.seller,
            
            // 分类
            category: productData.category,
            
            // 页面文本内容（供 AI 分析）
            mainText: productData.mainText?.substring(0, 15000),
          },
          aiAnalysis: {
            ...aiResult.analysis,
            model: aiResult.model,
            provider: aiResult.provider,
          },
        },
      };

      chrome.runtime.sendMessage(collectData, (response) => {
        window.CoreLoading?.hide?.(loadingId);

        if (response && response.success) {
          window.CoreToast?.show?.({
            message: "采集并分析完成！",
            type: "success",
            duration: 3000,
          });
        } else {
          window.CoreToast?.show?.({
            message: "保存失败: " + (response?.error || "未知错误"),
            type: "error",
            duration: 4000,
          });
        }
      });
    } catch (error) {
      window.CoreLoading?.hide?.(loadingId);
      window.CoreToast?.show?.({
        message: "采集失败: " + error.message,
        type: "error",
        duration: 4000,
      });
    }
  },

  async performAiAnalysis(productData) {
    const aiKeyData = await this.fetchUserApiKey();

    if (!aiKeyData || !aiKeyData.encryptedKey) {
      throw new Error("没有可用的 AI API Key，请在管理后台配置");
    }

    const apiKey = aiKeyData.encryptedKey;
    const baseUrl = aiKeyData.config?.baseURL || "https://api.openai.com/v1";
    const model = aiKeyData.config?.model || "gpt-4o-mini";

    const prompt = this.buildAnalysisPrompt(productData);

    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: "system",
              content:
                "你是一个电商选品专家。请分析商品信息，输出精简有效的结构化 JSON。只输出 JSON，不要其他内容。",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `AI 请求失败 (${response.status}): ${errorText || response.statusText}`,
      );
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("AI 返回内容为空");
    }

    // 直接返回 Markdown 字符串
    return {
      analysis: content,
      model: model,
      provider: aiKeyData.name || "openai",
    };
  },

  async fetchUserApiKey() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "getUserApiKey", feature: "extension_collect" },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response?.error || "获取 API Key 失败"));
          }
        },
      );
    });
  },

  buildAnalysisPrompt(productData) {
    return `请分析以下商品，生成一份 Markdown 格式的分析报告。

商品来源：${productData.platform}
商品链接：${productData.url}
商品标题：${productData.title}
价格：${productData.price || "未知"} ${productData.currency || ""}
品牌：${productData.brand || "未知"}
评分：${productData.rating ? `${productData.rating.value}/${productData.rating.max}` : "无"}
评论数：${productData.reviewCount ? `${productData.reviewCount.count} 条` : "无"}
卖家：${productData.seller?.name || "未知"}

请输出 Markdown 格式的分析报告，包含以下内容（可根据实际情况灵活调整）：

# 商品名称

## 基本信息
用表格展示价格、品牌、评分、卖家等

## 一句话总结
简要描述这个商品的核心价值

## 核心卖点
- 卖点1
- 卖点2
- ...

## 目标人群
描述目标消费群体

## 价格分析
价格区间、是否有竞争力

## 竞品参考
列出竞品或替代品

## 关键词
相关搜索关键词

## 市场潜力
评估市场潜力（高/中/低）及原因

## 风险提示
潜在问题或风险

## 设计元素（如果是图案/服饰类）
可提取的 POD 设计元素

请直接输出 Markdown，不要加 \`\`\`markdown 代码块标记。`;
  },
};
