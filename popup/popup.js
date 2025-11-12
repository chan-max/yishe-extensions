const { createApp, ref, reactive, onMounted, onUnmounted } = Vue;

const QUICK_LINKS = [
  { name: '设计管理后台', description: '团队内部管理', url: 'https://1s.design' },
  { name: 'Yishe 官网', description: '产品与服务概览', url: 'https://www.yishe.net' },
  { name: 'Google', description: '搜索引擎', url: 'https://www.google.com' },
  { name: 'Bing', description: 'Microsoft 搜索', url: 'https://www.bing.com' },
];

createApp({
  setup() {
    const wsState = reactive({
      status: 'disconnected',
      endpoint: '',
      lastPingAt: null,
      lastPongAt: null,
      lastLatencyMs: null,
      retryCount: 0,
      lastError: null,
    });

    const isLoading = ref(true);
    let messageListener = null;

    const statusInfo = {
      connected: { text: '已连接', dotClass: 'connected' },
      connecting: { text: '连接中', dotClass: 'connecting' },
      reconnecting: { text: '重连中', dotClass: 'reconnecting' },
      disconnected: { text: '已断开', dotClass: 'disconnected' },
      error: { text: '连接失败', dotClass: 'error' },
    };

    const currentStatus = () => {
      return statusInfo[wsState.status] || statusInfo.disconnected;
    };

    const canReconnect = () => {
      const status = wsState.status;
      return status !== 'connecting' && status !== 'reconnecting';
    };

    const formatTimestamp = (value) => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    };

    const handleReconnect = () => {
      chrome.runtime.sendMessage({ action: 'reconnectWebsocket' }, (response) => {
        if (chrome.runtime.lastError) {
          wsState.status = 'error';
          wsState.lastError = chrome.runtime.lastError.message;
        } else if (!response || response.success !== true) {
          wsState.status = 'error';
          wsState.lastError = response?.error || '重新连接失败';
        }
      });
    };

    const openLink = (url) => {
      chrome.tabs.create({ url }, () => {
        window.close();
      });
    };

    const fetchWsStatus = () => {
      chrome.runtime.sendMessage({ action: 'getWebsocketStatus' }, (response) => {
        isLoading.value = false;
        if (chrome.runtime.lastError) {
          wsState.status = 'error';
          wsState.lastError = chrome.runtime.lastError.message;
          return;
        }
        if (response && response.success && response.data) {
          Object.assign(wsState, response.data);
        } else {
          wsState.status = 'error';
          wsState.lastError = response?.error || '无法获取连接状态';
        }
      });
    };

    onMounted(() => {
      fetchWsStatus();

      messageListener = (message) => {
        if (message && message.type === 'wsStatus:update') {
          Object.assign(wsState, message.payload);
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);
    });

    onUnmounted(() => {
      if (messageListener) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    });

    return {
      wsState,
      isLoading,
      QUICK_LINKS,
      currentStatus,
      canReconnect,
      formatTimestamp,
      handleReconnect,
      openLink,
    };
  },
  template: `
    <div class="popup-container">
      <header class="popup-header">
        <div class="header-title">WebSocket 状态</div>
        <div class="header-subtitle">浏览器插件实时连接</div>
      </header>

      <main class="popup-content">
        <section class="ws-status-card">
          <div v-if="isLoading" class="loading">状态加载中...</div>
          <template v-else>
            <div class="ws-status-header">
              <div class="ws-status-indicator">
                <span :class="['status-dot', currentStatus().dotClass]"></span>
                <span class="ws-status-label">{{ currentStatus().text }}</span>
              </div>
              <button 
                class="ws-reconnect-btn" 
                :disabled="!canReconnect()"
                @click="handleReconnect"
              >
                重新连接
              </button>
            </div>
            <div class="ws-status-endpoint" :title="wsState.endpoint || '未配置'">
              {{ wsState.endpoint || '未配置' }}
            </div>
            <div v-if="wsState.lastPingAt || wsState.lastPongAt || wsState.lastLatencyMs" class="ws-status-meta">
              <span v-if="wsState.lastPingAt">Ping: {{ formatTimestamp(wsState.lastPingAt) }}</span>
              <span v-if="wsState.lastPongAt">Pong: {{ formatTimestamp(wsState.lastPongAt) }}</span>
              <span v-if="wsState.lastLatencyMs">延迟: {{ wsState.lastLatencyMs }}ms</span>
            </div>
            <div v-if="wsState.lastError" class="ws-status-error">
              错误：{{ wsState.lastError }}
            </div>
          </template>
        </section>

        <section class="quick-links-card">
          <div class="section-header">
            <div class="section-title">快速跳转</div>
          </div>
          <ul class="quick-links-list">
            <li v-for="link in QUICK_LINKS" :key="link.url" class="quick-link-item">
              <button class="quick-link-button" @click="openLink(link.url)">
                <span class="quick-link-name">{{ link.name }}</span>
                <span class="quick-link-arrow">›</span>
              </button>
            </li>
          </ul>
        </section>
      </main>
    </div>
  `,
}).mount('#app');
