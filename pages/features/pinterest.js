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

  async function scrapePinterest(context, params) {
    const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
    const maxCount = params?.count && Number.isFinite(params.count) ? params.count : DEFAULT_MAX_COUNT;
    let tab = null;

    try {
      context.notify('正在后台打开目标页面…', { tone: 'info' });
      tab = await createTabAndWait(targetUrl);

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
        tabId: tab.id, // 返回标签页ID，用于后续关闭
      };
    } finally {
      // 运行结束后自动关闭标签页
      if (tab && tab.id) {
        try {
          chrome.tabs.remove(tab.id, () => {
            if (chrome.runtime.lastError) {
              console.warn('[Pinterest] 关闭标签页失败:', chrome.runtime.lastError.message);
            } else {
              console.log('[Pinterest] 标签页已自动关闭');
            }
          });
        } catch (error) {
          console.warn('[Pinterest] 关闭标签页异常:', error);
        }
      }
    }
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
        defaultValue: DEFAULT_MAX_COUNT,
        tooltip: `达到上限或连续多次无新增图片时会自动停止滚动（默认 ${DEFAULT_MAX_COUNT}）。`,
      },
      {
        key: 'uploadToServer',
        label: '上传到服务器',
        type: 'checkbox',
        defaultValue: true,
        tooltip: '勾选后会将采集到的图片信息上传到服务器素材库（使用原始地址）。',
      },
      {
        key: 'sourceTag',
        label: '素材来源标记',
        type: 'text',
        placeholder: DEFAULT_SOURCE,
        defaultValue: DEFAULT_SOURCE,
        tooltip: '用于服务器入库的 source 字段，便于区分素材来源。',
      },
      {
        key: 'description',
        label: '素材备注',
        type: 'textarea',
        rows: 2,
        defaultValue: 'Pinterest 图片素材',
        placeholder: '用于记录素材描述或批次说明',
      },
      {
        key: 'notifyFeishu',
        label: '发送飞书通知',
        type: 'checkbox',
        defaultValue: true,
        tooltip: '上传完成后推送飞书消息，包含成功/失败统计与示例链接。',
      },
    ],
    previewUrl: DEFAULT_URL,
    renderResult({ card, data }) {
      if (!data?.items) return;
      const pins = formatPinsForDisplay(data.items);
      const container = ensureResultContainer(card);
      container.innerHTML = '';
      // 优化容器样式，使UI更密集
      container.style.padding = '10px'; // 减小内边距
      container.style.gap = '8px'; // 减小间距

      if (!pins.length) {
        container.innerHTML = '<div class="feature-result-empty">未找到有效的图片链接。</div>';
        return;
      }

      const report = data.uploadReport;
      const reportMap = report?.items
        ? new Map(report.items.map((item) => [item.id ?? item.imageUrl, item]))
        : new Map();

      const header = document.createElement('div');
      header.className = 'feature-result-header';
      header.style.fontSize = '11px'; // 减小字体
      header.style.fontWeight = '500';
      header.style.color = '#6c6c70';
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.marginBottom = '8px'; // 减小间距
      header.style.paddingBottom = '6px';
      header.style.borderBottom = '1px solid rgba(0, 0, 0, 0.08)';
      const summaryParts = [`共 ${pins.length} 项`];
      if (report) {
        summaryParts.push(`成功 ${report.successCount || 0}`);
        if (report.failCount) {
          summaryParts.push(`失败 ${report.failCount}`);
        }
      }
      header.innerHTML = `<span>采集结果</span><span>${summaryParts.join(' · ')}</span>`;
      container.appendChild(header);

      pins.forEach((pin, index) => {
        const item = document.createElement('div');
        item.className = 'feature-result-item';
        item.style.padding = '6px 0'; // 减小内边距，使UI更密集
        item.style.borderBottom = '1px solid rgba(0, 0, 0, 0.05)';

        const thumb = document.createElement('div');
        thumb.className = 'feature-result-thumb';
        thumb.style.width = '40px'; // 减小缩略图尺寸
        thumb.style.height = '40px';
        thumb.style.borderRadius = '6px';
        thumb.style.backgroundImage = pin.imageUrl ? `url('${pin.imageUrl}')` : '';
        thumb.style.flexShrink = '0';
        item.appendChild(thumb);

        const body = document.createElement('div');
        body.className = 'feature-result-body';
        body.style.flex = '1';
        body.style.minWidth = '0';
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '3px'; // 减小间距

        const titleRow = document.createElement('div');
        titleRow.style.display = 'flex';
        titleRow.style.alignItems = 'center';
        titleRow.style.gap = '6px';
        
        const title = document.createElement('div');
        title.className = 'feature-result-title';
        title.style.fontSize = '12px'; // 减小字体
        title.style.fontWeight = '500';
        title.style.color = '#1c1c1e';
        title.style.flex = '1';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.style.whiteSpace = 'nowrap';
        title.textContent = pin.title;
        titleRow.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'feature-result-index';
        meta.style.fontSize = '10px'; // 减小字体
        meta.style.color = '#6c6c70';
        meta.style.flexShrink = '0';
        meta.textContent = `#${index + 1}`;
        titleRow.appendChild(meta);
        
        body.appendChild(titleRow);

        const link = document.createElement('a');
        link.className = 'feature-result-link';
        link.href = pin.imageUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.fontSize = '10px'; // 减小字体
        link.style.color = '#007aff';
        link.style.wordBreak = 'break-all';
        link.style.textDecoration = 'none';
        link.style.lineHeight = '1.3';
        link.style.maxHeight = '32px';
        link.style.overflow = 'hidden';
        link.style.display = '-webkit-box';
        link.style.webkitLineClamp = '2';
        link.style.webkitBoxOrient = 'vertical';
        link.textContent = pin.imageUrl;
        body.appendChild(link);

        const reportEntry = reportMap.get(pin.id ?? pin.imageUrl);
        if (reportEntry) {
          const status = document.createElement('div');
          status.className = 'feature-result-status';
          status.style.fontSize = '10px'; // 减小字体
          status.style.marginTop = '2px';
          if (reportEntry.error) {
            status.classList.add('error');
            status.style.color = '#f56c6c';
            status.textContent = `失败：${reportEntry.error}`;
          } else {
            const fragments = [];
            if (reportEntry.serverStatus) {
              if (reportEntry.serverStatus === 'success') {
                const span = document.createElement('span');
                span.textContent = '✓ 已上传';
                span.style.color = '#67c23a';
                fragments.push(span);
              } else if (reportEntry.serverStatus === 'failed') {
                const span = document.createElement('span');
                span.textContent = `✗ ${reportEntry.serverError || '上传失败'}`;
                span.style.color = '#f56c6c';
                fragments.push(span);
              }
            }
            if (fragments.length) {
              status.classList.add('success');
              fragments.forEach((node, idx) => {
                if (idx > 0) {
                  const separator = document.createElement('span');
                  separator.textContent = ' · ';
                  status.appendChild(separator);
                }
                status.appendChild(node);
              });
            } else {
              status.textContent = '✓ 完成';
              status.style.color = '#67c23a';
              status.classList.add('success');
            }
          }
          body.appendChild(status);
        }

        item.appendChild(body);
        container.appendChild(item);
      });
    },
    async run(context, params) {
      try {
        context.setBusy(true);
        const result = await scrapePinterest(context, params);

        const shouldUpload = Boolean(params?.uploadToServer || params?.notifyFeishu);
        if (shouldUpload && result?.data?.items?.length) {
          context.notify('采集完成，正在准备上传到服务器…', { tone: 'info' });
          
          try {
            const uploadResponse = await context.dispatchBackground({
              command: 'pinterest/upload',
              items: result.data.items,
              options: {
                uploadToServer: Boolean(params.uploadToServer),
                notifyFeishu: Boolean(params.notifyFeishu),
                description: params.description || '',
                source: params.sourceTag?.trim() || DEFAULT_SOURCE,
                page: result.data.page || null,
              },
            });

            if (uploadResponse?.items) {
              const { successCount = 0, failCount = 0 } = uploadResponse;
              const tone = failCount > 0 ? 'warning' : 'success';
              context.notify(`上传完成：成功 ${successCount} 条${failCount ? `，失败 ${failCount} 条` : ''}`, { tone });
              if (uploadResponse.error && failCount > 0) {
                context.notify(uploadResponse.error, { tone: 'warning' });
              }
              result.data.uploadReport = uploadResponse;
            } else if (uploadResponse?.error) {
              context.notify(`上传失败：${uploadResponse.error}`, { tone: 'error' });
            }
          } catch (error) {
            context.notify(error?.message || '上传过程出现异常', { tone: 'error' });
          }
        }

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
      // 设置更密集的样式
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.gap = '8px';
      container.style.padding = '10px';
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

