// handlers/sora.js: Sora 消息处理器
(function(global) {
  'use strict';

  const Base = global.MessageHandlers?.Base;
  if (!Base) {
    console.error('[Sora] Base 工具未加载，请确保 base.js 先加载');
    return;
  }

  const DEFAULT_URL = 'https://sora.chatgpt.com/explore?type=images';
  const CONTENT_SCRIPT_TIMEOUT = 90000;
  const DEFAULT_MAX_COUNT = 24;
  const DEFAULT_SOURCE = 'sora';

  const SERVER_UPLOAD_URL = 'https://1s.design:1520/api/crawler/material/add';
  const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449';

  function waitForSoraGallery(timeoutMs = 35000, pollInterval = 800) {
    const start = Date.now();

    function hasGallery() {
      const selectors = [
        'main .box-content + div',
        'main section div img',
        'main [data-testid] img',
      ];
      return selectors.some((selector) => document.querySelector(selector));
    }

    if (hasGallery()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (hasGallery()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, pollInterval);
    });
  }

  async function scrapeSoraImagesInPage(options = {}) {
    const {
      maxCount = 30,
      scrollDelay = 1200,
      maxScrollSteps = 80,
      maxIdleRounds = 6,
      timeout = 120000,
    } = options || {};

    const start = Date.now();
    const collectedMap = new Map(); // key -> item
    const orderedKeys = [];
    let idleRounds = 0;

    const IMAGE_SELECTORS = [
      'body > main > div > div.h-full.max-h-screen.min-h-screen.w-full > div > div > div.min-w-0.flex-1 > div > div > div.relative.flex.w-full.flex-col.gap-2 img',
      'main .box-content + div img',
    ];

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function buildKey(item) {
      return item.imageUrl || item.url || `${item.alt || 'unknown'}-${item.description || ''}`;
    }

    function upsertItem(item) {
      const key = buildKey(item);
      if (!key || collectedMap.has(key)) {
        return false;
      }
      collectedMap.set(key, item);
      orderedKeys.push(key);
      return true;
    }

    function shouldSkipImage(img, src) {
      if (!src) return true;
      const lower = src.toLowerCase();

      // 过滤掉 Google 头像等外部小头像
      if (lower.includes('lh3.googleusercontent.com') && lower.includes('/a/')) {
        return true;
      }

      // 过滤明显很小的头像类图片（避免误采集）
      try {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w && h && w <= 120 && h <= 120) {
          return true;
        }
      } catch (_) {}

      return false;
    }

    function collectOnce() {
      let newCount = 0;

      for (const selector of IMAGE_SELECTORS) {
        const nodeList = document.querySelectorAll(selector);
        nodeList.forEach((img) => {
          const src = img.currentSrc || img.src;
          if (shouldSkipImage(img, src)) {
            return;
          }

          const link = img.closest('a[href]');
          const description =
            img.alt ||
            img.getAttribute('aria-label') ||
            img.closest('figcaption')?.textContent?.trim() ||
            '';

          const item = {
            imageUrl: src,
            url: link ? link.href : '',
            description,
            alt: img.alt || '',
          };

          if (upsertItem(item)) {
            newCount += 1;
          }
        });
      }

      return newCount;
    }

    for (let step = 0; step < maxScrollSteps; step += 1) {
      if (Date.now() - start > timeout) {
        break;
      }

      const newlyAdded = collectOnce();
      if (newlyAdded > 0) {
        idleRounds = 0;
      } else {
        idleRounds += 1;
      }

      if (collectedMap.size >= maxCount) {
        break;
      }

      if (idleRounds >= maxIdleRounds) {
        break;
      }

      window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
      await sleep(scrollDelay);
    }

    const orderedItems = orderedKeys.map((key) => collectedMap.get(key));

    return {
      items: orderedItems.slice(0, maxCount),
      collectedAt: new Date().toISOString(),
      page: {
        url: location.href,
        title: document.title,
      },
      metrics: {
        elapsedMs: Date.now() - start,
        total: orderedItems.length,
      },
    };
  }

  async function uploadMaterialToServer(payload) {
    const response = await fetch(SERVER_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((error) => {
      throw new Error(`保存到服务器失败: ${Base.serializeError(error)}`);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`服务器返回异常 (${response.status}): ${text.slice(0, 120)}`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`解析服务器响应失败: ${Base.serializeError(error)}`);
    }
  }

  async function sendFeishuNotification(lines) {
    if (!FEISHU_WEBHOOK_URL) {
      return;
    }
    const payload = {
      msg_type: 'text',
      content: {
        text: lines.join('\n'),
      },
    };
    await fetch(FEISHU_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((error) => {
      console.warn('[Sora] 发送飞书通知失败:', Base.serializeError(error));
    });
  }

  async function processUpload(items, options) {
    const notifyFeishu = Boolean(options.notifyFeishu);
    const description = (options.description || '').trim();
    const source = (options.source || DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
    const pageInfo = options.page || null;
    const uploadToServer = Boolean(options.uploadToServer);

    if (!items.length) {
      return {
        success: false,
        error: '没有可处理的图片数据',
      };
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const resultEntry = {
        id: item?.imageUrl || `item-${index}`,
        imageUrl: item?.imageUrl,
        description: item?.description || item?.alt || '',
      };

      try {
        if (!item?.imageUrl) {
          throw new Error('缺少图片地址');
        }

        const extension = Base.guessExtension(item.imageUrl, null).replace('.', '') || 'jpg';

        if (uploadToServer) {
          try {
            const serverPayload = {
              url: item.imageUrl,
              originUrl: item.imageUrl,
              name: item?.description || item?.alt || `Sora图片_${index + 1}`,
              description: description || item?.description || item?.alt || '',
              keywords: item?.description || item?.alt || '',
              suffix: extension,
              source,
              meta: {
                original: {
                  imageUrl: item?.imageUrl,
                  description: item?.description || item?.alt || '',
                  url: item?.url,
                },
                page: pageInfo,
                collectedAt: new Date().toISOString(),
              },
            };

            const serverResponse = await uploadMaterialToServer(serverPayload);
            resultEntry.serverStatus = 'success';
            resultEntry.serverResponse = serverResponse;
          } catch (serverError) {
            resultEntry.serverStatus = 'failed';
            resultEntry.serverError = Base.serializeError(serverError);
          }
        }

        successCount += 1;
      } catch (error) {
        failCount += 1;
        resultEntry.error = Base.serializeError(error);
      }

      results.push(resultEntry);
    }

    if (notifyFeishu) {
      const lines = [
        'Sora 采集任务完成 ✅',
        `成功: ${successCount}，失败: ${failCount}`,
        `来源: ${source}`,
      ];
      if (pageInfo?.url) {
        lines.push(`页面: ${pageInfo.url}`);
      }
      if (failCount) {
        const failedExample = results.filter((item) => item.error).slice(0, 3);
        if (failedExample.length) {
          lines.push('失败示例:');
          failedExample.forEach((entry) => {
            lines.push(`- ${entry.imageUrl} => ${entry.error}`);
          });
        }
      }
      await sendFeishuNotification(lines);
    }

    const summary = {
      success: failCount === 0,
      successCount,
      failCount,
      items: results,
      source,
      page: pageInfo,
      message: `成功处理 ${successCount} 张图片${failCount > 0 ? `，${failCount} 张失败` : ''}`,
    };

    if (failCount > 0) {
      summary.error = '部分图片处理失败';
    }

    return summary;
  }

  async function executeScrape(params, logFn = console.log) {
    const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
    const maxCount = params?.count && Number.isFinite(params.count) ? parseInt(params.count, 10) : DEFAULT_MAX_COUNT;
    let tab = null;

    try {
      logFn('[Sora] 开始执行爬取任务:', { targetUrl, maxCount });

      tab = await Base.createTabAndWait(targetUrl);
      logFn('[Sora] 页面加载完成，等待内容渲染…');

      const ready = await Base.executeScript(tab.id, waitForSoraGallery, [40000, 800]);
      if (!ready) {
        throw new Error('在限定时间内未检测到图片列表，请确认页面内容或登录状态');
      }

      logFn('[Sora] 内容就绪，开始采集图片…');
      const scrapeOptions = {
        maxCount,
        scrollDelay: 1200,
        maxScrollSteps: 80,
        maxIdleRounds: 6,
        timeout: CONTENT_SCRIPT_TIMEOUT,
      };

      const data = await Base.executeScript(tab.id, scrapeSoraImagesInPage, [scrapeOptions]);

      if (!data || data.error) {
        throw new Error(data?.error || '采集失败，请稍后重试');
      }

      logFn(`[Sora] 采集完成，共 ${data.items.length} 条图片链接`);

      return {
        success: true,
        data,
        message: `采集完成，共 ${data.items.length} 条图片链接`,
      };
    } catch (error) {
      logFn('[Sora] 执行爬取任务失败:', Base.serializeError(error));
      return {
        success: false,
        error: Base.serializeError(error),
      };
    } finally {
      if (tab && tab.id) {
        try {
          chrome.tabs.remove(tab.id, () => {
            if (chrome.runtime.lastError) {
              logFn('[Sora] 关闭标签页失败:', chrome.runtime.lastError.message);
            } else {
              logFn('[Sora] 标签页已自动关闭');
            }
          });
        } catch (error) {
          logFn('[Sora] 关闭标签页异常:', Base.serializeError(error));
        }
      }
    }
  }

  async function handleSoraScrape(data, options = {}) {
    const { logFn = console.log, socket = null } = options;
    const params = data.params || {};

    logFn('[Sora] 收到爬取命令:', params);

    try {
      const result = await executeScrape(params, logFn);

      if (!result.success) {
        throw new Error(result.error || '爬取任务失败');
      }

      if (result?.data?.items?.length) {
        const items = result.data.items;
        logFn(`[Sora] 采集结果：共 ${items.length} 张图片链接：`);
        items.forEach((item, index) => {
          const url = item?.imageUrl || item?.url || '';
          logFn(`[Sora] [${index + 1}/${items.length}] ${url}`);
        });
      } else {
        logFn('[Sora] 采集结果为空，没有获取到任何图片链接');
      }

      const shouldUpload = Boolean(params?.uploadToServer || params?.notifyFeishu);
      if (shouldUpload && result?.data?.items?.length) {
        logFn('[Sora] 开始上传到服务器…');

        try {
          const uploadResponse = await processUpload(result.data.items, {
            uploadToServer: Boolean(params.uploadToServer),
            notifyFeishu: Boolean(params.notifyFeishu),
            description: params.description || '',
            source: params.sourceTag?.trim() || DEFAULT_SOURCE,
            page: result.data.page || null,
          });

          if (uploadResponse?.items) {
            const { successCount = 0, failCount = 0 } = uploadResponse;
            logFn(`[Sora] 上传完成：成功 ${successCount} 条${failCount ? `，失败 ${failCount} 条` : ''}`);
          } else if (uploadResponse?.error) {
            logFn(`[Sora] 上传失败：${uploadResponse.error}`);
          }
        } catch (error) {
          logFn('[Sora] 上传过程出现异常:', Base.serializeError(error));
        }
      }

      if (socket && socket.connected) {
        socket.emit('sora-scrape-result', {
          success: true,
          message: result.message || '爬取完成',
          data: {
            itemCount: result.data?.items?.length || 0,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return result;
    } catch (error) {
      logFn('[Sora] 处理爬取命令失败:', Base.serializeError(error));

      if (socket && socket.connected) {
        socket.emit('sora-scrape-result', {
          success: false,
          error: Base.serializeError(error),
          timestamp: new Date().toISOString(),
        });
      }

      throw error;
    }
  }

  global.MessageHandlers = global.MessageHandlers || {};
  global.MessageHandlers.Sora = {
    handle: handleSoraScrape,
  };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

