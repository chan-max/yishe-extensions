// popup.js: 弹窗逻辑

const QUICK_LINKS = [
  { name: '设计管理后台', description: '团队内部管理', url: 'https://1s.design' },
  { name: 'Yishe 官网', description: '产品与服务概览', url: 'https://www.yishe.net' },
  { name: 'Google', description: '搜索引擎', url: 'https://www.google.com' },
  { name: 'Bing', description: 'Microsoft 搜索', url: 'https://www.bing.com' },
];

document.addEventListener('DOMContentLoaded', () => {
  try {
    setupWebsocketStatus();
    setupQuickLinks();
  } catch (error) {
    console.error('[Core Popup] 初始化失败:', error);
  }
});

function setupWebsocketStatus() {
  const container = document.getElementById('wsStatus');
  if (!container) return;

  const render = (state) => renderWebsocketStatus(container, state);

  const messageListener = (message) => {
    if (message && message.type === 'wsStatus:update') {
      render(message.payload);
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
  window.addEventListener('unload', () => {
    chrome.runtime.onMessage.removeListener(messageListener);
  });

  chrome.runtime.sendMessage({ action: 'getWebsocketStatus' }, (response) => {
    if (chrome.runtime.lastError) {
      render({ status: 'error', lastError: chrome.runtime.lastError.message });
      return;
    }
    if (response && response.success && response.data) {
      render(response.data);
    } else {
      render({ status: 'error', lastError: response?.error || '无法获取连接状态' });
    }
  });
}

function setupQuickLinks() {
  const listEl = document.getElementById('quickLinksList');
  if (!listEl) return;

  listEl.innerHTML = '';

  QUICK_LINKS.forEach((link) => {
    const item = document.createElement('li');
    item.className = 'quick-link-item';

    const button = document.createElement('button');
    button.className = 'quick-link-button';
    button.type = 'button';
    button.dataset.url = link.url;
    button.innerHTML = `
      <span class="quick-link-name">${escapeHtml(link.name)}</span>
      <span class="quick-link-desc">${escapeHtml(link.description)}</span>
      <span class="quick-link-arrow">›</span>
    `;

    button.addEventListener('click', () => {
      chrome.tabs.create({ url: link.url }, () => {
        window.close();
      });
    });

    item.appendChild(button);
    listEl.appendChild(item);
  });
}

function renderWebsocketStatus(container, state) {
  if (!container) return;

  if (!state) {
    container.innerHTML = '<span class="loading">暂无状态</span>';
    return;
  }

  const info = getStatusInfo(state.status);
  const endpoint = state.endpoint || '未配置';
  const allowManualReconnect = !['connecting', 'reconnecting'].includes(info.key);
  const metaHtml = buildMetaHtml(state);
  const errorHtml = state.lastError
    ? `<div class="ws-status-error">错误：${escapeHtml(String(state.lastError))}</div>`
    : '';

  container.innerHTML = `
    <div class="ws-status-header">
      <div class="ws-status-indicator">
        <span class="status-dot ${info.dotClass}"></span>
        <span class="ws-status-label">${info.text}</span>
      </div>
      <button class="ws-reconnect-btn"${allowManualReconnect ? '' : ' disabled'}>重新连接</button>
    </div>
    <div class="ws-status-endpoint" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</div>
    ${metaHtml}
    ${errorHtml}
  `;

  const reconnectBtn = container.querySelector('.ws-reconnect-btn');
  if (reconnectBtn && allowManualReconnect) {
    reconnectBtn.addEventListener('click', () => {
      reconnectBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'reconnectWebsocket' }, (response) => {
        if (chrome.runtime.lastError) {
          renderWebsocketStatus(container, {
            ...state,
            status: 'error',
            lastError: chrome.runtime.lastError.message,
          });
          return;
        }
        if (!response || response.success !== true) {
          renderWebsocketStatus(container, {
            ...state,
            status: 'error',
            lastError: response?.error || '重新连接失败',
          });
        }
      });
    });
  }
}

function buildMetaHtml(state) {
  const meta = [];
  if (state.lastPingAt) {
    meta.push(`上次 Ping: ${formatTimestamp(state.lastPingAt)}`);
  }
  if (state.lastPongAt) {
    meta.push(`上次 Pong: ${formatTimestamp(state.lastPongAt)}`);
  }
  if (typeof state.lastLatencyMs === 'number') {
    meta.push(`延迟: ${state.lastLatencyMs}ms`);
  }
  if (state.retryCount && state.retryCount > 0) {
    meta.push(`重连次数: ${state.retryCount}`);
  }

  if (!meta.length) {
    return '';
  }

  return `<div class="ws-status-meta">${meta
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join('')}</div>`;
}

function getStatusInfo(status) {
  const map = {
    connected: { key: 'connected', text: '已连接', dotClass: 'connected' },
    connecting: { key: 'connecting', text: '连接中', dotClass: 'connecting' },
    reconnecting: { key: 'reconnecting', text: '重连中', dotClass: 'reconnecting' },
    disconnected: { key: 'disconnected', text: '已断开', dotClass: 'disconnected' },
    error: { key: 'error', text: '连接失败', dotClass: 'error' },
  };

  return map[status] || { key: 'unknown', text: '未知状态', dotClass: 'disconnected' };
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
