// =============================================================
// service-worker.js: 后台 Service Worker 入口
// -------------------------------------------------------------
// 职责概览（记住这 4 点就够了）：
// 1）加载依赖（socket.io + handlers）
// 2）管理「服务端 WebSocket」连接状态（1s.design 后端）
// 3）管理「本地客户端 WebSocket」连接状态（本地 Electron 客户端）
// 4）处理全局事件（安装、启动、存储变更、右键菜单等）
// =============================================================

/* global io */

// 简单的日志函数（在 log 函数定义之前使用）
function simpleLog(...args) {
  console.log('[Core][WS]', ...args);
}

// =============================================================
// 一、依赖加载 & 全局配置
// =============================================================

// 脚本加载状态（仅用于调试，不影响业务逻辑）
let scriptsLoaded = {
  socketio: false,
  error: null
};

// 加载依赖库（不抛出错误，避免 Service Worker 崩溃）
(function() {
  try {
    // 1. 加载 socket.io 客户端（用于和服务端、本地客户端建立 WebSocket 连接）
    try {
      importScripts('../libs/socket.io.min.js');
      scriptsLoaded.socketio = true;
      simpleLog('Socket.IO 已加载');
    } catch (e) {
      console.error('[Core][WS] Socket.IO 加载失败:', e);
      scriptsLoaded.error = (scriptsLoaded.error || '') + ' Socket.IO 加载失败: ' + e.message;
    }
    
    // 2. 加载消息处理器（目前仅保留基础工具和路由器）
    try {
      importScripts('handlers/base.js');
      importScripts('handlers/index.js');
      simpleLog('消息处理器已加载');
    } catch (e) {
      console.error('[Core][WS] 消息处理器加载失败:', e);
      scriptsLoaded.error = (scriptsLoaded.error || '') + ' 消息处理器加载失败: ' + e.message;
    }
  } catch (error) {
    console.error('[Core][WS] 脚本加载过程出现异常:', error);
    scriptsLoaded.error = '脚本加载异常: ' + error.message;
  }
})();

// 后端 WebSocket 默认地址（生产 / 开发）
const DEFAULT_PROD_WS_ENDPOINT = 'https://1s.design:1520/ws';
const DEFAULT_DEV_WS_ENDPOINT = 'http://localhost:1520/ws';
const DEFAULT_WS_ENDPOINT = DEFAULT_PROD_WS_ENDPOINT;
// 本地 Electron 客户端固定地址（不包含路径，路径由 Socket.IO 配置指定）
const CLIENT_WS_ENDPOINT = 'http://localhost:1519';
const STORAGE_ENDPOINT_KEY = 'wsEndpoint';
const STORAGE_ENDPOINT_CUSTOM_KEY = 'wsEndpointCustom';
const STORAGE_DEV_MODE_KEY = 'devMode';
const STORAGE_DEV_WS_BASE_URL_KEY = 'devWsBaseUrl';
const STORAGE_WS_BASE_URL_KEY = 'wsBaseUrl';
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 10000;

const SERVER_UPLOAD_URL = 'https://1s.design:1520/api/crawler/material/add';
const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449';
const textEncoder = new TextEncoder();

const CLIENT_SOURCE = 'yishe-extension';
const CLIENT_INFO_QUERY_KEY = 'clientInfo';
const CLIENT_SOURCE_QUERY_KEY = 'clientSource';
const CLIENT_VERSION_QUERY_KEY = 'extensionVersion';
const CLIENT_ID_QUERY_KEY = 'clientId';
const LOCATION_CACHE_KEY = 'wsLocationCache';
const LOCATION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const LOCATION_ENDPOINT = 'https://ipapi.co/json/';
const AUTH_TOKEN_KEY = 'accessToken';
const AUTH_USER_INFO_KEY = 'userInfo';

// 客户端元信息（浏览器、系统、扩展版本等）
let clientMetadata = null;
let clientMetadataPromise = null;
let locationLookupStarted = false;

// 当前服务端 WebSocket 端点
let wsEndpoint = DEFAULT_WS_ENDPOINT;
let socket = null;
let heartbeatTimer = null;
let heartbeatTimeoutTimer = null;
let lastPingTimestampMs = null;
let websocketInitPromise = null;

// 本地客户端（Electron）连接相关变量
let clientSocket = null;
let clientHeartbeatTimer = null;
let clientHeartbeatTimeoutTimer = null;
let clientLastPingTimestampMs = null;
let clientWebsocketInitPromise = null;

// 对「服务端 WebSocket」的最新状态快照
const wsState = {
  status: 'disconnected',
  endpoint: wsEndpoint,
  connectedAt: null,
  lastPingAt: null,
  lastPongAt: null,
  lastLatencyMs: null,
  lastError: null,
  retryCount: 0,
  lastPayload: null,
  clientInfo: null,
};

// 对「本地客户端 WebSocket」的最新状态快照
const clientWsState = {
  status: 'disconnected',
  endpoint: CLIENT_WS_ENDPOINT,
  connectedAt: null,
  lastPingAt: null,
  lastPongAt: null,
  lastLatencyMs: null,
  lastError: null,
  retryCount: 0,
  lastPayload: null,
};

// 统一日志输出，方便过滤
function log(...args) {
  console.log('[Core][WS]', ...args);
}

// =============================================================
// 二、错误序列化 & 通用工具
// =============================================================

function serializeError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
}

// guessExtension 和 uploadMaterialToServer 已迁移到 handlers/base.js 和 handlers/pinterest.js
// 以下函数保留用于兼容性，但建议使用 handlers 中的实现

function guessExtension(url, contentType) {
  // 如果有 handlers 可用，使用 handlers 中的实现
  if (typeof self !== 'undefined' && self.MessageHandlers?.Base?.guessExtension) {
    return self.MessageHandlers.Base.guessExtension(url, contentType);
  }
  // Fallback 实现
  const fromUrl = (() => {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(avif|webp|png|jpg|jpeg|gif|svg)$/i);
      return match ? `.${match[1].toLowerCase()}` : '';
    } catch (_) {
      return '';
    }
  })();
  if (fromUrl) return fromUrl;
  if (!contentType) return '.jpg';
  if (contentType.includes('image/jpeg')) return '.jpg';
  if (contentType.includes('image/png')) return '.png';
  if (contentType.includes('image/webp')) return '.webp';
  if (contentType.includes('image/gif')) return '.gif';
  if (contentType.includes('image/svg')) return '.svg';
  if (contentType.includes('image/avif')) return '.avif';
  return '.jpg';
}

