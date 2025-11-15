// handlers/pinterest.js: Pinterest 消息处理器
(function(global) {
  'use strict';

  const Base = global.MessageHandlers?.Base;
  if (!Base) {
    console.error('[Pinterest] Base 工具未加载，请确保 base.js 先加载');
    return;
  }

  // 常量定义
  const DEFAULT_URL = 'https://www.pinterest.com/today/';
  const CONTENT_SCRIPT_TIMEOUT = 60000;
  const PIN_READY_TIMEOUT = 15000;
  const PIN_READY_POLL_INTERVAL = 600;
  const DEFAULT_MAX_COUNT = 10;
  const DEFAULT_SOURCE = 'pinterest';

  // 服务器上传配置
  const SERVER_UPLOAD_URL = 'https://1s.design:1520/api/crawler/material/add';
  const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449';

  // 页面上下文执行函数：爬取 Pinterest 图片
  async function scrapePinsInPage(options = {}) {
    try {
      const {
        maxCount = 50,
        maxRounds = 60,
        scrollDelay = 1200,
        maxIdleRounds = 3,
        timeout = 60000,
      } = options;

      const start = Date.now();
      const seen = new Set();
      const items = [];
      let idleRounds = 0;

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function collectOnce() {
        const pins = [];
        document
          .querySelectorAll('div[data-test-id="pin"], [data-grid-item="true"]')
          .forEach((pinElement) => {
            const linkElement = pinElement.querySelector('a[href*="/pin/"]');
            const imgElement = pinElement.querySelector('img');
            const descriptionElement = pinElement.querySelector('[data-test-id="pin-description"]');

            if (!linkElement || !imgElement) {
              return;
            }

            const idMatch = linkElement.href.match(/\/pin\/(\d+)/);
            const id = idMatch ? idMatch[1] : linkElement.href;
            if (!id || seen.has(id)) {
              return;
            }

            seen.add(id);

            const imageUrl = imgElement.srcset
              ? imgElement.srcset.split(',').pop().trim().split(' ')[0]
              : imgElement.currentSrc || imgElement.src;

            pins.push({
              id,
              url: linkElement.href,
              imageUrl,
              alt: imgElement.alt || imgElement.title || '',
              description: descriptionElement ? descriptionElement.innerText.trim() : '',
            });
          });
        return pins;
      }

      for (let round = 0; round < maxRounds; round += 1) {
        if (Date.now() - start > timeout) {
          break;
        }

        const newPins = collectOnce();
        if (newPins.length === 0) {
          idleRounds += 1;
        } else {
          idleRounds = 0;
          items.push(...newPins);
        }

        if (items.length >= maxCount) {
          break;
        }

        if (idleRounds >= maxIdleRounds) {
          break;
        }

        window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
        await sleep(scrollDelay);
      }

      return {
        items,
        collectedAt: new Date().toISOString(),
        page: {
          url: location.href,
          title: document.title,
        },
        metrics: {
          elapsedMs: Date.now() - start,
          total: items.length,
        },
      };
    } catch (error) {
      return { error: error?.message || '采集过程中出现未知错误' };
    }
  }

  // 页面上下文执行函数：等待 Pinterest 内容加载
  function waitForPinsInPage(timeoutMs = 15000, pollInterval = 600) {
    const start = Date.now();

    function hasPins() {
      return document.querySelector('div[data-test-id="pin"], [data-grid-item="true"]');
    }

    if (hasPins()) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (hasPins()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, pollInterval);
    });
  }

  /**
   * 上传素材到服务器
   */
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

  /**
   * 发送飞书通知
   */
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
      console.warn('[Pinterest] 发送飞书通知失败:', Base.serializeError(error));
    });
  }

  /**
   * 处理上传任务
   */
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

    console.log('[Pinterest] 开始处理图片，数量:', items.length);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const resultEntry = {
        id: item?.id || item?.imageUrl || `item-${index}`,
        imageUrl: item?.imageUrl,
        description: item?.description || item?.alt || '',
      };

      try {
        if (!item?.imageUrl) {
          throw new Error('缺少图片地址');
        }

        console.log(`[Pinterest] 正在处理图片 ${index + 1}/${items.length}:`, item.imageUrl);

        const extension = Base.guessExtension(item.imageUrl, null);
        const suffix = extension.replace('.', '').toLowerCase() || 'jpg';

        if (uploadToServer) {
          try {
            const serverPayload = {
              url: item.imageUrl,
              originUrl: item.imageUrl,
              name: item?.description || item?.alt || `Pinterest图片_${index + 1}`,
              description: description || item?.description || item?.alt || '',
              keywords: item?.description || item?.alt || '',
              suffix: suffix,
              source: source,
              meta: {
                original: {
                  id: item?.id,
                  imageUrl: item?.imageUrl,
                  description: item?.description || item?.alt || '',
                  url: item?.url,
                },
                page: pageInfo,
                collectedAt: new Date().toISOString(),
              },
            };

            console.log(`[Pinterest] 正在上传到服务器 ${index + 1}/${items.length}`);
            const serverResponse = await uploadMaterialToServer(serverPayload);
            
            resultEntry.serverStatus = 'success';
            resultEntry.serverResponse = serverResponse;
            console.log(`[Pinterest] 图片 ${index + 1} 上传到服务器成功`);
          } catch (serverError) {
            resultEntry.serverStatus = 'failed';
            resultEntry.serverError = Base.serializeError(serverError);
            console.log(`[Pinterest] 图片 ${index + 1} 上传到服务器失败:`, resultEntry.serverError);
          }
        }

        successCount += 1;
        console.log(`[Pinterest] 图片 ${index + 1} 处理成功`);
      } catch (error) {
        failCount += 1;
        resultEntry.error = Base.serializeError(error);
        console.log('[Pinterest] 单项处理失败:', resultEntry.error);
      }

      results.push(resultEntry);
    }

    if (notifyFeishu) {
      const lines = [
        'Pinterest 采集任务完成 ✅',
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

    console.log('[Pinterest] 处理完成:', summary);
    return summary;
  }

  /**
   * 执行爬取任务
   */
  async function executeScrape(params, logFn = console.log) {
    const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
    const maxCount = params?.count && Number.isFinite(params.count) ? params.count : DEFAULT_MAX_COUNT;
    let tab = null;
    
    try {
      logFn('[Pinterest] 开始执行爬取任务:', { targetUrl, maxCount });
      
      tab = await Base.createTabAndWait(targetUrl);
      
      logFn('[Pinterest] 页面加载完成，等待内容渲染…');
      
      const ready = await Base.executeScript(tab.id, waitForPinsInPage, [PIN_READY_TIMEOUT, PIN_READY_POLL_INTERVAL]);
      if (!ready) {
        throw new Error('在限定时间内未检测到图片列表，请确认页面内容或登录状态');
      }
      
      logFn('[Pinterest] 内容就绪，开始采集图片…');
      const scrapeOptions = {
        maxCount,
        scrollDelay: 1200,
        maxRounds: 60,
        maxIdleRounds: 3,
        timeout: CONTENT_SCRIPT_TIMEOUT,
      };
      
      const data = await Base.executeScript(tab.id, scrapePinsInPage, [scrapeOptions]);
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      logFn(`[Pinterest] 采集完成，共 ${data.items.length} 条图片链接`);
      
      return {
        success: true,
        data,
        message: `采集完成，共 ${data.items.length} 条图片链接`,
      };
    } catch (error) {
      logFn('[Pinterest] 执行爬取任务失败:', Base.serializeError(error));
      return {
        success: false,
        error: Base.serializeError(error),
      };
    } finally {
      if (tab && tab.id) {
        try {
          chrome.tabs.remove(tab.id, () => {
            if (chrome.runtime.lastError) {
              logFn('[Pinterest] 关闭标签页失败:', chrome.runtime.lastError.message);
            } else {
              logFn('[Pinterest] 标签页已自动关闭');
            }
          });
        } catch (error) {
          logFn('[Pinterest] 关闭标签页异常:', Base.serializeError(error));
        }
      }
    }
  }

  /**
   * 处理 Pinterest 爬取命令
   */
  async function handlePinterestScrape(data, options = {}) {
    const { logFn = console.log, socket = null } = options;
    const params = data.params || {};
    
    logFn('[Pinterest] 收到爬取命令:', params);
    
    try {
      const result = await executeScrape(params, logFn);
      
      if (!result.success) {
        throw new Error(result.error || '爬取任务失败');
      }
      
      const shouldUpload = Boolean(params?.uploadToServer || params?.notifyFeishu);
      if (shouldUpload && result?.data?.items?.length) {
        logFn('[Pinterest] 开始上传到服务器…');
        
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
            logFn(`[Pinterest] 上传完成：成功 ${successCount} 条${failCount ? `，失败 ${failCount} 条` : ''}`);
          } else if (uploadResponse?.error) {
            logFn(`[Pinterest] 上传失败：${uploadResponse.error}`);
          }
        } catch (error) {
          logFn('[Pinterest] 上传过程出现异常:', Base.serializeError(error));
        }
      }
      
      // 通过 WebSocket 发送结果回管理系统（如果需要）
      if (socket && socket.connected) {
        socket.emit('pinterest-scrape-result', {
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
      logFn('[Pinterest] 处理爬取命令失败:', Base.serializeError(error));
      
      if (socket && socket.connected) {
        socket.emit('pinterest-scrape-result', {
          success: false,
          error: Base.serializeError(error),
          timestamp: new Date().toISOString(),
        });
      }
      
      throw error;
    }
  }

  // 暴露到全局
  global.MessageHandlers = global.MessageHandlers || {};
  global.MessageHandlers.Pinterest = {
    handle: handlePinterestScrape,
  };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
