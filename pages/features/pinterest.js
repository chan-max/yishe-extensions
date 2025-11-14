;(function () {
  const registry = window.ControlFeatureRegistry;

  if (!registry) {
    console.warn('[control][pinterest] ControlFeatureRegistry 未就绪，功能注册失败');
    return;
  }

  const DEFAULT_URL = 'https://www.pinterest.com/today/';
  const CONTENT_SCRIPT_TIMEOUT = 60000;
  const PIN_READY_TIMEOUT = 15000;
  const PIN_READY_POLL_INTERVAL = 600;
  const DEFAULT_MAX_COUNT = 10;
  const DEFAULT_SOURCE = 'pinterest';

  async function createTabAndWait(url, timeoutMs = 45000) {
    if (!chrome?.tabs?.create) {
      throw new Error('当前环境不支持创建标签页');
    }

    // 在后台打开标签页，不激活（不跳转）
    const tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (createdTab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || '创建标签页失败'));
          return;
        }
        resolve(createdTab);
      });
    });

    await waitForTabComplete(tab.id, timeoutMs);
    return tab;
  }

  function waitForTabComplete(tabId, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待页面加载超时，可能网络较慢或链接不可达'));
      }, timeoutMs);

      function listener(updatedTabId, changeInfo, tab) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      }

      function cleanup() {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function executeScrape(tabId, options) {
    if (!chrome?.scripting?.executeScript) {
      throw new Error('当前环境不支持脚本注入，请检查扩展权限');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapePinsInPage,
      args: [options],
    });

    const first = Array.isArray(results) ? results[0] : null;
    const result = first?.result;

    if (!result || typeof result !== 'object') {
      throw new Error('采集结果无效，可能页面结构发生变更');
    }
    if (result.error) {
      throw new Error(result.error);
    }
    return result;
  }

  async function waitForPinContent(tabId, timeoutMs, pollInterval) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: waitForPinsInPage,
      args: [timeoutMs, pollInterval],
    });

    const first = Array.isArray(results) ? results[0] : null;
    return Boolean(first?.result);
  }


  function formatPinsForDisplay(pins) {
    return pins.map((pin) => ({
      id: pin.id,
      title: pin.description || pin.alt || '未命名图片',
      imageUrl: pin.imageUrl,
    }));
  }

  // 执行爬取的核心函数（从后台调用）
  async function executeScrapeTask(params) {
    const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
    const maxCount = params?.count && Number.isFinite(params.count) ? params.count : DEFAULT_MAX_COUNT;
    let tab = null;

    try {
      log('[Pinterest] 开始执行爬取任务:', { targetUrl, maxCount });
      tab = await createTabAndWait(targetUrl);

      log('[Pinterest] 页面加载完成，等待内容渲染…');
      const ready = await waitForPinContent(tab.id, PIN_READY_TIMEOUT, PIN_READY_POLL_INTERVAL);
      if (!ready) {
        throw new Error('在限定时间内未检测到图片列表，请确认页面内容或登录状态');
      }

      log('[Pinterest] 内容就绪，开始采集图片…');
      const scrapeOptions = {
        maxCount,
        scrollDelay: 1200,
        maxRounds: 60,
        maxIdleRounds: 3,
        timeout: CONTENT_SCRIPT_TIMEOUT,
      };

      const data = await executeScrape(tab.id, scrapeOptions);
      log(`[Pinterest] 采集完成，共 ${data.items.length} 条图片链接`);

      return {
        success: true,
        data,
        message: `采集完成，共 ${data.items.length} 条图片链接`,
      };
    } catch (error) {
      log('[Pinterest] 爬取任务失败:', error);
      return {
        success: false,
        error: error?.message || '爬取任务失败',
      };
    } finally {
      // 运行结束后自动关闭标签页
      if (tab && tab.id) {
        try {
          chrome.tabs.remove(tab.id, () => {
            if (chrome.runtime.lastError) {
              log('[Pinterest] 关闭标签页失败:', chrome.runtime.lastError.message);
            } else {
              log('[Pinterest] 标签页已自动关闭');
            }
          });
        } catch (error) {
          log('[Pinterest] 关闭标签页异常:', error);
        }
      }
    }
  }

  function log(...args) {
    console.log('[Pinterest]', ...args);
  }

  // 注意：此文件仅保留执行逻辑，不注册 UI
  // 功能已完全移至管理系统，插件端仅负责接收 WebSocket 消息并执行
  // 后台 service-worker.js 会监听 admin-message 事件并调用执行函数

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

      async function sleep(ms) {
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

  async function waitForPinsInPage(timeoutMs = 15000, pollInterval = 600) {
    const start = Date.now();

    function hasPins() {
      return document.querySelector('div[data-test-id="pin"], [data-grid-item="true"]');
    }

    if (hasPins()) {
      return true;
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
})();