async function uploadMaterialToServer(payload) {
  const response = await fetch(SERVER_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch((error) => {
    throw new Error(`保存到服务器失败: ${serializeError(error)}`);
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`服务器返回异常 (${response.status}): ${text.slice(0, 120)}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`解析服务器响应失败: ${serializeError(error)}`);
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
    log('发送飞书通知失败:', serializeError(error));
  });
}

// processPinterestUploadCommand 已迁移到 handlers/pinterest.js

async function handleControlFeatureExecute(request) {
  const featureId = request?.featureId;
  const payload = request?.payload || {};

  // Pinterest 功能已迁移到 handlers，这里保留定时任务接口的兼容性
  if (featureId === 'pinterest-scraper') {
    if (payload.command === 'pinterest/schedule') {
      return await handlePinterestSchedule(payload);
    }
    // 其他 Pinterest 命令已通过消息路由器处理
    return { success: false, error: '未知的 Pinterest 功能指令' };
  }

  return { success: false, error: '未识别的功能组件' };
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(undefined);
      }
    });
  });
}

async function hasAuthenticatedSession() {
  const authState = await storageGet([AUTH_TOKEN_KEY, AUTH_USER_INFO_KEY]);
  return Boolean(authState[AUTH_TOKEN_KEY] && authState[AUTH_USER_INFO_KEY]);
}

async function ensureClientIdentifier() {
  try {
    const { clientId } = await storageGet([CLIENT_ID_QUERY_KEY]);
    if (clientId) {
      return clientId;
    }
    const generatedId = (self.crypto && self.crypto.randomUUID)
      ? self.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await storageSet({ [CLIENT_ID_QUERY_KEY]: generatedId });
    return generatedId;
  } catch (error) {
    log('生成 clientId 失败，使用临时 ID', serializeError(error));
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function getPlatformInfoSafe() {
  return new Promise((resolve) => {
    if (!chrome.runtime || !chrome.runtime.getPlatformInfo) {
      resolve(undefined);
      return;
    }
    chrome.runtime.getPlatformInfo((info) => {
      if (chrome.runtime.lastError) {
        log('获取平台信息失败:', chrome.runtime.lastError.message);
        resolve(undefined);
      } else {
        resolve(info);
      }
    });
  });
}

function parseBrowserInfo(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') {
    return undefined;
  }

  const browserMatchers = [
    { name: 'Edge', regex: /Edg\/([\d.]+)/ },
    { name: 'Chrome', regex: /Chrome\/([\d.]+)/ },
    { name: 'Firefox', regex: /Firefox\/([\d.]+)/ },
    { name: 'Safari', regex: /Version\/([\d.]+).*Safari/ },
    { name: 'Opera', regex: /OPR\/([\d.]+)/ }
  ];

  for (const matcher of browserMatchers) {
    const match = userAgent.match(matcher.regex);
    if (match) {
      return {
        name: matcher.name,
        version: match[1]
      };
    }
  }

  return {
    name: 'Unknown',
    version: undefined
  };
}

function parseOsInfo(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') {
    return undefined;
  }

  const osMatchers = [
    { name: 'Windows', regex: /Windows NT ([\d.]+)/ },
    { name: 'macOS', regex: /Mac OS X ([\d_]+)/ },
    { name: 'iOS', regex: /iPhone OS ([\d_]+)/ },
    { name: 'Android', regex: /Android ([\d.]+)/ },
    { name: 'Linux', regex: /Linux/ }
  ];

  for (const matcher of osMatchers) {
    const match = userAgent.match(matcher.regex);
    if (match) {
      return {
        name: matcher.name,
        version: match[1]?.replace(/_/g, '.')
      };
    }
  }

  return {
    name: 'Unknown'
  };
}

async function ensureClientMetadata() {
  if (clientMetadata) {
    return clientMetadata;
  }
  if (clientMetadataPromise) {
    return clientMetadataPromise;
  }

  clientMetadataPromise = (async () => {
    const [platformInfo, clientId] = await Promise.all([
      getPlatformInfoSafe(),
      ensureClientIdentifier()
    ]);

    const manifest = chrome.runtime?.getManifest?.() || {};
    const userAgent = self.navigator?.userAgent || undefined;
    const browser = parseBrowserInfo(userAgent);
    const osInfo = parseOsInfo(userAgent);
    const language = self.navigator?.language || undefined;
    const uiLanguage = chrome.i18n?.getUILanguage?.() || undefined;
    const timeZone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (error) {
        log('获取时区失败:', serializeError(error));
        return undefined;
      }
    })();

    const metadata = {
      clientId,
      timestamp: new Date().toISOString(),
      extension: {
        name: manifest.name,
        version: manifest.version,
        manifestVersion: manifest.manifest_version,
      },
      browser,
      os: osInfo,
      platform: platformInfo,
      language,
      uiLanguage,
      timeZone,
      userAgent,
      device: {
        memory: self.navigator?.deviceMemory,
        hardwareConcurrency: self.navigator?.hardwareConcurrency,
      },
    };

    clientMetadata = metadata;
    updateWsState({ clientInfo: cloneMetadata(metadata) });
    return metadata;
  })()
    .catch((error) => {
      log('收集客户端信息失败:', serializeError(error));
      return undefined;
    })
    .finally(() => {
      clientMetadataPromise = null;
    });

  return clientMetadataPromise;
}

function cloneMetadata(metadata) {
  if (!metadata) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(metadata));
  } catch (error) {
    log('克隆客户端信息失败:', serializeError(error));
    return null;
  }
}

function mergeMetadataWithAuth(metadata, token, userInfo) {
  if (!metadata) {
    return metadata;
  }

  const merged = { ...metadata };

  if (token) {
    merged.auth = {
      ...(merged.auth || {}),
      token,
    };
  } else if (merged.auth) {
    delete merged.auth.token;
    if (Object.keys(merged.auth).length === 0) {
      delete merged.auth;
    }
  }

  if (userInfo) {
    merged.user = userInfo;
  } else if (merged.user) {
    delete merged.user;
  }

  return merged;
}

function buildConnectionQuery(metadata, token) {
  const query = {
    [CLIENT_SOURCE_QUERY_KEY]: CLIENT_SOURCE,
  };

  if (metadata?.extension?.version) {
    query[CLIENT_VERSION_QUERY_KEY] = metadata.extension.version;
  }
  if (metadata?.clientId) {
    query[CLIENT_ID_QUERY_KEY] = metadata.clientId;
  }
  if (token) {
    query.token = token;
  }
  if (metadata) {
    try {
      query[CLIENT_INFO_QUERY_KEY] = JSON.stringify(metadata);
    } catch (error) {
      log('序列化客户端信息失败:', serializeError(error));
    }
  }

  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '');

  return entries.reduce((acc, [key, value]) => {
    acc[key] = String(value);
    return acc;
  }, {});
}

function emitClientInfo(extraPayload) {
  if (!clientMetadata || !socket || !socket.connected) {
    return;
  }
  const payload = extraPayload ? { ...clientMetadata, ...extraPayload } : clientMetadata;
  try {
    socket.emit('client-info', payload);
  } catch (error) {
    log('发送客户端信息失败:', serializeError(error));
  }
}

async function prefetchLocationInfo() {
  if (locationLookupStarted) {
    return;
  }
  locationLookupStarted = true;

  try {
    const location = await ensureLocationInfo();
    if (location) {
      clientMetadata = {
        ...(clientMetadata || {}),
        location,
      };
      updateWsState({ clientInfo: cloneMetadata(clientMetadata) });
      emitClientInfo();
    }
  } catch (error) {
    log('获取位置信息失败:', serializeError(error));
  }
}

async function ensureLocationInfo() {
  try {
    const cache = await storageGet([LOCATION_CACHE_KEY]);
    const cachedEntry = cache?.[LOCATION_CACHE_KEY];
    const now = Date.now();
    if (cachedEntry && cachedEntry.timestamp && now - cachedEntry.timestamp < LOCATION_CACHE_TTL) {
      return cachedEntry.location;
    }

    const location = await fetchClientLocation();
    if (location) {
      await storageSet({
        [LOCATION_CACHE_KEY]: {
          timestamp: now,
          location,
        },
      }).catch((error) => {
        log('缓存位置信息失败:', serializeError(error));
      });
    }
    return location;
  } catch (error) {
    log('ensureLocationInfo 出错:', serializeError(error));
    return undefined;
  }
}

async function fetchClientLocation() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(LOCATION_ENDPOINT, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data) {
      return undefined;
    }

    const {
      ip,
      city,
      region,
      country_name: countryName,
      country,
      latitude,
      longitude,
      org,
      timezone,
    } = data;

    return {
      ip,
      city,
      region,
      country: countryName || country,
      latitude,
      longitude,
      org,
      timeZone: timezone,
      source: LOCATION_ENDPOINT,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('请求位置信息超时');
    } else {
      log('请求位置信息失败:', serializeError(error));
    }
    return undefined;
  }
}

function broadcastWsState() {
  const snapshot = { ...wsState };

  chrome.storage.local.set({ wsStatus: snapshot }, () => {
    if (chrome.runtime.lastError) {
      log('存储 WebSocket 状态失败:', chrome.runtime.lastError.message);
    }
  });

  chrome.runtime.sendMessage(
    { type: 'wsStatus:update', payload: snapshot },
    () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes('Receiving end does not exist.')) {
        log('广播 WebSocket 状态失败:', err.message);
      }
    }
  );
}

function broadcastClientWsState() {
  const snapshot = { ...clientWsState };

  chrome.storage.local.set({ clientWsStatus: snapshot }, () => {
    if (chrome.runtime.lastError) {
      log('存储客户端 WebSocket 状态失败:', chrome.runtime.lastError.message);
    }
  });

  chrome.runtime.sendMessage(
    { type: 'clientWsStatus:update', payload: snapshot },
    () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes('Receiving end does not exist.')) {
        log('广播客户端 WebSocket 状态失败:', err.message);
      }
    }
  );
}

function updateWsState(patch) {
  Object.assign(wsState, patch, { endpoint: wsEndpoint });
  broadcastWsState();
}

function cleanupSocket() {
  if (socket) {
    try {
      socket.removeAllListeners();
    } catch (error) {
      // ignore
    }
    try {
      socket.disconnect();
    } catch (error) {
      // ignore
    }
    socket = null;
  }
}

function cleanupClientSocket() {
  if (clientSocket) {
    try {
      clientSocket.removeAllListeners();
    } catch (error) {
      // ignore
    }
    try {
      clientSocket.disconnect();
    } catch (error) {
      // ignore
    }
    clientSocket = null;
  }
}

function clearHeartbeatInterval() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearHeartbeatTimeout() {
  if (heartbeatTimeoutTimer) {
    clearTimeout(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = null;
  }
}

function stopHeartbeatTimers() {
  clearHeartbeatInterval();
  clearHeartbeatTimeout();
}

function clearClientHeartbeatInterval() {
  if (clientHeartbeatTimer) {
    clearInterval(clientHeartbeatTimer);
    clientHeartbeatTimer = null;
  }
}

function clearClientHeartbeatTimeout() {
  if (clientHeartbeatTimeoutTimer) {
    clearTimeout(clientHeartbeatTimeoutTimer);
    clientHeartbeatTimeoutTimer = null;
  }
}

function stopClientHeartbeatTimers() {
  clearClientHeartbeatInterval();
  clearClientHeartbeatTimeout();
}

function scheduleClientHeartbeatTimeout() {
  clearClientHeartbeatTimeout();
  clientHeartbeatTimeoutTimer = setTimeout(() => {
    log('[ClientWS] 心跳超时，准备重连');
    updateClientWsState({
      status: 'error',
      lastError: 'Heartbeat timeout',
    });
    if (clientSocket) {
      clientSocket.disconnect();
    }
  }, HEARTBEAT_TIMEOUT);
}

function sendClientHeartbeat() {
  if (!clientSocket || !clientSocket.connected) {
    return;
  }
  clientLastPingTimestampMs = Date.now();
  updateClientWsState({
    lastPingAt: new Date(clientLastPingTimestampMs).toISOString(),
  });
  clientSocket.emit('ping');
  scheduleClientHeartbeatTimeout();
}

function startClientHeartbeatLoop() {
  stopClientHeartbeatTimers();
  clientHeartbeatTimer = setInterval(sendClientHeartbeat, HEARTBEAT_INTERVAL);
  sendClientHeartbeat();
}

function updateClientWsState(patch) {
  Object.assign(clientWsState, patch, { endpoint: CLIENT_WS_ENDPOINT });
  broadcastClientWsState();
}

function disconnectWebsocket(reason) {
  stopHeartbeatTimers();
  cleanupSocket();
  updateWsState({
    status: 'disconnected',
    connectedAt: null,
    lastError: reason || null,
    retryCount: 0,
  });
}

function scheduleHeartbeatTimeout() {
  clearHeartbeatTimeout();
  heartbeatTimeoutTimer = setTimeout(() => {
    log('心跳超时，准备重连');
    updateWsState({
      status: 'error',
      lastError: 'Heartbeat timeout',
    });
    if (socket) {
      socket.disconnect();
    }
  }, HEARTBEAT_TIMEOUT);
}

function sendHeartbeat() {
  if (!socket || !socket.connected) {
    return;
  }

  lastPingTimestampMs = Date.now();
  updateWsState({
    lastPingAt: new Date(lastPingTimestampMs).toISOString(),
  });
  socket.emit('ping');
  scheduleHeartbeatTimeout();
}

function startHeartbeatLoop() {
  stopHeartbeatTimers();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  sendHeartbeat();
}

async function initWebsocket() {
  if (!scriptsLoaded.socketio || typeof io === 'undefined') {
    const errorMsg = scriptsLoaded.error || 'socket.io client 不可用，请确保 socket.io.min.js 已正确导入';
    log('Socket.IO 初始化失败:', errorMsg);
    updateWsState({
      status: 'error',
      lastError: errorMsg,
    });
    return;
  }

  const [metadata, authState] = await Promise.all([
    ensureClientMetadata(),
    storageGet([AUTH_TOKEN_KEY, AUTH_USER_INFO_KEY]),
  ]);
  const token = authState[AUTH_TOKEN_KEY];
  const userInfo = authState[AUTH_USER_INFO_KEY];
  const enrichedMetadata = mergeMetadataWithAuth(metadata, token, userInfo);
  const query = buildConnectionQuery(enrichedMetadata, token);
  if (enrichedMetadata) {
    clientMetadata = enrichedMetadata;
    updateWsState({ clientInfo: cloneMetadata(enrichedMetadata) });
  }

  stopHeartbeatTimers();
  cleanupSocket();

  updateWsState({
    status: 'connecting',
    lastError: null,
    retryCount: 0,
  });

  log('开始连接到 WebSocket:', wsEndpoint);

  socket = io(wsEndpoint, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    timeout: 8000,
    query,
    auth: token
      ? {
          token,
        }
      : undefined,
  });

  socket.on('connect', () => {
    log('WebSocket 已连接');
    lastPingTimestampMs = null;
    updateWsState({
      status: 'connected',
      connectedAt: new Date().toISOString(),
      lastError: null,
      lastLatencyMs: null,
      retryCount: 0,
      clientInfo: cloneMetadata(clientMetadata),
    });
    emitClientInfo();
    prefetchLocationInfo();
    startHeartbeatLoop();
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    log('正在尝试重连', attempt);
    updateWsState({
      status: 'reconnecting',
      retryCount: attempt,
    });
  });

  socket.io.on('reconnect_failed', () => {
    log('重连失败');
    updateWsState({
      status: 'error',
      lastError: 'Reconnect failed',
    });
  });

  socket.io.on('reconnect_error', (error) => {
    const message = serializeError(error);
    log('重连错误', message);
    updateWsState({
      status: 'error',
      lastError: message,
    });
  });

  socket.on('disconnect', (reason) => {
    log('WebSocket 已断开', reason);
    stopHeartbeatTimers();
    updateWsState({
      status: 'disconnected',
      connectedAt: null,
      lastError: reason || null,
    });
  });

  socket.on('connect_error', (error) => {
    const message = serializeError(error);
    log('连接错误', message);
    updateWsState({
      status: 'error',
      lastError: message,
    });
  });

  socket.on('error', (error) => {
    const message = serializeError(error);
    log('Socket 错误', message);
    updateWsState({
      status: 'error',
      lastError: message,
    });
  });

  socket.on('pong', (payload) => {
    clearHeartbeatTimeout();
    const now = Date.now();
    const latency = lastPingTimestampMs ? now - lastPingTimestampMs : null;
    lastPingTimestampMs = null;
    updateWsState({
      status: 'connected',
      lastPongAt: new Date(now).toISOString(),
      lastLatencyMs: latency,
      lastError: null,
      lastPayload: payload || null,
    });
  });

  // 监听来自管理系统的消息
  socket.on('admin-message', (data) => {
    log('[admin-message] 收到管理员消息事件');
    log('[admin-message] 消息数据:', data);
    log('[admin-message] 消息数据类型:', typeof data);
    log('[admin-message] 消息数据是否为对象:', typeof data === 'object');
    if (typeof data === 'object' && data !== null) {
      log('[admin-message] 消息数据键:', Object.keys(data));
    }
    handleAdminMessage(data);
  });

  // 监听所有其他消息事件（用于调试）
  socket.onAny((event, ...args) => {
    log(`[onAny] 收到事件: ${event}`, args);
    if (event === 'admin-message') {
      log('[onAny] admin-message 事件数据:', args);
    }
  });
}

async function connectWebsocketIfAuthenticated(context = 'manual') {
  const hasSession = await hasAuthenticatedSession();
  if (!hasSession) {
    log(`[WS] ${context}: 未检测到登录信息，暂不建立连接`);
    disconnectWebsocket('等待登录');
    return false;
  }

  if (socket && socket.connected) {
    log(`[WS] ${context}: WebSocket 已连接，跳过重复连接`);
    return true;
  }

  if (wsState.status === 'connecting' || wsState.status === 'reconnecting') {
    log(`[WS] ${context}: WebSocket 正在连接中，跳过重复触发`);
    return true;
  }

  if (websocketInitPromise) {
    log(`[WS] ${context}: 已有连接任务进行中，等待完成`);
    await websocketInitPromise;
    return true;
  }

  log(`[WS] ${context}: 检测到登录信息完备，开始连接 WebSocket`);
  websocketInitPromise = initWebsocket()
    .catch((error) => {
      log(`[WS] ${context}: 初始化 WebSocket 失败`, serializeError(error));
      throw error;
    })
    .finally(() => {
      websocketInitPromise = null;
    });

  await websocketInitPromise;
  return true;
}

// 初始化本地客户端 WebSocket 连接
async function initClientWebsocket() {
  if (!scriptsLoaded.socketio || typeof io === 'undefined') {
    const errorMsg = scriptsLoaded.error || 'socket.io client 不可用，请确保 socket.io.min.js 已正确导入';
    log('[ClientWS] Socket.IO 初始化失败:', errorMsg);
    updateClientWsState({
      status: 'error',
      lastError: errorMsg,
    });
    return;
  }

  stopClientHeartbeatTimers();
  cleanupClientSocket();

  updateClientWsState({
    status: 'connecting',
    lastError: null,
    retryCount: 0,
  });

  log('[ClientWS] 开始连接到本地客户端 WebSocket:', CLIENT_WS_ENDPOINT);

  // 获取客户端元数据
  const metadata = await ensureClientMetadata();
  const query = {
    clientSource: CLIENT_SOURCE,
    clientId: metadata?.clientId || `ext_${Date.now()}`,
  };

  try {
    query.clientInfo = JSON.stringify(metadata);
  } catch (e) {
    log('[ClientWS] 序列化客户端信息失败:', e);
  }

  clientSocket = io(CLIENT_WS_ENDPOINT, {
    path: '/ws',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 12000,
    timeout: 8000,
    query,
  });

  clientSocket.on('connect', () => {
    log('[ClientWS] 本地客户端 WebSocket 已连接');
    clientLastPingTimestampMs = null;
    updateClientWsState({
      status: 'connected',
      connectedAt: new Date().toISOString(),
      lastError: null,
      lastLatencyMs: null,
      retryCount: 0,
    });
    startClientHeartbeatLoop();
  });

  clientSocket.io.on('reconnect_attempt', (attempt) => {
    log('[ClientWS] 正在尝试重连', attempt);
    updateClientWsState({
      status: 'reconnecting',
      retryCount: attempt,
    });
  });

  clientSocket.io.on('reconnect_failed', () => {
    log('[ClientWS] 重连失败');
    updateClientWsState({
      status: 'error',
      lastError: 'Reconnect failed',
    });
  });

  clientSocket.io.on('reconnect_error', (error) => {
    const message = serializeError(error);
    log('[ClientWS] 重连错误', message);
    updateClientWsState({
      status: 'error',
      lastError: message,
    });
  });

  clientSocket.on('disconnect', (reason) => {
    log('[ClientWS] 本地客户端 WebSocket 已断开', reason);
    stopClientHeartbeatTimers();
    updateClientWsState({
      status: 'disconnected',
      connectedAt: null,
      lastError: reason || null,
    });
  });

  clientSocket.on('connect_error', (error) => {
    const message = serializeError(error);
    log('[ClientWS] 连接错误', message);
    updateClientWsState({
      status: 'error',
      lastError: message,
    });
  });

  clientSocket.on('error', (error) => {
    const message = serializeError(error);
    log('[ClientWS] Socket 错误', message);
    updateClientWsState({
      status: 'error',
      lastError: message,
    });
  });

  clientSocket.on('pong', (payload) => {
    clearClientHeartbeatTimeout();
    const now = Date.now();
    const latency = clientLastPingTimestampMs ? now - clientLastPingTimestampMs : null;
    clientLastPingTimestampMs = null;
    updateClientWsState({
      status: 'connected',
      lastPongAt: new Date(now).toISOString(),
      lastLatencyMs: latency,
      lastError: null,
      lastPayload: payload || null,
    });
  });
}

async function connectClientWebsocket() {
  if (clientSocket && clientSocket.connected) {
    log('[ClientWS] 本地客户端 WebSocket 已连接，跳过重复连接');
    return true;
  }

  if (clientWsState.status === 'connecting' || clientWsState.status === 'reconnecting') {
    log('[ClientWS] 本地客户端 WebSocket 正在连接中，跳过重复触发');
    return true;
  }

  if (clientWebsocketInitPromise) {
    log('[ClientWS] 已有连接任务进行中，等待完成');
    await clientWebsocketInitPromise;
    return true;
  }

  log('[ClientWS] 开始连接本地客户端 WebSocket');
  clientWebsocketInitPromise = initClientWebsocket()
    .catch((error) => {
      log('[ClientWS] 初始化本地客户端 WebSocket 失败', serializeError(error));
      throw error;
    })
    .finally(() => {
      clientWebsocketInitPromise = null;
    });

  await clientWebsocketInitPromise;
  return true;
}

async function forceReconnect(context = 'manual') {
  try {
    log(`[WS] ${context}: 开始强制重连`);
    disconnectWebsocket(`force-reconnect:${context}`);
    await ensureEndpoint();
    await connectWebsocketIfAuthenticated(context);
  } catch (error) {
    log(`[WS] ${context}: 强制重连失败`, serializeError(error));
    updateWsState({
      status: 'error',
      lastError: serializeError(error),
    });
    throw error;
  }
}

function handleAdminMessage(data) {
  log('[handleAdminMessage] 开始处理管理员消息');
  log('[handleAdminMessage] 输入数据:', data);
  
  try {
    // 尝试通过消息路由器处理命令消息
    if (typeof self !== 'undefined' && self.MessageHandlers?.Router) {
      self.MessageHandlers.Router.handle(data, { logFn: log, socket })
        .then((result) => {
          if (result.handled) {
            log('[handleAdminMessage] 命令消息已处理:', result);
            return; // 命令消息不需要存储和通知
          }
          // 如果不是命令消息，继续处理为普通消息
        })
        .catch((error) => {
          log('[handleAdminMessage] 处理命令消息失败:', serializeError(error));
        });
      
      // 如果是命令消息，提前返回（不等待异步结果，避免阻塞）
      if (data && typeof data === 'object' && data.command) {
        return;
      }
    }

    const messageData = {
      timestamp: new Date().toISOString(),
      data: data,
    };
    
    log('[handleAdminMessage] 构建的消息数据:', messageData);
    log('[handleAdminMessage] 时间戳:', messageData.timestamp);

    // 存储消息到 storage
    log('[handleAdminMessage] 开始读取现有消息...');
    chrome.storage.local.get(['adminMessages'], (result) => {
      log('[handleAdminMessage] 读取到的现有消息:', result);
      const messages = result.adminMessages || [];
      log('[handleAdminMessage] 现有消息数量:', messages.length);
      
      messages.unshift(messageData);
      log('[handleAdminMessage] 添加新消息后数量:', messages.length);
      
      // 只保留最近 50 条消息
      if (messages.length > 50) {
        messages.length = 50;
        log('[handleAdminMessage] 截断后消息数量:', messages.length);
      }
      
      log('[handleAdminMessage] 准备存储消息，数量:', messages.length);
      chrome.storage.local.set({ adminMessages: messages }, () => {
        if (chrome.runtime.lastError) {
          log('[handleAdminMessage] 存储管理员消息失败:', chrome.runtime.lastError.message);
        } else {
          log('[handleAdminMessage] 消息存储成功');
          // 验证存储
          chrome.storage.local.get(['adminMessages'], (verifyResult) => {
            log('[handleAdminMessage] 验证存储结果，消息数量:', verifyResult.adminMessages?.length || 0);
          });
        }
      });
    });

    // 发送通知给 popup 或其他监听者
    log('[handleAdminMessage] 准备发送消息通知给 popup...');
    chrome.runtime.sendMessage(
      {
        type: 'adminMessage:received',
        payload: messageData,
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (err.message.includes('Receiving end does not exist.')) {
            log('[handleAdminMessage] Popup 未打开，消息已存储，将在下次打开时显示');
          } else {
            log('[handleAdminMessage] 广播管理员消息失败:', err.message);
          }
        } else {
          log('[handleAdminMessage] 消息通知发送成功，响应:', response);
        }
      }
    );

    // 显示浏览器通知（如果用户允许）
    if (chrome.notifications) {
      log('[handleAdminMessage] 准备创建浏览器通知...');
      const notificationId = `admin-message-${Date.now()}`;
      const messageText = typeof data === 'string' 
        ? data 
        : (data?.message || data?.text || JSON.stringify(data));
      
      log('[handleAdminMessage] 通知内容:', messageText);
      
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png') || '',
        title: '管理员消息',
        message: messageText.length > 100 ? messageText.substring(0, 100) + '...' : messageText,
      }, (createdId) => {
        if (chrome.runtime.lastError) {
          log('[handleAdminMessage] 创建通知失败:', chrome.runtime.lastError.message);
        } else {
          log('[handleAdminMessage] 通知创建成功，ID:', createdId);
        }
      });
    } else {
      log('[handleAdminMessage] chrome.notifications 不可用');
    }
    
    log('[handleAdminMessage] 处理完成');
  } catch (error) {
    log('[handleAdminMessage] 处理管理员消息失败:', serializeError(error));
    log('[handleAdminMessage] 错误堆栈:', error?.stack);
  }
}

// handlePinterestScrapeCommand 和 executePinterestScrapeWithParams 已迁移到 handlers/pinterest.js

async function ensureEndpoint() {
  try {
    const result = await storageGet([
      STORAGE_ENDPOINT_KEY,
      STORAGE_ENDPOINT_CUSTOM_KEY,
      STORAGE_DEV_MODE_KEY,
      STORAGE_DEV_WS_BASE_URL_KEY,
      STORAGE_WS_BASE_URL_KEY,
    ]);
    const storedEndpoint = result[STORAGE_ENDPOINT_KEY];
    const isCustom = Boolean(result[STORAGE_ENDPOINT_CUSTOM_KEY] && storedEndpoint);

    if (isCustom) {
      wsEndpoint = storedEndpoint;
      log('使用自定义 WebSocket 端点:', wsEndpoint);
    } else {
      const devModeEnabled = Boolean(result[STORAGE_DEV_MODE_KEY]);
      wsEndpoint = devModeEnabled
        ? (result[STORAGE_DEV_WS_BASE_URL_KEY] || DEFAULT_DEV_WS_ENDPOINT)
        : (result[STORAGE_WS_BASE_URL_KEY] || DEFAULT_PROD_WS_ENDPOINT);
      log(`使用${devModeEnabled ? '开发' : '生产'} WebSocket 端点:`, wsEndpoint);
      await storageSet({
        [STORAGE_ENDPOINT_KEY]: wsEndpoint,
        [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
      }).catch((error) => {
        log('写入默认端点失败（可忽略）:', serializeError(error));
      });
    }
  } catch (error) {
    log('确保端点时出错，使用默认端点:', serializeError(error));
    wsEndpoint = DEFAULT_PROD_WS_ENDPOINT;
    storageSet({
      [STORAGE_ENDPOINT_KEY]: wsEndpoint,
      [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
    }).catch((err) => {
      log('写入默认端点失败（可忽略）:', serializeError(err));
    });
  }

  updateWsState({ endpoint: wsEndpoint });
}

function setEndpoint(newEndpoint, callback) {
  const normalized = typeof newEndpoint === 'string' ? newEndpoint.trim() : '';

  storageGet([STORAGE_DEV_MODE_KEY])
    .then((result) => {
      const devModeEnabled = Boolean(result[STORAGE_DEV_MODE_KEY]);
      const fallbackEndpoint = devModeEnabled ? DEFAULT_DEV_WS_ENDPOINT : DEFAULT_PROD_WS_ENDPOINT;
      const effectiveEndpoint = normalized || fallbackEndpoint;
      const isCustom = Boolean(normalized);

      return storageSet({
        [STORAGE_ENDPOINT_KEY]: effectiveEndpoint,
        [STORAGE_ENDPOINT_CUSTOM_KEY]: isCustom,
      }).then(() => ({
        effectiveEndpoint,
        isCustom,
      }));
    })
    .then(({ effectiveEndpoint, isCustom }) => {
      wsEndpoint = effectiveEndpoint;
      updateWsState({ endpoint: wsEndpoint });
      log('WebSocket 端点已更新为:', wsEndpoint, '(custom:', isCustom, ')');
      if (socket) {
        log('端点变更，重新初始化连接');
      }
      connectWebsocketIfAuthenticated('update-endpoint').catch((error) => {
        log('[WS] update-endpoint: 重新连接失败', serializeError(error));
      });
      if (typeof callback === 'function') {
        callback(null);
      }
    })
    .catch((error) => {
      log('设置端点失败:', serializeError(error));
      if (typeof callback === 'function') {
        callback(error);
      }
    });
}

async function restorePinterestSchedule() {
  try {
    const config = await storageGet([PINTEREST_SCHEDULE_STORAGE_KEY]);
    const scheduleConfig = config[PINTEREST_SCHEDULE_STORAGE_KEY];
    
    if (!scheduleConfig || !scheduleConfig.params) {
      return;
    }
    
    const intervalMinutes = scheduleConfig.intervalMinutes || 60;
    
    // 检查定时任务是否已存在
    const alarm = await new Promise((resolve) => {
      chrome.alarms.get(PINTEREST_SCHEDULE_ALARM_NAME, (alarm) => {
        resolve(alarm);
      });
    });
    
    // 如果定时任务不存在，重新创建
    if (!alarm) {
      chrome.alarms.create(PINTEREST_SCHEDULE_ALARM_NAME, {
        periodInMinutes: intervalMinutes,
      });
      log(`[Pinterest] 定时任务已恢复：每 ${intervalMinutes} 分钟执行一次`);
    } else {
      log(`[Pinterest] 定时任务已存在，无需恢复`);
    }
  } catch (error) {
    log('[Pinterest] 恢复定时任务失败:', serializeError(error));
  }
}

async function initialize() {
  try {
    // 1. 确定要连接的 WebSocket 端点（生产 / 开发 / 自定义）
    await ensureEndpoint();
    // 2. 收集一次客户端元信息（浏览器、OS、扩展版本等）
    await ensureClientMetadata();
    prefetchLocationInfo();
    // 3. 初始化前先广播一次状态（确保 popup 能获取到初始状态）
    broadcastWsState();
    broadcastClientWsState();
    // 4. 如果已经登录，则尝试连接后端 WebSocket
    const connected = await connectWebsocketIfAuthenticated('initialize');
    if (!connected) {
      log('[WS] initialize: 未登录，等待登录信息后再连接');
    }
    // 5. 初始化本地客户端连接（不需要登录）
    connectClientWebsocket().catch((error) => {
      log('[ClientWS] initialize: 连接本地客户端失败', serializeError(error));
    });
    // 6. 初始化后再次广播状态（确保状态已更新）
    broadcastWsState();
    broadcastClientWsState();
  } catch (error) {
    log('初始化 WebSocket 失败:', serializeError(error));
    updateWsState({
      status: 'error',
      lastError: serializeError(error),
    });
  }
}

// =============================================================
// 五、全局错误处理
// =============================================================
self.addEventListener('error', (event) => {
  console.error('[Core][WS] Service Worker 全局错误:', event.error);
  log('Service Worker 全局错误: ' + serializeError(event.error));
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Core][WS] Service Worker 未处理的 Promise 拒绝:', event.reason);
  log('Service Worker 未处理的 Promise 拒绝: ' + serializeError(event.reason));
});

// =============================================================
// 六、安装 / 启动 / 存储变更等生命周期事件
// =============================================================

chrome.runtime.onInstalled.addListener(() => {
  log('插件已安装');
  try {
  chrome.storage.local.get([STORAGE_ENDPOINT_KEY, STORAGE_ENDPOINT_CUSTOM_KEY], (result) => {
      if (chrome.runtime.lastError) {
        log('获取存储失败:', chrome.runtime.lastError.message);
        return;
      }
    if (!result[STORAGE_ENDPOINT_KEY]) {
      chrome.storage.local.set({
        [STORAGE_ENDPOINT_KEY]: DEFAULT_WS_ENDPOINT,
        [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
        }, () => {
          if (chrome.runtime.lastError) {
            log('设置默认端点失败:', chrome.runtime.lastError.message);
          }
      });
    }
  });
  } catch (error) {
    log('onInstalled 处理失败:', serializeError(error));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }
  const tokenChanged = Object.prototype.hasOwnProperty.call(changes, AUTH_TOKEN_KEY);
  const userInfoChanged = Object.prototype.hasOwnProperty.call(changes, AUTH_USER_INFO_KEY);
  const devConfigChanged =
    Object.prototype.hasOwnProperty.call(changes, STORAGE_DEV_MODE_KEY) ||
    Object.prototype.hasOwnProperty.call(changes, STORAGE_DEV_WS_BASE_URL_KEY) ||
    Object.prototype.hasOwnProperty.call(changes, STORAGE_WS_BASE_URL_KEY);

  if (tokenChanged || userInfoChanged) {
    connectWebsocketIfAuthenticated('auth-state-change').catch((error) => {
      log('[WS] auth-state-change: 处理失败', serializeError(error));
    });
  }

  if (devConfigChanged) {
    forceReconnect('dev-config-change')
      .catch((error) => {
        log('[WS] dev-config-change: 处理失败', serializeError(error));
      });
  }
});

chrome.runtime.onStartup.addListener(() => {
  log('浏览器启动，开始初始化');
  initialize().catch((error) => {
    log('启动时初始化失败:', serializeError(error));
    updateWsState({
      status: 'error',
      lastError: '初始化失败: ' + serializeError(error),
    });
  });
});

// =============================================================
// 七、Service Worker 启动入口
// =============================================================
try {
  log('Service Worker 开始初始化...');
initialize().catch((error) => {
  log('初始化调用失败:', serializeError(error));
    updateWsState({
      status: 'error',
      lastError: '初始化失败: ' + serializeError(error),
});
  });
} catch (error) {
  console.error('[Core][WS] Service Worker 初始化异常:', error);
  log('Service Worker 初始化异常: ' + serializeError(error));
}

// =============================================================
// 八、扩展内部消息分发（popup / content scripts -> background）
// =============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'control/feature-execute') {
    handleControlFeatureExecute(request)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: serializeError(error) }));
    return true;
  }

  if (request.action === 'saveData') {
    chrome.storage.local.get(['crawledData'], (result) => {
      const data = result.crawledData || [];
      data.push({
        site: request.site,
        data: request.data,
        timestamp: new Date().toISOString(),
      });
      chrome.storage.local.set({ crawledData: data }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (request.action === 'getData') {
    chrome.storage.local.get(['crawledData'], (result) => {
      sendResponse({ data: result.crawledData || [] });
    });
    return true;
  }

  if (request.action === 'getWebsocketStatus') {
    sendResponse({ success: true, data: { ...wsState } });
    return true;
  }

  if (request.action === 'getClientWebsocketStatus') {
    sendResponse({ success: true, data: { ...clientWsState } });
    return true;
  }

  if (request.action === 'reconnectWebsocket') {
    forceReconnect('manual-reconnect')
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: serializeError(error) }));
    return true;
  }

  if (request.action === 'reconnectClientWebsocket') {
    connectClientWebsocket()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: serializeError(error) }));
    return true;
  }

  if (request.action === 'updateDevMode') {
    forceReconnect('dev-mode-switch')
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: serializeError(error) }));
    return true;
  }

  if (request.action === 'setWebsocketEndpoint') {
    setEndpoint(request.endpoint, (error) => {
      if (error) {
        sendResponse({ success: false, error: serializeError(error) });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('[Core] 标签页已加载:', tab.url);
  }
});

// 监听定时任务触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PINTEREST_SCHEDULE_ALARM_NAME) {
    log('[Pinterest] 定时任务触发:', alarm);
    executeScheduledPinterestScrape().catch((error) => {
      log('[Pinterest] 定时任务执行失败:', serializeError(error));
    });
  }
});

// ==================== 右键菜单功能 ====================

/**
 * 初始化右键菜单
 */
function initContextMenus() {
  // 清除所有现有的右键菜单项（避免重复创建）
  chrome.contextMenus.removeAll(() => {
    // 忽略错误（如果菜单项不存在）
    if (chrome.runtime.lastError) {
      log('[ContextMenu] 清除菜单项:', chrome.runtime.lastError.message);
    }

    // 1）打印当前页面信息（任何位置都能用）
    chrome.contextMenus.create({
      id: 'print-page-info',
      title: '打印当前页面信息',
      // 使用 all，保证无论在页面、链接、图片、选中文本等位置右键都能看到
      contexts: ['all']
    });

    // 2）上传图片到爬图库（只在图片上右键时显示）
    chrome.contextMenus.create({
      id: 'upload-image-to-crawler',
      title: '上传图片到 YiShe 素材库',
      contexts: ['image']
    });

    log('[ContextMenu] 右键菜单已初始化（仅打印当前页面信息）');
  });
}

/**
 * 复制文本到剪贴板
 */
async function copyToClipboard(text) {
  try {
    // 获取当前活动标签页
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error('无法获取当前标签页');
    }

    // 使用 scripting API 在页面中执行复制操作
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (textToCopy) => {
        // 创建一个临时的 textarea 元素
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        
        try {
          const successful = document.execCommand('copy');
          if (!successful) {
            throw new Error('复制失败');
          }
        } finally {
          document.body.removeChild(textarea);
        }
      },
      args: [text]
    });

    log('[ContextMenu] 文本已复制到剪贴板');
    return true;
  } catch (error) {
    log('[ContextMenu] 复制失败:', serializeError(error));
    throw error;
  }
}

/**
 * 处理右键菜单点击事件
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    log('[ContextMenu] 右键菜单项被点击:', info.menuItemId);

    // 1）打印当前页面信息（调试用）
    if (info.menuItemId === 'print-page-info') {
      // 收集当前页面及点击上下文的关键信息
      const pageInfo = {
        // 标签页相关
        tabId: tab?.id ?? null,
        tabUrl: tab?.url ?? null,
        tabTitle: tab?.title ?? null,
        tabFavIconUrl: tab?.favIconUrl ?? null,

        // 页面 / frame 相关
        pageUrl: info.pageUrl || null,
        frameUrl: info.frameUrl || null,
        frameId: info.frameId ?? null,

        // 文本 / 链接 / 图片 等上下文信息
        selectionText: info.selectionText || null,
        linkUrl: info.linkUrl || null,
        linkText: info.linkText || null,
        srcUrl: info.srcUrl || null,
        mediaType: info.mediaType || null,
        editable: info.editable ?? null,

        // 触发菜单的更多元信息
        menuItemId: info.menuItemId,
        parentMenuItemId: info.parentMenuItemId || null,
        contexts: info.contexts || undefined
      };

      // 打印到扩展的日志和普通控制台，方便调试查看
      log('[ContextMenu] 打印当前页面信息:', pageInfo);
      console.log('[YiShe][PageInfo]', pageInfo);
      return;
    }

    // 2）上传图片到 YiShe 爬图库
    if (info.menuItemId === 'upload-image-to-crawler') {
      const imageUrl = info.srcUrl || null;
      const pageUrl = info.pageUrl || tab?.url || null;
      const pageTitle = tab?.title || null;

      if (!imageUrl) {
        log('[ContextMenu] 上传图片失败：未获取到图片地址 srcUrl');
        console.warn('[YiShe][UploadImage] 缺少图片地址 srcUrl，info =', info);

        // 没有拿到图片地址时给出警告提示
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              type: 'core:toast',
              level: 'warning',
              message: '无法识别当前图片地址，暂时无法上传'
            },
            () => {}
          );
        }
        return;
      }

      log('[ContextMenu] 准备上传图片到爬图库:', {
        imageUrl,
        pageUrl,
        pageTitle
      });

      // 显示 loading 状态
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(
          tab.id,
          {
            type: 'core:loading',
            action: 'show',
            message: '正在上传图片到 YiShe 素材库...'
          },
          () => {}
        );
      }

      try {
        // 调用本地 yishe-client 提供的接口
        const payload = {
          url: imageUrl,
          // 这些字段目前在后端是可选的，你后续可以在这里填更多信息
          name: '',          // 可以以后改成从图片 alt / 描述推断
          description: '',   // 暂时留空，由服务端或后续编辑补充
          keywords: ''       // 暂时留空
        };

        const response = await fetch('http://localhost:1519/api/crawler-material-upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          log('[ContextMenu] 上传图片到爬图库失败，HTTP 状态异常:', response.status, text);
          console.error('[YiShe][UploadImage] 上传失败:', response.status, text);

          // 隐藏 loading 状态
          if (tab && tab.id != null) {
            chrome.tabs.sendMessage(
              tab.id,
              {
                type: 'core:loading',
                action: 'hide'
              },
              () => {}
            );
          }

          // 后台错误提示（执行失败）
          if (tab && tab.id != null) {
            chrome.tabs.sendMessage(
              tab.id,
              {
                type: 'core:toast',
                level: 'error',
                message: '上传图片失败（本地服务返回错误）'
              },
              () => {}
            );
          }
          return;
        }

        let result = null;
        try {
          result = await response.json();
        } catch (e) {
          log('[ContextMenu] 解析上传接口响应失败:', serializeError(e));
        }

        log('[ContextMenu] 图片上传接口响应:', result);
        console.log('[YiShe][UploadImage] 图片上传完成:', {
          imageUrl,
          pageUrl,
          pageTitle,
          result
        });

        // 隐藏 loading 状态
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              type: 'core:loading',
              action: 'hide'
            },
            () => {}
          );
        }

        // 成功提示（执行成功）
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              type: 'core:toast',
              level: 'success',
              message: '图片已上传到 YiShe 素材库'
            },
            () => {}
          );
        }
      } catch (error) {
        log('[ContextMenu] 调用上传接口异常:', serializeError(error));
        console.error('[YiShe][UploadImage] 调用上传接口异常:', error);

        // 隐藏 loading 状态
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              type: 'core:loading',
              action: 'hide'
            },
            () => {}
          );
        }

        // 异常提示（执行中出现意外错误）
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(
            tab.id,
            {
              type: 'core:toast',
              level: 'error',
              message: '上传图片时发生异常，请稍后重试'
            },
            () => {}
          );
        }
      }

      return;
    } else {
      // 其他未知菜单项（目前理论上不会出现）
      log('[ContextMenu] 未知的菜单项 ID（目前应不存在）:', info.menuItemId);
    }
  } catch (error) {
    log('[ContextMenu] 处理右键菜单点击失败:', serializeError(error));
  }
});

// 在插件安装或启动时初始化右键菜单
chrome.runtime.onInstalled.addListener(() => {
  initContextMenus();
});

// 在 Service Worker 启动时也初始化右键菜单（防止菜单丢失）
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    initContextMenus();
  });
}

// 在初始化函数中也调用一次（确保菜单存在）
try {
  initContextMenus();
} catch (error) {
  log('[ContextMenu] 初始化右键菜单失败:', serializeError(error));
}

