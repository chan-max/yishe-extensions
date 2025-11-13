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

  async function createTabAndWait(url, timeoutMs = 45000) {
    if (!chrome?.tabs?.create) {
      throw new Error('当前环境不支持创建标签页');
    }

    const tab = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: true }, (createdTab) => {
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

  async function scrapePinterest(context, params) {
    const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
    const maxCount = params?.count && Number.isFinite(params.count) ? params.count : 50;

    context.notify('正在打开目标页面…', { tone: 'info' });
    const tab = await createTabAndWait(targetUrl);

    context.notify('页面加载完成，等待内容渲染…', { tone: 'info' });

    const ready = await waitForPinContent(tab.id, PIN_READY_TIMEOUT, PIN_READY_POLL_INTERVAL);
    if (!ready) {
      throw new Error('在限定时间内未检测到图片列表，请确认页面内容或登录状态');
    }

    context.notify('内容就绪，开始采集图片…', { tone: 'info' });
    const scrapeOptions = {
      maxCount,
      scrollDelay: 1200,
      maxRounds: 60,
      maxIdleRounds: 3,
      timeout: CONTENT_SCRIPT_TIMEOUT,
    };

    const data = await executeScrape(tab.id, scrapeOptions);

    return {
      message: `采集完成，共 ${data.items.length} 条图片链接。`,
      tone: 'success',
      data,
    };
  }

  function formatPinsForDisplay(pins) {
    return pins.map((pin) => ({
      id: pin.id,
      title: pin.description || pin.alt || '未命名图片',
      imageUrl: pin.imageUrl,
    }));
  }

  registry.registerFeature('data-scraping', {
    id: 'pinterest-scraper',
    order: 1,
    groupMeta: {
      title: '数据爬取',
      description: '统一管理各类站点的数据采集脚本，支撑素材归档与数据分析。',
      icon: '🧲',
      order: 1,
    },
    name: 'Pinterest 图片采集',
    summary: '跳转 Pinterest 目标页面并执行图片采集流程。',
    description:
      '在插件内部直接打开 Pinterest 页面并提取图片信息，后续可与 WebSocket 管理后台进行联动。',
    tags: ['Pinterest', '图片采集', '即时运行'],
    params: [
      {
        key: 'targetUrl',
        label: '目标页面 URL',
        type: 'url',
        placeholder: 'https://www.pinterest.com/collections/xxx/',
        defaultValue: DEFAULT_URL,
        tooltip: '将跳转到指定页面等待资源加载，建议使用已登录账号可访问的链接。',
      },
      {
        key: 'count',
        label: '采集数量上限',
        type: 'number',
        min: 1,
        max: 500,
        defaultValue: 50,
        tooltip: '达到上限或连续多次无新增图片时会自动停止滚动。',
      },
    ],
    previewUrl: DEFAULT_URL,
    renderResult({ card, data }) {
      if (!data?.items) return;
      const pins = formatPinsForDisplay(data.items);
      const container = ensureResultContainer(card);
      container.innerHTML = '';

      if (!pins.length) {
        container.innerHTML = '<div class="feature-result-empty">未找到有效的图片链接。</div>';
        return;
      }

      const header = document.createElement('div');
      header.className = 'feature-result-header';
      header.innerHTML = `<span>采集结果</span><span>共 ${pins.length} 项</span>`;
      container.appendChild(header);

      pins.forEach((pin, index) => {
        const item = document.createElement('div');
        item.className = 'feature-result-item';

        const thumb = document.createElement('div');
        thumb.className = 'feature-result-thumb';
        thumb.style.backgroundImage = pin.imageUrl ? `url('${pin.imageUrl}')` : '';
        item.appendChild(thumb);

        const body = document.createElement('div');
        body.className = 'feature-result-body';

        const title = document.createElement('div');
        title.className = 'feature-result-title';
        title.textContent = pin.title;
        body.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'feature-result-index';
        meta.textContent = `#${index + 1}`;
        body.appendChild(meta);

        const link = document.createElement('a');
        link.className = 'feature-result-link';
        link.href =  pin.imageUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent =  pin.imageUrl;
        body.appendChild(link);

        item.appendChild(body);
        container.appendChild(item);
      });
    },
    async run(context, params) {
      try {
        context.setBusy(true);
        const result = await scrapePinterest(context, params);
        return result;
      } finally {
        context.setBusy(false);
      }
    },
  });

  function ensureResultContainer(card) {
    let container = card.querySelector('.feature-result');
    if (!container) {
      container = document.createElement('div');
      container.className = 'feature-result';
      card.appendChild(container);
    }
    return container;
  }

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

