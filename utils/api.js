// API 工具函数
// 用于处理 API 请求、token 管理和 base URL 配置

const STORAGE_KEYS = {
  TOKEN: 'accessToken',
  USER_INFO: 'userInfo',
  DEV_MODE: 'devMode',
  API_BASE_URL: 'apiBaseUrl',
  WS_BASE_URL: 'wsBaseUrl',
  DEV_API_BASE_URL: 'devApiBaseUrl',
  DEV_WS_BASE_URL: 'devWsBaseUrl',
};

// 默认配置
const DEFAULT_CONFIG = {
  PROD_API_BASE_URL: 'https://1s.design:1520/api',
  PROD_WS_BASE_URL: 'https://1s.design:1520/ws',
  DEV_API_BASE_URL: 'http://localhost:1520/api',
  DEV_WS_BASE_URL: 'http://localhost:1520/ws',
};

// 存储工具函数
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
        resolve();
      }
    });
  });
}

// 获取设备信息
function getDeviceInfo() {
  const userAgent = navigator.userAgent;
  const platform = navigator.platform;
  const language = navigator.language;
  
  return {
    userAgent,
    platform,
    language,
    timestamp: new Date().toISOString(),
  };
}

// 获取是否启用开发模式
async function isDevMode() {
  const result = await storageGet([STORAGE_KEYS.DEV_MODE]);
  return Boolean(result[STORAGE_KEYS.DEV_MODE]);
}

// 获取 API Base URL
async function getApiBaseUrl() {
  const devMode = await isDevMode();
  if (devMode) {
    const result = await storageGet([STORAGE_KEYS.DEV_API_BASE_URL]);
    return result[STORAGE_KEYS.DEV_API_BASE_URL] || DEFAULT_CONFIG.DEV_API_BASE_URL;
  }
  const result = await storageGet([STORAGE_KEYS.API_BASE_URL]);
  return result[STORAGE_KEYS.API_BASE_URL] || DEFAULT_CONFIG.PROD_API_BASE_URL;
}

// 获取 WebSocket Base URL
async function getWsBaseUrl() {
  const devMode = await isDevMode();
  if (devMode) {
    const result = await storageGet([STORAGE_KEYS.DEV_WS_BASE_URL]);
    return result[STORAGE_KEYS.DEV_WS_BASE_URL] || DEFAULT_CONFIG.DEV_WS_BASE_URL;
  }
  const result = await storageGet([STORAGE_KEYS.WS_BASE_URL]);
  return result[STORAGE_KEYS.WS_BASE_URL] || DEFAULT_CONFIG.PROD_WS_BASE_URL;
}

// 设置开发模式
async function setDevMode(enabled) {
  await storageSet({ [STORAGE_KEYS.DEV_MODE]: enabled });
  // 通知 service worker 更新配置
  chrome.runtime.sendMessage({
    action: 'updateDevMode',
    devMode: enabled,
  }).catch(() => {
    // 忽略错误（service worker 可能未运行）
  });
}

// 设置 API Base URL
async function setApiBaseUrl(url, isDev = false) {
  const key = isDev ? STORAGE_KEYS.DEV_API_BASE_URL : STORAGE_KEYS.API_BASE_URL;
  await storageSet({ [key]: url });
}

// 设置 WebSocket Base URL
async function setWsBaseUrl(url, isDev = false) {
  const key = isDev ? STORAGE_KEYS.DEV_WS_BASE_URL : STORAGE_KEYS.WS_BASE_URL;
  await storageSet({ [key]: url });
}

// 获取 Token
async function getToken() {
  const result = await storageGet([STORAGE_KEYS.TOKEN]);
  return result[STORAGE_KEYS.TOKEN] || null;
}

// 设置 Token
async function setToken(token) {
  await storageSet({ [STORAGE_KEYS.TOKEN]: token });
}

// 清除 Token
async function clearToken() {
  await storageSet({ [STORAGE_KEYS.TOKEN]: null });
}

// 获取用户信息
async function getUserInfo() {
  const result = await storageGet([STORAGE_KEYS.USER_INFO]);
  return result[STORAGE_KEYS.USER_INFO] || null;
}

