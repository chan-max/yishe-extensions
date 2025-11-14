;(function () {
  const registry = window.ControlFeatureRegistry;

  document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupOpenPopup();
    setupFeatureBoard();
  });

  function setupNavigation() {
    const navItems = Array.from(document.querySelectorAll('.control-nav-item'));
    if (!navItems.length) return;

    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        navItems.forEach((nav) => nav.classList.remove('active'));
        item.classList.add('active');
      });
    });
  }

  function setupOpenPopup() {
    const openPopupBtn = document.getElementById('control-open-popup');
    if (!openPopupBtn) return;

    openPopupBtn.addEventListener('click', () => {
      try {
        const popupUrl = chrome?.runtime?.getURL('popup/popup.html') || '../popup/popup.html';
        if (chrome?.tabs?.create) {
          chrome.tabs.create({ url: popupUrl });
        } else {
          window.open(popupUrl, '_blank');
        }
      } catch (error) {
        console.warn('[control] 无法调用 chrome.tabs.create，将尝试直接打开页面', error);
        window.open('../popup/popup.html', '_blank');
      }
    });
  }

  function setupFeatureBoard() {
    const container = document.getElementById('feature-groups');
    if (!container) return;

    if (!registry) {
      container.innerHTML = `<div class=\"feature-empty-state\">功能注册表未初始化，请检查脚本引用顺序。</div>`;
      return;
    }

    const groups = registry.getGroups();
    if (!groups.length) {
      container.innerHTML = `<div class=\"feature-empty-state\">暂未配置功能模块，敬请期待。</div>`;
      return;
    }

    container.innerHTML = '';
    groups.forEach((group) => {
      const groupElement = document.createElement('section');
      groupElement.className = 'feature-group';
      groupElement.appendChild(renderGroupHeader(group));
      groupElement.appendChild(renderFeatureList(group));
      container.appendChild(groupElement);
    });
  }

  function renderGroupHeader(group) {
    const header = document.createElement('div');
    header.className = 'feature-group-header';

    const title = document.createElement('div');
    title.className = 'feature-group-title';

    const heading = document.createElement('h3');
    heading.textContent = group.meta?.title || '未命名分组';
    title.appendChild(heading);

    if (group.meta?.description) {
      const description = document.createElement('p');
      description.textContent = group.meta.description;
      title.appendChild(description);
    }

    header.appendChild(title);

    if (group.meta?.icon) {
      const icon = document.createElement('div');
      icon.textContent = group.meta.icon;
      icon.style.fontSize = '20px';
      header.appendChild(icon);
    }

    return header;
  }

  function renderFeatureList(group) {
    const list = document.createElement('div');
    list.className = 'feature-list';

    if (!group.features?.length) {
      const empty = document.createElement('div');
      empty.className = 'feature-empty-state';
      empty.textContent = '该分组下暂时没有功能。';
      list.appendChild(empty);
      return list;
    }

    group.features.forEach((feature) => {
      list.appendChild(renderFeatureCard(feature));
    });

    return list;
  }

  function renderFeatureCard(feature) {
    const card = document.createElement('article');
    card.className = 'feature-card';
    card.dataset.featureId = feature.id;

    card.appendChild(renderFeatureHeader(feature));

    if (feature.description) {
      const description = document.createElement('p');
      description.className = 'feature-description';
      description.textContent = feature.description;
      card.appendChild(description);
    }

    if (Array.isArray(feature.params) && feature.params.length > 0) {
      card.appendChild(renderFeatureParams(feature));
    }

    card.appendChild(renderFeatureActions(feature, card));

    const commandPreview = renderCommandPreview(feature, card);
    if (commandPreview) {
      card.appendChild(commandPreview);
    }

    card.appendChild(createStatusElement());

    if (typeof feature.renderResult === 'function') {
      ensureResultContainer(card);
    }

    // 如果 feature 有 onCardRendered 回调，在卡片渲染后调用
    if (typeof feature.onCardRendered === 'function') {
      // 使用 setTimeout 确保 DOM 已完全渲染
      setTimeout(() => {
        try {
          feature.onCardRendered({ card, feature });
        } catch (error) {
          console.warn(`[control] Feature ${feature.id} onCardRendered 执行失败:`, error);
        }
      }, 0);
    }

    return card;
  }

  function renderFeatureHeader(feature) {
    const header = document.createElement('div');
    header.className = 'feature-card-header';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'feature-name';
    name.textContent = feature.name || '未命名功能';
    info.appendChild(name);

    if (feature.summary) {
      const summary = document.createElement('div');
      summary.className = 'feature-summary';
      summary.textContent = feature.summary;
      info.appendChild(summary);
    }

    header.appendChild(info);

    if (Array.isArray(feature.tags) && feature.tags.length > 0) {
      const tags = document.createElement('div');
      tags.className = 'feature-tags';
      feature.tags.forEach((tag) => {
        const badge = document.createElement('span');
        badge.className = 'feature-tag';
        badge.textContent = tag;
        tags.appendChild(badge);
      });
      header.appendChild(tags);
    }

    return header;
  }

  function renderFeatureParams(feature) {
    const paramsContainer = document.createElement('div');
    paramsContainer.className = 'feature-params';

    feature.params.forEach((param) => {
      const paramElement = document.createElement('div');
      paramElement.className = 'feature-param';
      paramElement.dataset.paramKey = param.key;

      const label = document.createElement('label');
      label.textContent = param.label || param.key;
      if (param.tooltip) {
        label.title = param.tooltip;
      }

      if (param.type === 'checkbox') {
        paramElement.classList.add('feature-param-checkbox');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(param.defaultValue);
        input.dataset.paramKey = param.key;
        paramElement.appendChild(input);
        paramElement.appendChild(label);
      } else if (param.type === 'textarea') {
        paramElement.appendChild(label);
        const textarea = document.createElement('textarea');
        textarea.dataset.paramKey = param.key;
        textarea.placeholder = param.placeholder || '';
        textarea.value = param.defaultValue || '';
        textarea.rows = param.rows || 3;
        paramElement.appendChild(textarea);
      } else if (param.type === 'select' && Array.isArray(param.options)) {
        paramElement.appendChild(label);
        const select = document.createElement('select');
        select.dataset.paramKey = param.key;
        param.options.forEach((option) => {
          const optionElement = document.createElement('option');
          optionElement.value = option.value;
          optionElement.textContent = option.label || option.value;
          if (param.defaultValue !== undefined && option.value === param.defaultValue) {
            optionElement.selected = true;
          }
          select.appendChild(optionElement);
        });
        paramElement.appendChild(select);
      } else {
        paramElement.appendChild(label);
        const input = document.createElement('input');
        input.type = param.type === 'number' ? 'number' : param.type === 'url' ? 'url' : 'text';
        input.dataset.paramKey = param.key;
        input.placeholder = param.placeholder || '';
        if (param.defaultValue !== undefined) {
          input.value = param.defaultValue;
        }
        if (param.min !== undefined) input.min = param.min;
        if (param.max !== undefined) input.max = param.max;
        paramElement.appendChild(input);
      }

      paramsContainer.appendChild(paramElement);
    });

    return paramsContainer;
  }

  function renderFeatureActions(feature, card) {
    const actions = document.createElement('div');
    actions.className = 'feature-actions';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'feature-run-btn';
    runBtn.textContent = feature.runLabel || '执行功能';
    runBtn.addEventListener('click', () => handleRunFeature(feature, card, runBtn));
    actions.appendChild(runBtn);

    if (feature.previewUrl) {
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'feature-secondary-btn';
      previewBtn.textContent = '打开示例';
      previewBtn.addEventListener('click', () => openNewTab(feature.previewUrl));
      actions.appendChild(previewBtn);
    }

    if (typeof feature.renderActions === 'function') {
      const extra = feature.renderActions({ card });
      if (extra) {
        actions.appendChild(extra);
      }
    }

    return actions;
  }

  function renderCommandPreview(feature, card) {
    if (typeof feature.buildCommand !== 'function') {
      return null;
    }

    const commandElement = document.createElement('pre');
    commandElement.className = 'feature-command';
    commandElement.textContent = feature.buildCommand(collectParams(card));

    card.addEventListener('input', (event) => {
      if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) {
        return;
      }
      try {
        commandElement.textContent = feature.buildCommand(collectParams(card));
      } catch (error) {
        console.warn('[control] 构建命令失败', error);
      }
    });

    return commandElement;
  }

  function createStatusElement() {
    const status = document.createElement('div');
    status.className = 'feature-status';
    status.style.display = 'none';
    return status;
  }

  function updateStatus(card, message, tone = 'info') {
    const status = card.querySelector('.feature-status');
    if (!status) return;
    status.textContent = message;
    status.classList.remove('info', 'success', 'error');
    status.style.display = message ? 'flex' : 'none';
    if (message) {
      status.classList.add(tone);
    }
  }

  function collectParams(card) {
    const params = {};
    const inputs = card.querySelectorAll('[data-param-key]');
    inputs.forEach((input) => {
      const key = input.dataset.paramKey;
      if (!key) return;

      if (input instanceof HTMLInputElement) {
        if (input.type === 'checkbox') {
          params[key] = input.checked;
        } else if (input.type === 'number') {
          params[key] = input.value ? Number(input.value) : null;
        } else {
          params[key] = input.value.trim();
        }
      } else if (input instanceof HTMLTextAreaElement) {
        params[key] = input.value.trim();
      } else if (input instanceof HTMLSelectElement) {
        params[key] = input.value;
      }
    });
    return params;
  }

  async function handleRunFeature(feature, card, runBtn) {
    if (typeof feature.run !== 'function') {
      updateStatus(card, '该功能尚未配置执行逻辑。', 'error');
      return;
    }

    const params = collectParams(card);
    runBtn.disabled = true;
    updateStatus(card, '执行中，请稍候…', 'info');
    clearResult(card);

    const context = createExecutionContext(feature, card, runBtn);

    try {
      const result = await Promise.resolve(feature.run(context, params));
      if (result && typeof result === 'object' && result.message) {
        updateStatus(card, result.message, result.tone || 'success');
      } else {
        updateStatus(card, '已触发功能执行，后续结果请关注日志或消息面板。', 'success');
      }

      if (result?.data) {
        renderResult(feature, card, result.data, params);
      }
    } catch (error) {
      console.error(`[control] 执行功能 ${feature.id} 失败`, error);
      updateStatus(card, error.message || '功能执行失败，请检查控制台日志。', 'error');
    } finally {
      runBtn.disabled = false;
    }
  }

  function createExecutionContext(feature, card, runBtn) {
    return {
      feature,
      card,
      setBusy(isBusy) {
        runBtn.disabled = Boolean(isBusy);
      },
      notify(message, options = {}) {
        updateStatus(card, message, options.tone || 'info');
      },
      openTab: openNewTab,
      dispatchBackground(payload) {
        if (!chrome?.runtime?.sendMessage) {
          return Promise.reject(new Error('当前环境不支持 runtime 消息发送'));
        }
        return new Promise((resolve, reject) => {
          try {
            chrome.runtime.sendMessage(
              {
                type: 'control/feature-execute',
                featureId: feature.id,
                payload,
              },
              (response) => {
                const runtimeError = chrome.runtime.lastError;
                if (runtimeError) {
                  reject(runtimeError);
                } else {
                  resolve(response);
                }
              },
            );
          } catch (error) {
            reject(error);
          }
        });
      },
      ensureResultContainer() {
        return ensureResultContainer(card);
      },
      clearResult() {
        clearResult(card);
      },
    };
  }

  function openNewTab(url) {
    if (!url) return;
    try {
      if (chrome?.tabs?.create) {
        chrome.tabs.create({ url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.warn('[control] 打开新标签页失败', error);
      window.open(url, '_blank');
    }
  }

  function ensureResultContainer(card) {
    let container = card.querySelector('.feature-result');
    if (!container) {
      container = document.createElement('div');
      container.className = 'feature-result';
      card.appendChild(container);
    }
    return container;
  }

  function clearResult(card) {
    const container = card.querySelector('.feature-result');
    if (container) {
      container.innerHTML = '';
    }
  }

  function renderResult(feature, card, data, params) {
    if (typeof feature.renderResult === 'function') {
      try {
        feature.renderResult({ card, data, params, ensureResultContainer });
        return;
      } catch (error) {
        console.warn(`[control] 自定义结果渲染失败 (${feature.id})`, error);
      }
    }

    const container = ensureResultContainer(card);
    container.innerHTML = `<pre class="feature-result-raw">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();

