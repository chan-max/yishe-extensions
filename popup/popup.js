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
  adminMessagesList: document.getElementById('admin-messages-list'),
  adminMessagesEmpty: document.getElementById('admin-messages-empty'),
  clearMessagesBtn: document.getElementById('clear-messages-btn'),
  openInTabBtn: document.getElementById('open-in-tab-btn'),
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

// 从 storage 读取 WebSocket 状态（后备方案）
function loadWsStatusFromStorage() {
  chrome.storage.local.get(['wsStatus'], (result) => {
    if (!chrome.runtime.lastError && result.wsStatus) {
      console.log('[popup] loadWsStatusFromStorage: 从 storage 读取到状态:', result.wsStatus);
      Object.assign(wsState, result.wsStatus);
      updateUI();
    }
  });
}

// 获取 WebSocket 状态
function fetchWsStatus() {
  console.log('[popup] fetchWsStatus: 开始获取状态');
  
  // 先从 storage 读取状态（快速显示）
  loadWsStatusFromStorage();
  
  // 然后从 service worker 获取最新状态
  chrome.runtime.sendMessage({ action: 'getWebsocketStatus' }, (response) => {
    console.log('[popup] fetchWsStatus: 收到响应:', response);
    console.log('[popup] fetchWsStatus: runtime.lastError:', chrome.runtime.lastError);
    
    elements.loading.style.display = 'none';
    elements.wsStatusContent.style.display = 'block';
    
    if (chrome.runtime.lastError) {
      console.error('[popup] fetchWsStatus: 错误:', chrome.runtime.lastError.message);
      // 如果有 storage 中的数据，就不显示错误
      if (!wsState.endpoint || wsState.status === 'disconnected') {
      wsState.status = 'error';
      wsState.lastError = chrome.runtime.lastError.message;
      updateUI();
      }
      return;
    }
    
    if (response && response.success && response.data) {
      console.log('[popup] fetchWsStatus: 更新状态:', response.data);
      Object.assign(wsState, response.data);
      updateUI();
    } else {
      console.error('[popup] fetchWsStatus: 响应无效:', response);
      // 如果有 storage 中的数据，就不显示错误
      if (!wsState.endpoint || wsState.status === 'disconnected') {
      wsState.status = 'error';
      wsState.lastError = response?.error || '无法获取连接状态';
      updateUI();
      }
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

// 格式化消息内容
function formatMessageData(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    if (data.message) return data.message;
    if (data.text) return data.text;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
    }

// 加载并显示管理员消息
function loadAdminMessages() {
  console.log('[popup] loadAdminMessages: 开始加载消息');
  chrome.storage.local.get(['adminMessages'], (result) => {
    console.log('[popup] loadAdminMessages: 从 storage 读取结果:', result);
    const messages = result.adminMessages || [];
    console.log('[popup] loadAdminMessages: 消息数量:', messages.length);
    if (messages.length > 0) {
      console.log('[popup] loadAdminMessages: 第一条消息:', messages[0]);
    }
    renderAdminMessages(messages);
  });
}

// 渲染管理员消息
function renderAdminMessages(messages) {
  console.log('[popup] renderAdminMessages: 开始渲染，消息数量:', messages.length);
  
  if (!elements.adminMessagesList || !elements.adminMessagesEmpty) {
    console.error('[popup] renderAdminMessages: DOM 元素不存在');
    return;
  }
  
  if (messages.length === 0) {
    console.log('[popup] renderAdminMessages: 无消息，显示空状态');
    elements.adminMessagesList.style.display = 'none';
    elements.adminMessagesEmpty.style.display = 'block';
    return;
  }

  console.log('[popup] renderAdminMessages: 有消息，开始渲染');
  elements.adminMessagesList.style.display = 'block';
  elements.adminMessagesEmpty.style.display = 'none';

  const messagesToRender = messages.slice(0, 10);
  console.log('[popup] renderAdminMessages: 将渲染的消息数量:', messagesToRender.length);
  
  const html = messagesToRender.map((msg, index) => {
    console.log(`[popup] renderAdminMessages: 处理消息 ${index}:`, msg);
    const date = new Date(msg.timestamp);
    const timeStr = date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const messageText = formatMessageData(msg.data);
    console.log(`[popup] renderAdminMessages: 消息 ${index} 格式化后:`, messageText);
    
    return `
      <div class="admin-message-item">
        <div class="admin-message-header">
          <span class="admin-message-time">${timeStr}</span>
        </div>
        <div class="admin-message-content">${escapeHtml(messageText)}</div>
      </div>
    `;
  }).join('');
  
  console.log('[popup] renderAdminMessages: 生成的 HTML 长度:', html.length);
  elements.adminMessagesList.innerHTML = html;
  console.log('[popup] renderAdminMessages: 渲染完成');
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 清空消息
function clearAdminMessages() {
  chrome.storage.local.set({ adminMessages: [] }, () => {
    if (chrome.runtime.lastError) {
      console.error('清空消息失败:', chrome.runtime.lastError);
    } else {
      loadAdminMessages();
    }
  });
}

// 监听 WebSocket 状态更新和管理员消息
function setupMessageListener() {
  console.log('[popup] setupMessageListener: 设置消息监听器');
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[popup] onMessage: 收到消息:', message);
    console.log('[popup] onMessage: 消息类型:', message?.type);
    
    if (message && message.type === 'wsStatus:update') {
      console.log('[popup] onMessage: 处理 wsStatus:update');
      console.log('[popup] onMessage: 状态数据:', message.payload);
      if (message.payload) {
      Object.assign(wsState, message.payload);
      updateUI();
        console.log('[popup] onMessage: 状态已更新');
      }
      // 发送响应确认收到消息
      if (sendResponse) {
        sendResponse({ success: true });
      }
    } else if (message && message.type === 'adminMessage:received') {
      console.log('[popup] onMessage: 收到 adminMessage:received 通知');
      console.log('[popup] onMessage: 消息载荷:', message.payload);
      // 收到新消息，重新加载消息列表
      loadAdminMessages();
      if (sendResponse) {
      sendResponse({ success: true });
      }
    } else {
      console.log('[popup] onMessage: 未知消息类型，忽略');
    }
    
    return true; // 保持消息通道开放（异步响应）
  });
  console.log('[popup] setupMessageListener: 消息监听器设置完成');
}

// 加载用户信息
async function loadUserInfo() {
  try {
    // 动态加载 API 工具
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('utils/api.js');
    document.head.appendChild(script);
    
    await new Promise((resolve) => {
      script.onload = resolve;
      setTimeout(resolve, 100);
    });
    
    const ApiUtils = window.ApiUtils;
    if (!ApiUtils) {
      console.error('[popup] ApiUtils 未加载');
      return;
    }
    
    const token = await ApiUtils.getToken();
    const userInfo = await ApiUtils.getUserInfo();
    
    const userInfoSection = document.getElementById('user-info-section');
    const loginPrompt = document.getElementById('login-prompt');
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    const userRole = document.getElementById('user-role');
    const logoutBtn = document.getElementById('logout-btn');
    const loginBtn = document.getElementById('login-btn');
    
    if (token && userInfo) {
      // 已登录，显示用户信息
      if (userInfoSection) userInfoSection.style.display = 'block';
      if (loginPrompt) loginPrompt.style.display = 'none';
      
      if (userName && userInfo.username) {
        userName.textContent = userInfo.username;
      }
      if (userAvatar && userInfo.username) {
        userAvatar.textContent = userInfo.username.charAt(0).toUpperCase();
      }
      if (userRole && userInfo.nickname) {
        userRole.textContent = userInfo.nickname;
      } else if (userRole) {
        userRole.textContent = '已登录';
      }
      
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          try {
            await ApiUtils.logout();
            // 刷新页面显示
            loadUserInfo();
          } catch (error) {
            console.error('[popup] 登出失败:', error);
          }
        });
      }
    } else {
      // 未登录，显示登录提示
      if (userInfoSection) userInfoSection.style.display = 'none';
      if (loginPrompt) loginPrompt.style.display = 'block';
      
      if (loginBtn) {
        loginBtn.addEventListener('click', () => {
          const loginUrl = chrome.runtime.getURL('pages/login.html');
          chrome.tabs.create({ url: loginUrl });
          try {
            window.close();
          } catch {}
        });
      }
    }
  } catch (error) {
    console.error('[popup] 加载用户信息失败:', error);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  console.log('[popup] DOMContentLoaded: 开始初始化');
  console.log('[popup] DOMContentLoaded: 检查 DOM 元素:', {
    adminMessagesList: !!elements.adminMessagesList,
    adminMessagesEmpty: !!elements.adminMessagesEmpty,
    clearMessagesBtn: !!elements.clearMessagesBtn,
  });
  
  setupMessageListener();
  fetchWsStatus();
  loadUserInfo();

  // 仅当存在消息容器时才加载消息
  if (elements.adminMessagesList && elements.adminMessagesEmpty) {
    loadAdminMessages();
  }
  
  // 绑定重新连接按钮
  if (elements.reconnectBtn) {
    elements.reconnectBtn.addEventListener('click', handleReconnect);
  }
  
  // 绑定清空消息按钮
  if (elements.clearMessagesBtn) {
    elements.clearMessagesBtn.addEventListener('click', clearAdminMessages);
  }

  // 在新标签页打开
  if (elements.openInTabBtn) {
    elements.openInTabBtn.addEventListener('click', () => {
      const url = chrome.runtime.getURL('pages/control.html');
      chrome.tabs.create({ url });
      try {
        window.close();
      } catch {}
    });
  }
  
  console.log('[popup] DOMContentLoaded: 初始化完成');
});
