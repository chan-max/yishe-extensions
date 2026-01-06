/**
 * API 配置文件
 * 统一管理服务地址、接口路径等配置信息
 * 便于维护和修改，实现低耦合
 */

// 生产环境配置
const PROD_CONFIG = {
  // API 基础地址
  API_BASE_URL: 'https://1s.design:1520/api',
  // WebSocket 基础地址
  WS_BASE_URL: 'https://1s.design:1520/ws',
  // 本地客户端地址（Electron）
  CLIENT_BASE_URL: 'http://localhost:1519',
  // 爬虫素材上传接口
  CRAWLER_MATERIAL_UPLOAD_URL: 'https://1s.design:1520/api/crawler/material/add',
  // 飞书 Webhook（可选）
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449',
  // 位置信息接口
  LOCATION_ENDPOINT: 'https://ipapi.co/json/',
};

// 开发环境配置
const DEV_CONFIG = {
  // API 基础地址
  API_BASE_URL: 'http://localhost:1520/api',
  // WebSocket 基础地址
  WS_BASE_URL: 'http://localhost:1520/ws',
  // 本地客户端地址（Electron）
  CLIENT_BASE_URL: 'http://localhost:1519',
  // 爬虫素材上传接口
  CRAWLER_MATERIAL_UPLOAD_URL: 'http://localhost:1520/api/crawler/material/add',
  // 飞书 Webhook（可选）
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449',
  // 位置信息接口
  LOCATION_ENDPOINT: 'https://ipapi.co/json/',
};

// API 接口路径（相对路径，会与 API_BASE_URL 拼接）
const API_ENDPOINTS = {
  // 认证相关
  AUTH: {
    LOGIN: '/auth/login',
    LOGOUT: '/auth/logout',
  },
  // 用户相关
  USER: {
    GET_USER_INFO: '/user/getUserInfo',
  },
  // 公共链接相关
  COMMON_URL: {
    CREATE: '/common-url',
    LIST: '/common-url/page',
    GET: '/common-url/:id',
    UPDATE: '/common-url/:id',
    DELETE: '/common-url/:id',
    GET_BY_USER: '/common-url/user/:userId',
    GET_BY_CATEGORY: '/common-url/category/:category',
  },
  // 句子管理相关
  SENTENCE: {
    CREATE: '/sentences',
    LIST: '/sentences/page',
    GET: '/sentences/:id',
    UPDATE: '/sentences/:id',
    DELETE: '/sentences/:id',
    AI_ANALYZE: '/sentences/ai-analyze',
  },
  // 爬虫相关
  CRAWLER: {
    MATERIAL_ADD: '/crawler/material/add',
  },
};

// 本地客户端接口路径（相对路径，会与 CLIENT_BASE_URL 拼接）
const CLIENT_ENDPOINTS = {
  // 爬虫素材上传
  CRAWLER_MATERIAL_UPLOAD: '/api/crawler-material-upload',
};

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROD_CONFIG,
    DEV_CONFIG,
    API_ENDPOINTS,
    CLIENT_ENDPOINTS,
  };
}

// 如果在浏览器环境中，挂载到 window
if (typeof window !== 'undefined') {
  window.ApiConfig = {
    PROD_CONFIG,
    DEV_CONFIG,
    API_ENDPOINTS,
    CLIENT_ENDPOINTS,
  };
}

// 如果在 Service Worker 环境中，挂载到 self
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.ApiConfig = {
    PROD_CONFIG,
    DEV_CONFIG,
    API_ENDPOINTS,
    CLIENT_ENDPOINTS,
  };
}

