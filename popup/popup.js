// 快速链接配置
const QUICK_LINKS = [
  { name: '设计管理后台', url: 'https://1s.design' },
  { name: 'Yishe 官网', url: 'https://www.yishe.net' },
  { name: 'Google', url: 'https://www.google.com' },
  { name: 'Bing', url: 'https://www.bing.com' },
];

// WebSocket 状态
const wsState = {
  status: 'disconnected',
  endpoint: '',
  lastPingAt: null,
  lastPongAt: null,
  lastLatencyMs: null,
  retryCount: 0,
  lastError: null,
};

// 状态信息映射
const statusInfo = {
  connected: { text: '已连接', dotClass: 'connected' },
  connecting: { text: '连接中', dotClass: 'connecting' },
  reconnecting: { text: '重连中', dotClass: 'reconnecting' },
  disconnected: { text: '已断开', dotClass: 'disconnected' },
  error: { text: '连接失败', dotClass: 'error' },
};

// DOM 元素
const elements = {
  loading: document.getElementById('loading'),
  wsStatusContent: document.getElementById('ws-status-content'),
  statusDot: document.getElementById('status-dot'),
  wsStatusLabel: document.getElementById('ws-status-label'),
  reconnectBtn: document.getElementById('reconnect-btn'),
  wsStatusEndpoint: document.getElementById('ws-status-endpoint'),
  wsStatusMeta: document.getElementById('ws-status-meta'),
  pingTime: document.getElementById('ping-time'),
  pongTime: document.getElementById('pong-time'),
  latency: document.getElementById('latency'),
  wsStatusError: document.getElementById('ws-status-error'),
  errorText: document.getElementById('error-text'),
  quickLinksList: document.getElementById('quick-links-list'),
};

// 格式化时间戳
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

// 更新 UI 状态
function updateUI() {
  const status = statusInfo[wsState.status] || statusInfo.disconnected;
  
  // 更新状态指示器
  elements.statusDot.className = `status-dot ${status.dotClass}`;
  elements.wsStatusLabel.textContent = status.text;
  
  // 更新端点
  elements.wsStatusEndpoint.textContent = wsState.endpoint || '未配置';
  elements.wsStatusEndpoint.title = wsState.endpoint || '未配置';
  
  // 更新元数据
  const hasMeta = wsState.lastPingAt || wsState.lastPongAt || wsState.lastLatencyMs;
  elements.wsStatusMeta.style.display = hasMeta ? 'flex' : 'none';
  
  if (wsState.lastPingAt) {
    elements.pingTime.textContent = `Ping: ${formatTimestamp(wsState.lastPingAt)}`;
  } else {
    elements.pingTime.textContent = '';
  }
  
  if (wsState.lastPongAt) {
    elements.pongTime.textContent = `Pong: ${formatTimestamp(wsState.lastPongAt)}`;
  } else {
    elements.pongTime.textContent = '';
  }
  
  if (wsState.lastLatencyMs !== null) {
    elements.latency.textContent = `延迟: ${wsState.lastLatencyMs}ms`;
  } else {
    elements.latency.textContent = '';
  }
  
  // 更新错误信息
  if (wsState.lastError) {
    elements.errorText.textContent = wsState.lastError;
    elements.wsStatusError.style.display = 'block';
  } else {
    elements.wsStatusError.style.display = 'none';
  }
  
  // 更新重新连接按钮
  const canReconnect = wsState.status !== 'connecting' && wsState.status !== 'reconnecting';
  elements.reconnectBtn.disabled = !canReconnect;
}

// 获取 WebSocket 状态
function fetchWsStatus() {
  chrome.runtime.sendMessage({ action: 'getWebsocketStatus' }, (response) => {
    elements.loading.style.display = 'none';
    elements.wsStatusContent.style.display = 'block';
    
    if (chrome.runtime.lastError) {
      wsState.status = 'error';
      wsState.lastError = chrome.runtime.lastError.message;
      updateUI();
      return;
    }
    
    if (response && response.success && response.data) {
      Object.assign(wsState, response.data);
      updateUI();
    } else {
      wsState.status = 'error';
      wsState.lastError = response?.error || '无法获取连接状态';
      updateUI();
    }
  });
}

// 重新连接
function handleReconnect() {
  chrome.runtime.sendMessage({ action: 'reconnectWebsocket' }, (response) => {
    if (chrome.runtime.lastError) {
      wsState.status = 'error';
      wsState.lastError = chrome.runtime.lastError.message;
      updateUI();
    } else if (!response || response.success !== true) {
      wsState.status = 'error';
      wsState.lastError = response?.error || '重新连接失败';
      updateUI();
    } else {
      // 重新获取状态
      setTimeout(fetchWsStatus, 500);
    }
  });
}

// 打开链接
function openLink(url) {
  chrome.tabs.create({ url }, () => {
    window.close();
  });
}

// 初始化快速链接
function initQuickLinks() {
  elements.quickLinksList.innerHTML = QUICK_LINKS.map(link => `
    <li class="quick-link-item">
      <button class="quick-link-button" data-url="${link.url}">
        <span class="quick-link-name">${link.name}</span>
        <span class="quick-link-arrow">›</span>
      </button>
    </li>
  `).join('');
  
  // 绑定点击事件
  elements.quickLinksList.querySelectorAll('.quick-link-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-url');
      if (url) {
        openLink(url);
      }
    });
  });
}

// 监听 WebSocket 状态更新
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'wsStatus:update') {
      Object.assign(wsState, message.payload);
      updateUI();
    }
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initQuickLinks();
  setupMessageListener();
  fetchWsStatus();
  
  // 绑定重新连接按钮
  elements.reconnectBtn.addEventListener('click', handleReconnect);
});