// 设置用户信息
async function setUserInfo(userInfo) {
  await storageSet({ [STORAGE_KEYS.USER_INFO]: userInfo });
}

// 清除用户信息
async function clearUserInfo() {
  await storageSet({ [STORAGE_KEYS.USER_INFO]: null });
}

function normalizeApiResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return raw;
  }
  const hasData = Object.prototype.hasOwnProperty.call(raw, 'data');
  const hasEnvelopeMeta =
    Object.prototype.hasOwnProperty.call(raw, 'code') ||
    Object.prototype.hasOwnProperty.call(raw, 'status') ||
    Object.prototype.hasOwnProperty.call(raw, 'msg') ||
    Object.prototype.hasOwnProperty.call(raw, 'message');
  if (hasData && hasEnvelopeMeta) {
    return raw.data;
  }
  return raw;
}

// API 请求函数
async function apiRequest(url, options = {}) {
  const baseUrl = await getApiBaseUrl();
  const token = await getToken();
  
  // 如果 URL 是完整 URL，直接使用；否则拼接 baseUrl
  // baseUrl 已经包含 /api 前缀，所以直接拼接即可
  let fullUrl;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    fullUrl = url;
  } else {
    // 确保 url 以 / 开头
    const normalizedUrl = url.startsWith('/') ? url : `/${url}`;
    // 确保 baseUrl 不以 / 结尾
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    fullUrl = `${normalizedBase}${normalizedUrl}`;
  }
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(fullUrl, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => '请求失败');
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText || `HTTP ${response.status}` };
    }
    const error = new Error(errorData.message || errorData.msg || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    const json = await response.json();
    return normalizeApiResponse(json);
  }
  
  return await response.text();
}

// 登录
async function login(username, password, rememberMe = false) {
  const apiBaseUrl = await getApiBaseUrl();
  // 确保 URL 正确拼接（apiBaseUrl 已经包含 /api 前缀）
  const url = `${apiBaseUrl}/auth/login`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
      deviceInfo: getDeviceInfo(),
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => '登录失败');
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText || `HTTP ${response.status}` };
    }
    throw new Error(errorData.message || errorData.msg || `登录失败: HTTP ${response.status}`);
  }
  
  const data = normalizeApiResponse(await response.json());
  
  if (!data || !data.token) {
    throw new Error('登录响应中未找到 token');
  }
  
  // 保存 token
  await setToken(data.token);
  
  // 获取用户信息
  await fetchUserInfo();
  
  return data;
}

// 获取用户信息
async function fetchUserInfo() {
  try {
    const data = await apiRequest('/user/getUserInfo', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    
    if (data) {
      await setUserInfo(data);
      return data;
    }
    
    throw new Error('获取用户信息失败：响应为空');
  } catch (error) {
    console.error('获取用户信息失败:', error);
    // 如果是 401 错误，清除 token 和用户信息
    if (error.status === 401 || (error.message && error.message.includes('401'))) {
      await clearToken();
      await clearUserInfo();
    }
    throw error;
  }
}

// 登出
async function logout() {
  try {
    await apiRequest('/auth/logout', {
      method: 'POST',
    });
  } catch (error) {
    console.error('登出请求失败:', error);
  } finally {
    await clearToken();
    await clearUserInfo();
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    login,
    logout,
    fetchUserInfo,
    apiRequest,
    getToken,
    setToken,
    clearToken,
    getUserInfo,
    setUserInfo,
    clearUserInfo,
    isDevMode,
    setDevMode,
    getApiBaseUrl,
    getWsBaseUrl,
    setApiBaseUrl,
    setWsBaseUrl,
    DEFAULT_CONFIG,
    STORAGE_KEYS,
  };
}

// 如果在浏览器环境中，挂载到 window
if (typeof window !== 'undefined') {
  window.ApiUtils = {
    login,
    logout,
    fetchUserInfo,
    apiRequest,
    getToken,
    setToken,
    clearToken,
    getUserInfo,
    setUserInfo,
    clearUserInfo,
    isDevMode,
    setDevMode,
    getApiBaseUrl,
    getWsBaseUrl,
    setApiBaseUrl,
    setWsBaseUrl,
    DEFAULT_CONFIG,
    STORAGE_KEYS,
  };
}

