// @ts-nocheck
import { io } from "socket.io-client";

import * as HandlerBase from "@/background/handlers/base";
import * as MessageRouter from "@/background/handlers/router";
import { ApiUtils } from "@/shared/api-utils";
import {
  API_ENDPOINTS,
  CLIENT_ENDPOINTS,
  DEV_CONFIG,
  PROD_CONFIG,
} from "@/shared/api-config";

const backgroundGlobal = globalThis as typeof globalThis & {
  ApiConfig?: {
    PROD_CONFIG: typeof PROD_CONFIG;
    DEV_CONFIG: typeof DEV_CONFIG;
    API_ENDPOINTS: typeof API_ENDPOINTS;
    CLIENT_ENDPOINTS: typeof CLIENT_ENDPOINTS;
  };
  ApiUtils?: typeof ApiUtils;
  MessageHandlers?: {
    Base: typeof HandlerBase;
    Router: typeof MessageRouter;
  };
};

backgroundGlobal.ApiConfig = {
  PROD_CONFIG,
  DEV_CONFIG,
  API_ENDPOINTS,
  CLIENT_ENDPOINTS,
};
backgroundGlobal.ApiUtils = ApiUtils;
backgroundGlobal.MessageHandlers = {
  Base: HandlerBase,
  Router: MessageRouter,
};

// =============================================================
// service-worker.ts: 后台 Service Worker 入口
// -------------------------------------------------------------
// 职责概览（记住这 4 点就够了）：
// 1）管理「服务端 WebSocket」连接状态（远程后端服务）
// 2）管理「本地客户端 WebSocket」连接状态（本地 Electron 客户端）
// 3）处理全局事件（安装、启动、存储变更、右键菜单等）
// 4）提供统一的 runtime / context menu / upload 调度
// =============================================================

// 简单的日志函数（在 log 函数定义之前使用）
function simpleLog(...args) {
  console.log("[Core][WS]", ...args);
}

// =============================================================
// 一、模块依赖 & 全局配置
// =============================================================

const scriptsLoaded = {
  socketio: true,
  error: null,
};

const OPEN_SOURCE_REMOTE_WS_ENDPOINT = "https://api.example.invalid/ws";

// 从配置文件获取默认地址（如果配置文件加载失败，使用开源安全 fallback）
const DEFAULT_PROD_WS_ENDPOINT =
  backgroundGlobal.ApiConfig?.PROD_CONFIG?.WS_BASE_URL ||
  OPEN_SOURCE_REMOTE_WS_ENDPOINT;
const DEFAULT_DEV_WS_ENDPOINT =
  backgroundGlobal.ApiConfig?.DEV_CONFIG?.WS_BASE_URL ||
  "http://localhost:1520/ws";
const DEFAULT_WS_ENDPOINT = DEFAULT_PROD_WS_ENDPOINT;
// 本地 Electron 客户端固定地址（不包含路径，路径由 Socket.IO 配置指定）
const DEFAULT_PROD_CLIENT_ENDPOINT =
  backgroundGlobal.ApiConfig?.PROD_CONFIG?.CLIENT_BASE_URL ||
  "http://localhost:1519";
const DEFAULT_DEV_CLIENT_ENDPOINT =
  backgroundGlobal.ApiConfig?.DEV_CONFIG?.CLIENT_BASE_URL ||
  DEFAULT_PROD_CLIENT_ENDPOINT;
const STORAGE_ENDPOINT_KEY = "wsEndpoint";
const STORAGE_ENDPOINT_CUSTOM_KEY = "wsEndpointCustom";
const STORAGE_DEV_MODE_KEY = "devMode";
const STORAGE_DEV_WS_BASE_URL_KEY = "devWsBaseUrl";
const STORAGE_WS_BASE_URL_KEY = "wsBaseUrl";
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 10000;

// 从配置文件获取 URL（如果配置文件加载失败，保持为空，避免误发到真实第三方服务）
const FEISHU_WEBHOOK_URL =
  backgroundGlobal.ApiConfig?.PROD_CONFIG?.FEISHU_WEBHOOK_URL || "";
const textEncoder = new TextEncoder();

const CLIENT_SOURCE = "yishe-extension";
const CLIENT_INFO_QUERY_KEY = "clientInfo";
const CLIENT_SOURCE_QUERY_KEY = "clientSource";
const CLIENT_VERSION_QUERY_KEY = "extensionVersion";
const CLIENT_ID_QUERY_KEY = "clientId";
const LOCATION_CACHE_KEY = "wsLocationCache";
const LOCATION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const LOCATION_ENDPOINT =
  backgroundGlobal.ApiConfig?.PROD_CONFIG?.LOCATION_ENDPOINT ||
  "https://ipapi.co/json/";
const AUTH_TOKEN_KEY = "accessToken";
const AUTH_USER_INFO_KEY = "userInfo";
const CLIENT_AUTH_SESSION_PATH =
  backgroundGlobal.ApiConfig?.CLIENT_ENDPOINTS?.AUTH_SESSION ||
  "/api/auth/session";
const EXTENSION_LOGIN_REQUIRED_MESSAGE = "请先登录扩展账号";
const LOCAL_CLIENT_LOGIN_REQUIRED_MESSAGE = "请先登录并启动本地客户端";
const LOCAL_CLIENT_ACCOUNT_REQUIRED_MESSAGE = "本地客户端未返回当前账号";
const LOCAL_CLIENT_ACCOUNT_MISMATCH_MESSAGE = "本地客户端账号与扩展账号不一致";

// 派生本地服务密钥 — 从 Electron 客户端获取（需要客户端已登录）
let cachedLocalSecret: string | null = null;
async function getLocalServiceSecret(): Promise<string> {
  if (cachedLocalSecret) return cachedLocalSecret;
  try {
    const clientBaseUrl = await getEffectiveClientBaseUrl();
    const res = await fetch(`${clientBaseUrl}/api/client-secret`, {
      cache: "no-store",
    });
    const data = await res.json();
    if (data.secret) {
      cachedLocalSecret = data.secret;
      return data.secret;
    }
  } catch {}
  return "";
}

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
let clientWsEndpoint = DEFAULT_PROD_CLIENT_ENDPOINT;

// 对「服务端 WebSocket」的最新状态快照
const wsState = {
  status: "disconnected",
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
  status: "disconnected",
  endpoint: clientWsEndpoint,
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
  console.log("[Core][WS]", ...args);
}

function getApiUtils() {
  return backgroundGlobal.ApiUtils || null;
}

async function apiRequestWithContext(url, options = {}) {
  const apiUtils = getApiUtils();
  if (!apiUtils?.apiRequest) {
    throw new Error("ApiUtils 不可用，请检查扩展后台模块是否已正确初始化");
  }
  return apiUtils.apiRequest(url, options);
}

async function getEffectiveClientBaseUrl() {
  const result = await storageGet([STORAGE_DEV_MODE_KEY]);
  return Boolean(result[STORAGE_DEV_MODE_KEY])
    ? DEFAULT_DEV_CLIENT_ENDPOINT
    : DEFAULT_PROD_CLIENT_ENDPOINT;
}

// =============================================================
// 二、错误序列化 & 通用工具
// =============================================================

function serializeError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
}

function normalizeServiceUrl(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isOpenSourcePlaceholderUrl(value) {
  const normalized = normalizeServiceUrl(value).toLowerCase();
  return !normalized || normalized.includes("example.invalid");
}

function getWebsocketConfigError(endpoint) {
  const normalized = normalizeServiceUrl(endpoint);
  if (!normalized) {
    return "远程 WebSocket 地址未配置，请先填写真实服务地址";
  }
  if (isOpenSourcePlaceholderUrl(normalized)) {
    return "当前远程 WebSocket 仍是开源默认占位地址，请先替换为真实服务地址";
  }
  return "";
}

// guessExtension 和 uploadMaterialToServer 已迁移到 handlers/base.js
// 以下函数保留用于兼容性，但建议使用 handlers 中的实现

function guessExtension(url, contentType) {
  // 如果有 handlers 可用，使用 handlers 中的实现
  if (backgroundGlobal.MessageHandlers?.Base?.guessExtension) {
    return backgroundGlobal.MessageHandlers.Base.guessExtension(
      url,
      contentType,
    );
  }
  // Fallback 实现
  const fromUrl = (() => {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(avif|webp|png|jpg|jpeg|gif|svg)$/i);
      return match ? `.${match[1].toLowerCase()}` : "";
    } catch (_) {
      return "";
    }
  })();
  if (fromUrl) return fromUrl;
  if (!contentType) return ".jpg";
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/gif")) return ".gif";
  if (contentType.includes("image/svg")) return ".svg";
  if (contentType.includes("image/avif")) return ".avif";
  return ".jpg";
}

async function sendFeishuNotification(lines) {
  if (!FEISHU_WEBHOOK_URL) {
    return;
  }
  const payload = {
    msg_type: "text",
    content: {
      text: lines.join("\n"),
    },
  };
  await fetch(FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error) => {
    log("发送飞书通知失败:", serializeError(error));
  });
}

// =============================================================
// 上传状态跟踪（防止重复提交）
// =============================================================

// 正在上传的图片集合，用于防止重复提交
const uploadingImages = new Set();
const uploadingFiles = new Set();

function buildImageUploadKey(imageUrl, target) {
  const normalizedUrl = String(imageUrl || "").trim();
  const normalizedTarget = String(target || "sticker").trim();
  return `${normalizedTarget}::${normalizedUrl}`;
}

/**
 * 检查图片是否正在上传
 * @param {string} imageUrl - 图片URL
 * @returns {boolean} - 是否正在上传
 */
function isImageUploading(imageUrl, target) {
  return uploadingImages.has(buildImageUploadKey(imageUrl, target));
}

/**
 * 标记图片开始上传
 * @param {string} imageUrl - 图片URL
 */
function markImageUploading(imageUrl, target) {
  uploadingImages.add(buildImageUploadKey(imageUrl, target));
}

/**
 * 标记图片上传完成（成功或失败）
 * @param {string} imageUrl - 图片URL
 */
function markImageUploadComplete(imageUrl, target) {
  uploadingImages.delete(buildImageUploadKey(imageUrl, target));
}

function normalizeUploadUrl(value) {
  return String(value || "").trim();
}

function isFileUploading(fileUrl) {
  return uploadingFiles.has(normalizeUploadUrl(fileUrl));
}

function markFileUploading(fileUrl) {
  uploadingFiles.add(normalizeUploadUrl(fileUrl));
}

function markFileUploadComplete(fileUrl) {
  uploadingFiles.delete(normalizeUploadUrl(fileUrl));
}

// =============================================================
// 通用 UI 工具函数（Loading 和 Toast）
// =============================================================

const tabBadgeTimers = new Map();

function clearTabBadge(tabId) {
  if (tabId == null) return;

  const timer = tabBadgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    tabBadgeTimers.delete(tabId);
  }

  try {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setTitle({ tabId, title: "YiShe 工具集" });
  } catch (error) {
    // 静默忽略 badge 设置失败
  }
}

function setTabBadge(tabId, text, color, title, duration) {
  if (tabId == null) return;

  const timer = tabBadgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    tabBadgeTimers.delete(tabId);
  }

  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setTitle({ tabId, title: title || "YiShe 工具集" });
  } catch (error) {
    // 静默忽略 badge 设置失败
  }

  if (duration && duration > 0) {
    const timeoutId = setTimeout(() => {
      clearTabBadge(tabId);
    }, duration);
    tabBadgeTimers.set(tabId, timeoutId);
  }
}

function syncBadgeWithLoading(tabId, action, message) {
  if (action === "show") {
    setTabBadge(tabId, "...", "#2563eb", message || "处理中...");
    return;
  }

  clearTabBadge(tabId);
}

function syncBadgeWithToast(tabId, level, message, duration) {
  const badgeMap = {
    success: { text: "OK", color: "#16a34a" },
    error: { text: "ERR", color: "#dc2626" },
    warning: { text: "!", color: "#d97706" },
    info: { text: "...", color: "#2563eb" },
  };

  const badgeMeta = badgeMap[level] || badgeMap.info;
  setTabBadge(
    tabId,
    badgeMeta.text,
    badgeMeta.color,
    message || "YiShe 工具集",
    typeof duration === "number" ? duration : 3200,
  );
}

function injectTabUiFallback(tabId, payload) {
  if (tabId == null) return;

  try {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (uiPayload) => {
          const doc = document;
          const host = doc.body || doc.documentElement;
          if (!host) return;

          if (uiPayload.type === "core:toast" && window.CoreToast?.show) {
            window.CoreToast.show({
              message: uiPayload.message || "",
              type: uiPayload.level || "info",
              duration: uiPayload.duration,
            });
            return;
          }

          if (uiPayload.type === "core:loading" && window.CoreLoading) {
            if (uiPayload.action === "show") {
              window.CoreLoading.show(uiPayload.message || "处理中...");
            } else {
              window.CoreLoading.hide();
            }
            return;
          }

          const STYLE_ID = "yishe-fallback-ui-style";
          const TOAST_ROOT_ID = "yishe-fallback-toast-root";
          const LOADING_ROOT_ID = "yishe-fallback-loading-root";

          if (!doc.getElementById(STYLE_ID)) {
            const style = doc.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
            #${TOAST_ROOT_ID} {
              position: fixed;
              top: 16px;
              right: 16px;
              z-index: 2147483647;
              display: flex;
              flex-direction: column;
              gap: 10px;
              pointer-events: none;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }

            .yishe-fallback-toast {
              min-width: 240px;
              max-width: 360px;
              padding: 12px 14px;
              border-radius: 12px;
              color: #fff;
              font-size: 13px;
              line-height: 1.5;
              box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
              backdrop-filter: blur(10px);
              background: rgba(15, 23, 42, 0.94);
              border: 1px solid rgba(255, 255, 255, 0.08);
              pointer-events: auto;
            }

            .yishe-fallback-toast-info { border-left: 4px solid #3b82f6; }
            .yishe-fallback-toast-success { border-left: 4px solid #22c55e; }
            .yishe-fallback-toast-warning { border-left: 4px solid #f59e0b; }
            .yishe-fallback-toast-error { border-left: 4px solid #ef4444; }

            #${LOADING_ROOT_ID} {
              position: fixed;
              inset: 0;
              z-index: 2147483646;
              display: none;
              align-items: center;
              justify-content: center;
              background: rgba(0, 0, 0, 0.35);
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }

            #${LOADING_ROOT_ID}.is-visible {
              display: flex;
            }

            .yishe-fallback-loading-card {
              display: flex;
              align-items: center;
              gap: 12px;
              min-width: 220px;
              max-width: 360px;
              padding: 16px 18px;
              border-radius: 14px;
              background: rgba(15, 23, 42, 0.96);
              color: #fff;
              box-shadow: 0 20px 50px rgba(0, 0, 0, 0.32);
              border: 1px solid rgba(255, 255, 255, 0.08);
            }

            .yishe-fallback-loading-spinner {
              width: 22px;
              height: 22px;
              border-radius: 50%;
              border: 2px solid rgba(148, 163, 184, 0.22);
              border-top-color: #60a5fa;
              animation: yishe-fallback-spin 0.8s linear infinite;
              flex-shrink: 0;
            }

            .yishe-fallback-loading-text {
              font-size: 13px;
              line-height: 1.5;
            }

            @keyframes yishe-fallback-spin {
              to { transform: rotate(360deg); }
            }
          `;
            (doc.head || host).appendChild(style);
          }

          function ensureToastRoot() {
            let root = doc.getElementById(TOAST_ROOT_ID);
            if (!root) {
              root = doc.createElement("div");
              root.id = TOAST_ROOT_ID;
              host.appendChild(root);
            }
            return root;
          }

          function ensureLoadingRoot() {
            let root = doc.getElementById(LOADING_ROOT_ID);
            if (!root) {
              root = doc.createElement("div");
              root.id = LOADING_ROOT_ID;
              root.innerHTML = `
              <div class="yishe-fallback-loading-card">
                <div class="yishe-fallback-loading-spinner"></div>
                <div class="yishe-fallback-loading-text">处理中...</div>
              </div>
            `;
              host.appendChild(root);
            }
            return root;
          }

          if (uiPayload.type === "core:loading") {
            const root = ensureLoadingRoot();
            const textEl = root.querySelector(".yishe-fallback-loading-text");
            if (uiPayload.action === "show") {
              if (textEl) {
                textEl.textContent = uiPayload.message || "处理中...";
              }
              root.classList.add("is-visible");
            } else {
              root.classList.remove("is-visible");
            }
            return;
          }

          if (uiPayload.type === "core:toast" && uiPayload.message) {
            const root = ensureToastRoot();
            const toast = doc.createElement("div");
            toast.className = `yishe-fallback-toast yishe-fallback-toast-${uiPayload.level || "info"}`;
            toast.textContent = uiPayload.message;
            root.appendChild(toast);
            const delay =
              typeof uiPayload.duration === "number"
                ? uiPayload.duration
                : 3200;
            setTimeout(() => {
              if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
              }
            }, delay);
          }
        },
        args: [payload],
      },
      () => {
        if (chrome.runtime.lastError) {
          // 静默忽略 fallback 注入失败
        }
      },
    );
  } catch (error) {
    // 静默忽略 fallback 注入失败
  }
}

function dispatchTabUiMessage(tabId, payload) {
  if (tabId == null) return;

  chrome.tabs.sendMessage(tabId, payload, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      injectTabUiFallback(tabId, payload);
    }
  });
}

/**
 * 显示或隐藏 Loading 蒙层
 * @param {number|null} tabId - 标签页 ID，如果为 null 则不发送消息
 * @param {string} action - 'show' 或 'hide'
 * @param {string} [message] - Loading 时显示的消息
 */
function showLoading(tabId, action = "show", message = "处理中...") {
  if (tabId == null) return;

  syncBadgeWithLoading(tabId, action, message);
  dispatchTabUiMessage(tabId, {
    type: "core:loading",
    action: action,
    message: action === "show" ? message : undefined,
  });
}

/**
 * 显示 Toast 消息提示
 * @param {number|null} tabId - 标签页 ID，如果为 null 则不发送消息
 * @param {string} level - 'success' | 'error' | 'warning' | 'info'
 * @param {string} message - 提示消息
 * @param {number} [duration] - 显示时长（毫秒），默认使用系统默认值
 */
function showToast(tabId, level, message, duration) {
  if (tabId == null || !message) return;

  syncBadgeWithToast(tabId, level, message, duration);
  dispatchTabUiMessage(tabId, {
    type: "core:toast",
    level: level,
    message: message,
    duration: duration,
  });
}

/**
 * 从标签页对象中获取 tabId
 * @param {Object|null|undefined} tab - 标签页对象
 * @returns {number|null} - 标签页 ID
 */
function getTabId(tab) {
  return tab && tab.id != null ? tab.id : null;
}

/**
 * 解析 API 错误响应，提取错误消息
 * @param {Object} responseData - API 响应数据
 * @param {number} statusCode - HTTP 状态码
 * @param {string} defaultMessage - 默认错误消息
 * @returns {string} - 解析后的错误消息
 */
function parseErrorMessage(
  responseData,
  statusCode,
  defaultMessage = "操作失败",
) {
  if (responseData.message) {
    if (Array.isArray(responseData.message)) {
      return responseData.message.join(", ");
    } else if (typeof responseData.message === "string") {
      return responseData.message;
    }
  } else if (responseData.msg) {
    if (Array.isArray(responseData.msg)) {
      return responseData.msg.join(", ");
    } else if (typeof responseData.msg === "string") {
      return responseData.msg;
    }
  }
  return `${defaultMessage}: HTTP ${statusCode}`;
}

/**
 * 保存网站信息到服务端
 * @param {Object} websiteData - 网站数据
 * @param {string} websiteData.url - 网站URL
 * @param {string} websiteData.name - 网站名称
 * @param {string} [websiteData.description] - 网站描述
 * @param {string} [websiteData.icon] - 网站图标
 * @param {string} [websiteData.category] - 网站分类
 * @param {Object} tab - 标签页对象
 */
async function saveWebsiteToServer(websiteData, tab) {
  const tabId = getTabId(tab);

  try {
    const authState = await storageGet([AUTH_TOKEN_KEY, AUTH_USER_INFO_KEY]);
    const token = authState[AUTH_TOKEN_KEY];
    const userInfo = authState[AUTH_USER_INFO_KEY];

    if (!token || !userInfo) {
      showLoading(tabId, "hide");
      showToast(tabId, "error", "请先登录后再保存网站");
      throw new Error("请先登录后再保存网站");
    }

    const createPath =
      backgroundGlobal.ApiConfig?.API_ENDPOINTS?.COMMON_URL?.CREATE ||
      "/common-url";
    const requestData = {
      url: websiteData.url,
      name: websiteData.name || new URL(websiteData.url).hostname,
      description: websiteData.description || "",
      icon: websiteData.icon || "",
      category: websiteData.category || "收藏",
      isActive: true,
      sort: 0,
    };

    log("[SaveWebsite] 准备保存网站:", requestData);

    const responseData = await apiRequestWithContext(createPath, {
      method: "POST",
      body: JSON.stringify(requestData),
    });

    log("[SaveWebsite] 网站保存成功:", responseData);
    showLoading(tabId, "hide");
    showToast(tabId, "success", "网站已保存到 YiShe");

    return responseData;
  } catch (error) {
    log("[SaveWebsite] 保存网站异常:", serializeError(error));
    showLoading(tabId, "hide");
    showToast(tabId, "error", error.message || "保存网站失败，请稍后重试");
    throw error;
  }
}

/**
 * 保存文字信息到服务端（文案管理）
 * @param {Object} textData - 文字数据
 * @param {string} textData.content - 文字内容（必需）
 * @param {string} [textData.description] - 文字描述
 * @param {string} [textData.keywords] - 关键词
 * @param {Object} tab - 标签页对象
 */
async function saveTextToServer(textData, tab) {
  const tabId = getTabId(tab);

  try {
    const authState = await storageGet([AUTH_TOKEN_KEY, AUTH_USER_INFO_KEY]);
    const token = authState[AUTH_TOKEN_KEY];
    const userInfo = authState[AUTH_USER_INFO_KEY];

    if (!token || !userInfo) {
      showLoading(tabId, "hide");
      showToast(tabId, "error", "请先登录后再保存文字");
      throw new Error("请先登录后再保存文字");
    }

    const createPath =
      backgroundGlobal.ApiConfig?.API_ENDPOINTS?.SENTENCE?.CREATE ||
      "/sentences";

    const requestData = {
      content: textData.content || "",
      description: textData.description || "",
      keywords: textData.keywords || "",
    };

    // 验证内容不能为空
    if (!requestData.content || requestData.content.trim().length === 0) {
      throw new Error("文字内容不能为空");
    }

    log("[SaveText] 准备保存文字:", {
      content:
        requestData.content.substring(0, 50) +
        (requestData.content.length > 50 ? "..." : ""),
      description: requestData.description,
      keywords: requestData.keywords,
    });

    const responseData = await apiRequestWithContext(createPath, {
      method: "POST",
      body: JSON.stringify(requestData),
    });

    log("[SaveText] 文字保存成功:", responseData);
    showLoading(tabId, "hide");
    showToast(tabId, "success", "文字已保存到 YiShe 文案管理");

    return responseData;
  } catch (error) {
    log("[SaveText] 保存文字异常:", serializeError(error));
    showLoading(tabId, "hide");
    showToast(tabId, "error", error.message || "保存文字失败，请稍后重试");
    throw error;
  }
}

async function handleControlFeatureExecute(request) {
  const featureId = request?.featureId;
  const payload = request?.payload || {};

  return { success: false, error: "未识别的功能组件" };
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

function normalizeIdentityValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().toLowerCase();
}

function pickNormalizedIdentityValue(source, keys) {
  if (!source || typeof source !== "object") {
    return "";
  }

  for (const key of keys) {
    const normalized = normalizeIdentityValue(source[key]);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function buildSessionIdentity(userInfo) {
  const source = userInfo && typeof userInfo === "object" ? userInfo : {};
  return {
    userId: pickNormalizedIdentityValue(source, ["id", "userId"]),
    account: pickNormalizedIdentityValue(source, ["account", "username"]),
    displayName:
      String(
        source.account ||
          source.username ||
          source.name ||
          source.nickname ||
          source.id ||
          "",
      ).trim() || "当前账号",
  };
}

async function getAuthenticatedExtensionSession() {
  const authState = await storageGet([AUTH_TOKEN_KEY, AUTH_USER_INFO_KEY]);
  const token = authState[AUTH_TOKEN_KEY];
  const userInfo = authState[AUTH_USER_INFO_KEY];

  if (!token || !userInfo) {
    return null;
  }

  return {
    token,
    userInfo,
    identity: buildSessionIdentity(userInfo),
  };
}

async function fetchLocalClientSession() {
  const clientBaseUrl = await getEffectiveClientBaseUrl();
  const sessionUrl = `${clientBaseUrl}${CLIENT_AUTH_SESSION_PATH}`;

  try {
    const response = await fetch(sessionUrl, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `HTTP ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const user =
      payload?.user && typeof payload.user === "object" ? payload.user : {};

    return {
      ok: true,
      endpoint: sessionUrl,
      authorized: Boolean(payload?.authorized || payload?.isAuthorized),
      userId: pickNormalizedIdentityValue(user, ["id", "userId"]),
      account: pickNormalizedIdentityValue(user, ["account", "username"]),
      displayName:
        String(
          user.account ||
            user.username ||
            user.name ||
            user.nickname ||
            user.id ||
            "",
        ).trim() || null,
      raw: payload,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: sessionUrl,
      authorized: false,
      error: serializeError(error),
    };
  }
}

function isSameSessionIdentity(extensionIdentity, clientSession) {
  if (extensionIdentity?.userId && clientSession?.userId) {
    return extensionIdentity.userId === clientSession.userId;
  }

  if (extensionIdentity?.account && clientSession?.account) {
    return extensionIdentity.account === clientSession.account;
  }

  return false;
}

async function ensureClientConnectionAllowed(context = "manual") {
  const extensionSession = await getAuthenticatedExtensionSession();
  if (!extensionSession) {
    return {
      allowed: false,
      reason: EXTENSION_LOGIN_REQUIRED_MESSAGE,
    };
  }

  const clientSession = await fetchLocalClientSession();
  if (!clientSession.ok) {
    log(`[ClientWS] ${context}: 本地客户端会话查询失败`, clientSession.error);
    return {
      allowed: false,
      reason: LOCAL_CLIENT_LOGIN_REQUIRED_MESSAGE,
    };
  }

  if (!clientSession.authorized) {
    return {
      allowed: false,
      reason: LOCAL_CLIENT_LOGIN_REQUIRED_MESSAGE,
    };
  }

  if (!clientSession.userId && !clientSession.account) {
    return {
      allowed: false,
      reason: LOCAL_CLIENT_ACCOUNT_REQUIRED_MESSAGE,
    };
  }

  if (!isSameSessionIdentity(extensionSession.identity, clientSession)) {
    return {
      allowed: false,
      reason: LOCAL_CLIENT_ACCOUNT_MISMATCH_MESSAGE,
    };
  }

  return {
    allowed: true,
    extensionSession,
    clientSession,
  };
}

async function ensureClientIdentifier() {
  try {
    const { clientId } = await storageGet([CLIENT_ID_QUERY_KEY]);
    if (clientId) {
      return clientId;
    }
    const generatedId =
      self.crypto && self.crypto.randomUUID
        ? self.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await storageSet({ [CLIENT_ID_QUERY_KEY]: generatedId });
    return generatedId;
  } catch (error) {
    log("生成 clientId 失败，使用临时 ID", serializeError(error));
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
        log("获取平台信息失败:", chrome.runtime.lastError.message);
        resolve(undefined);
      } else {
        resolve(info);
      }
    });
  });
}

function parseBrowserInfo(userAgent) {
  if (!userAgent || typeof userAgent !== "string") {
    return undefined;
  }

  const browserMatchers = [
    { name: "Edge", regex: /Edg\/([\d.]+)/ },
    { name: "Chrome", regex: /Chrome\/([\d.]+)/ },
    { name: "Firefox", regex: /Firefox\/([\d.]+)/ },
    { name: "Safari", regex: /Version\/([\d.]+).*Safari/ },
    { name: "Opera", regex: /OPR\/([\d.]+)/ },
  ];

  for (const matcher of browserMatchers) {
    const match = userAgent.match(matcher.regex);
    if (match) {
      return {
        name: matcher.name,
        version: match[1],
      };
    }
  }

  return {
    name: "Unknown",
    version: undefined,
  };
}

function parseOsInfo(userAgent) {
  if (!userAgent || typeof userAgent !== "string") {
    return undefined;
  }

  const osMatchers = [
    { name: "Windows", regex: /Windows NT ([\d.]+)/ },
    { name: "macOS", regex: /Mac OS X ([\d_]+)/ },
    { name: "iOS", regex: /iPhone OS ([\d_]+)/ },
    { name: "Android", regex: /Android ([\d.]+)/ },
    { name: "Linux", regex: /Linux/ },
  ];

  for (const matcher of osMatchers) {
    const match = userAgent.match(matcher.regex);
    if (match) {
      return {
        name: matcher.name,
        version: match[1]?.replace(/_/g, "."),
      };
    }
  }

  return {
    name: "Unknown",
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
      ensureClientIdentifier(),
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
        log("获取时区失败:", serializeError(error));
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
      log("收集客户端信息失败:", serializeError(error));
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
    log("克隆客户端信息失败:", serializeError(error));
    return null;
  }
}

function buildConnectionClientInfo(metadata) {
  return cloneMetadata(metadata);
}

function buildConnectionQuery(metadata) {
  const query = {
    [CLIENT_SOURCE_QUERY_KEY]: CLIENT_SOURCE,
  };

  if (metadata?.extension?.version) {
    query[CLIENT_VERSION_QUERY_KEY] = metadata.extension.version;
  }
  if (metadata?.clientId) {
    query[CLIENT_ID_QUERY_KEY] = metadata.clientId;
  }

  const entries = Object.entries(query).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );

  return entries.reduce((acc, [key, value]) => {
    acc[key] = String(value);
    return acc;
  }, {});
}

function buildConnectionAuth(token, metadata) {
  const auth = {};

  if (token) {
    auth.token = token;
  }

  if (metadata) {
    auth.clientInfo = metadata;
  }

  return Object.keys(auth).length ? auth : undefined;
}

function emitClientInfo(extraPayload) {
  if (!clientMetadata || !socket || !socket.connected) {
    return;
  }
  const payload = extraPayload
    ? { ...clientMetadata, ...extraPayload }
    : clientMetadata;
  try {
    socket.emit("client-info", payload);
  } catch (error) {
    log("发送客户端信息失败:", serializeError(error));
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
    log("获取位置信息失败:", serializeError(error));
  }
}

async function ensureLocationInfo() {
  try {
    const cache = await storageGet([LOCATION_CACHE_KEY]);
    const cachedEntry = cache?.[LOCATION_CACHE_KEY];
    const now = Date.now();
    if (
      cachedEntry &&
      cachedEntry.timestamp &&
      now - cachedEntry.timestamp < LOCATION_CACHE_TTL
    ) {
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
        log("缓存位置信息失败:", serializeError(error));
      });
    }
    return location;
  } catch (error) {
    log("ensureLocationInfo 出错:", serializeError(error));
    return undefined;
  }
}

async function fetchClientLocation() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(LOCATION_ENDPOINT, {
      method: "GET",
      cache: "no-store",
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
    if (error?.name === "AbortError") {
      log("请求位置信息超时");
    } else {
      log("请求位置信息失败:", serializeError(error));
    }
    return undefined;
  }
}

function broadcastWsState() {
  const snapshot = { ...wsState };

  chrome.storage.local.set({ wsStatus: snapshot }, () => {
    if (chrome.runtime.lastError) {
      log("存储 WebSocket 状态失败:", chrome.runtime.lastError.message);
    }
  });

  chrome.runtime.sendMessage(
    { type: "wsStatus:update", payload: snapshot },
    () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Receiving end does not exist.")) {
        log("广播 WebSocket 状态失败:", err.message);
      }
    },
  );
}

function broadcastClientWsState() {
  const snapshot = { ...clientWsState };

  chrome.storage.local.set({ clientWsStatus: snapshot }, () => {
    if (chrome.runtime.lastError) {
      log("存储客户端 WebSocket 状态失败:", chrome.runtime.lastError.message);
    }
  });

  chrome.runtime.sendMessage(
    { type: "clientWsStatus:update", payload: snapshot },
    () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Receiving end does not exist.")) {
        log("广播客户端 WebSocket 状态失败:", err.message);
      }
    },
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
    log("[ClientWS] 心跳超时，准备重连");
    updateClientWsState({
      status: "error",
      lastError: "Heartbeat timeout",
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
  clientSocket.emit("ping");
  scheduleClientHeartbeatTimeout();
}

function startClientHeartbeatLoop() {
  stopClientHeartbeatTimers();
  clientHeartbeatTimer = setInterval(sendClientHeartbeat, HEARTBEAT_INTERVAL);
  sendClientHeartbeat();
}

function updateClientWsState(patch) {
  Object.assign(clientWsState, patch, { endpoint: clientWsEndpoint });
  broadcastClientWsState();
}

function disconnectClientWebsocket(reason) {
  stopClientHeartbeatTimers();
  cleanupClientSocket();
  updateClientWsState({
    status: "disconnected",
    connectedAt: null,
    lastError: reason || null,
    retryCount: 0,
  });
}

function disconnectWebsocket(reason) {
  stopHeartbeatTimers();
  cleanupSocket();
  updateWsState({
    status: "disconnected",
    connectedAt: null,
    lastError: reason || null,
    retryCount: 0,
  });
}

function scheduleHeartbeatTimeout() {
  clearHeartbeatTimeout();
  heartbeatTimeoutTimer = setTimeout(() => {
    log("心跳超时，准备重连");
    updateWsState({
      status: "error",
      lastError: "Heartbeat timeout",
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
  socket.emit("ping");
  scheduleHeartbeatTimeout();
}

function startHeartbeatLoop() {
  stopHeartbeatTimers();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  sendHeartbeat();
}

async function initWebsocket() {
  if (!scriptsLoaded.socketio || typeof io === "undefined") {
    const errorMsg =
      scriptsLoaded.error ||
      "socket.io client 不可用，请确保 socket.io.min.js 已正确导入";
    log("Socket.IO 初始化失败:", errorMsg);
    updateWsState({
      status: "error",
      lastError: errorMsg,
    });
    return;
  }

  const normalizedEndpoint = normalizeServiceUrl(wsEndpoint);
  const endpointConfigError = getWebsocketConfigError(normalizedEndpoint);
  if (endpointConfigError) {
    wsEndpoint = normalizedEndpoint;
    log("跳过远程 WebSocket 连接:", endpointConfigError);
    updateWsState({
      status: "error",
      lastError: endpointConfigError,
      retryCount: 0,
    });
    return;
  }

  const [metadata, authState] = await Promise.all([
    ensureClientMetadata(),
    storageGet([AUTH_TOKEN_KEY]),
  ]);
  const token = authState[AUTH_TOKEN_KEY];
  const connectionClientInfo = buildConnectionClientInfo(metadata);
  const query = buildConnectionQuery(connectionClientInfo);
  const auth = buildConnectionAuth(token, connectionClientInfo);
  if (connectionClientInfo) {
    clientMetadata = connectionClientInfo;
    updateWsState({ clientInfo: cloneMetadata(connectionClientInfo) });
  }

  stopHeartbeatTimers();
  cleanupSocket();

  updateWsState({
    status: "connecting",
    lastError: null,
    retryCount: 0,
  });

  wsEndpoint = normalizedEndpoint;
  log("开始连接到 WebSocket:", wsEndpoint);

  socket = io(wsEndpoint, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    timeout: 8000,
    query,
    auth,
  });

  socket.on("connect", () => {
    log("WebSocket 已连接");
    lastPingTimestampMs = null;
    updateWsState({
      status: "connected",
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

  socket.io.on("reconnect_attempt", (attempt) => {
    log("正在尝试重连", attempt);
    updateWsState({
      status: "reconnecting",
      retryCount: attempt,
    });
  });

  socket.io.on("reconnect_failed", () => {
    log("重连失败");
    updateWsState({
      status: "error",
      lastError: "Reconnect failed",
    });
  });

  socket.io.on("reconnect_error", (error) => {
    const message = serializeError(error);
    log("重连错误", message);
    updateWsState({
      status: "error",
      lastError: message,
    });
  });

  socket.on("disconnect", (reason) => {
    log("WebSocket 已断开", reason);
    stopHeartbeatTimers();
    updateWsState({
      status: "disconnected",
      connectedAt: null,
      lastError: reason || null,
    });
  });

  socket.on("connect_error", (error) => {
    const message = serializeError(error);
    log("连接错误", message);
    updateWsState({
      status: "error",
      lastError: message,
    });
  });

  socket.on("error", (error) => {
    const message = serializeError(error);
    log("Socket 错误", message);
    updateWsState({
      status: "error",
      lastError: message,
    });
  });

  socket.on("pong", (payload) => {
    clearHeartbeatTimeout();
    const now = Date.now();
    const latency = lastPingTimestampMs ? now - lastPingTimestampMs : null;
    lastPingTimestampMs = null;
    updateWsState({
      status: "connected",
      lastPongAt: new Date(now).toISOString(),
      lastLatencyMs: latency,
      lastError: null,
      lastPayload: payload || null,
    });
  });

  // 监听来自管理系统的消息
  socket.on("admin-message", (data) => {
    log("[admin-message] 收到管理员消息事件");
    log("[admin-message] 消息数据:", data);
    log("[admin-message] 消息数据类型:", typeof data);
    log("[admin-message] 消息数据是否为对象:", typeof data === "object");
    if (typeof data === "object" && data !== null) {
      log("[admin-message] 消息数据键:", Object.keys(data));
    }
    handleAdminMessage(data);
  });

  // 监听所有其他消息事件（用于调试）
  socket.onAny((event, ...args) => {
    log(`[onAny] 收到事件: ${event}`, args);
    if (event === "admin-message") {
      log("[onAny] admin-message 事件数据:", args);
    }
  });
}

async function connectWebsocketIfAuthenticated(context = "manual") {
  const hasSession = await hasAuthenticatedSession();
  if (!hasSession) {
    log(`[WS] ${context}: 未检测到登录信息，暂不建立连接`);
    disconnectWebsocket(EXTENSION_LOGIN_REQUIRED_MESSAGE);
    return false;
  }

  if (socket && socket.connected) {
    log(`[WS] ${context}: WebSocket 已连接，跳过重复连接`);
    return true;
  }

  if (wsState.status === "connecting" || wsState.status === "reconnecting") {
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
  if (!scriptsLoaded.socketio || typeof io === "undefined") {
    const errorMsg =
      scriptsLoaded.error ||
      "socket.io client 不可用，请确保 socket.io.min.js 已正确导入";
    log("[ClientWS] Socket.IO 初始化失败:", errorMsg);
    updateClientWsState({
      status: "error",
      lastError: errorMsg,
    });
    return;
  }

  clientWsEndpoint = await getEffectiveClientBaseUrl();
  stopClientHeartbeatTimers();
  cleanupClientSocket();

  updateClientWsState({
    status: "connecting",
    lastError: null,
    retryCount: 0,
  });

  log("[ClientWS] 开始连接到本地客户端 WebSocket:", clientWsEndpoint);

  // 获取客户端元数据
  const metadata = await ensureClientMetadata();
  const query = {
    clientSource: CLIENT_SOURCE,
    clientId: metadata?.clientId || `ext_${Date.now()}`,
  };

  try {
    query[CLIENT_INFO_QUERY_KEY] = JSON.stringify(metadata);
  } catch (e) {
    log("[ClientWS] 序列化客户端信息失败:", e);
  }

  clientSocket = io(clientWsEndpoint, {
    path: "/ws",
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 12000,
    timeout: 8000,
    query,
  });

  clientSocket.on("connect", () => {
    log("[ClientWS] 本地客户端 WebSocket 已连接");
    clientLastPingTimestampMs = null;
    updateClientWsState({
      status: "connected",
      connectedAt: new Date().toISOString(),
      lastError: null,
      lastLatencyMs: null,
      retryCount: 0,
    });
    startClientHeartbeatLoop();
  });

  clientSocket.io.on("reconnect_attempt", (attempt) => {
    log("[ClientWS] 正在尝试重连", attempt);
    updateClientWsState({
      status: "reconnecting",
      retryCount: attempt,
    });
  });

  clientSocket.io.on("reconnect_failed", () => {
    log("[ClientWS] 重连失败");
    updateClientWsState({
      status: "error",
      lastError: "Reconnect failed",
    });
  });

  clientSocket.io.on("reconnect_error", (error) => {
    const message = serializeError(error);
    log("[ClientWS] 重连错误", message);
    updateClientWsState({
      status: "error",
      lastError: message,
    });
  });

  clientSocket.on("disconnect", (reason) => {
    log("[ClientWS] 本地客户端 WebSocket 已断开", reason);
    stopClientHeartbeatTimers();
    updateClientWsState({
      status: "disconnected",
      connectedAt: null,
      lastError: reason || null,
    });
  });

  clientSocket.on("connect_error", (error) => {
    const message = serializeError(error);
    log("[ClientWS] 连接错误", message);
    updateClientWsState({
      status: "error",
      lastError: message,
    });
  });

  clientSocket.on("error", (error) => {
    const message = serializeError(error);
    log("[ClientWS] Socket 错误", message);
    updateClientWsState({
      status: "error",
      lastError: message,
    });
  });

  clientSocket.on("pong", (payload) => {
    clearClientHeartbeatTimeout();
    const now = Date.now();
    const latency = clientLastPingTimestampMs
      ? now - clientLastPingTimestampMs
      : null;
    clientLastPingTimestampMs = null;
    updateClientWsState({
      status: "connected",
      lastPongAt: new Date(now).toISOString(),
      lastLatencyMs: latency,
      lastError: null,
      lastPayload: payload || null,
    });
  });
}

async function connectClientWebsocket() {
  const access = await ensureClientConnectionAllowed("client-connect");
  if (!access.allowed) {
    log("[ClientWS] 连接前校验失败:", access.reason);
    disconnectClientWebsocket(access.reason);
    throw new Error(access.reason);
  }

  if (clientSocket && clientSocket.connected) {
    log("[ClientWS] 本地客户端 WebSocket 已连接，跳过重复连接");
    return true;
  }

  if (
    clientWsState.status === "connecting" ||
    clientWsState.status === "reconnecting"
  ) {
    log("[ClientWS] 本地客户端 WebSocket 正在连接中，跳过重复触发");
    return true;
  }

  if (clientWebsocketInitPromise) {
    log("[ClientWS] 已有连接任务进行中，等待完成");
    await clientWebsocketInitPromise;
    return true;
  }

  log("[ClientWS] 开始连接本地客户端 WebSocket");
  clientWebsocketInitPromise = initClientWebsocket()
    .catch((error) => {
      log("[ClientWS] 初始化本地客户端 WebSocket 失败", serializeError(error));
      throw error;
    })
    .finally(() => {
      clientWebsocketInitPromise = null;
    });

  await clientWebsocketInitPromise;
  return true;
}

async function forceReconnect(context = "manual") {
  try {
    log(`[WS] ${context}: 开始强制重连`);
    disconnectWebsocket(`force-reconnect:${context}`);
    await ensureEndpoint();
    const connected = await connectWebsocketIfAuthenticated(context);
    if (!connected) {
      throw new Error(EXTENSION_LOGIN_REQUIRED_MESSAGE);
    }
  } catch (error) {
    log(`[WS] ${context}: 强制重连失败`, serializeError(error));
    updateWsState({
      status: "error",
      lastError: serializeError(error),
    });
    throw error;
  }
}

function handleAdminMessage(data) {
  log("[handleAdminMessage] 开始处理管理员消息");
  log("[handleAdminMessage] 输入数据:", data);

  try {
    // 尝试通过消息路由器处理命令消息
    if (backgroundGlobal.MessageHandlers?.Router) {
      backgroundGlobal.MessageHandlers.Router.handle(data, {
        logFn: log,
        socket,
      })
        .then((result) => {
          if (result.handled) {
            log("[handleAdminMessage] 命令消息已处理:", result);
            return; // 命令消息不需要存储和通知
          }
          // 如果不是命令消息，继续处理为普通消息
        })
        .catch((error) => {
          log("[handleAdminMessage] 处理命令消息失败:", serializeError(error));
        });

      // 如果是命令消息，提前返回（不等待异步结果，避免阻塞）
      if (data && typeof data === "object" && data.command) {
        return;
      }
    }

    const messageData = {
      timestamp: new Date().toISOString(),
      data: data,
    };

    log("[handleAdminMessage] 构建的消息数据:", messageData);
    log("[handleAdminMessage] 时间戳:", messageData.timestamp);

    // 存储消息到 storage
    log("[handleAdminMessage] 开始读取现有消息...");
    chrome.storage.local.get(["adminMessages"], (result) => {
      log("[handleAdminMessage] 读取到的现有消息:", result);
      const messages = result.adminMessages || [];
      log("[handleAdminMessage] 现有消息数量:", messages.length);

      messages.unshift(messageData);
      log("[handleAdminMessage] 添加新消息后数量:", messages.length);

      // 只保留最近 50 条消息
      if (messages.length > 50) {
        messages.length = 50;
        log("[handleAdminMessage] 截断后消息数量:", messages.length);
      }

      log("[handleAdminMessage] 准备存储消息，数量:", messages.length);
      chrome.storage.local.set({ adminMessages: messages }, () => {
        if (chrome.runtime.lastError) {
          log(
            "[handleAdminMessage] 存储管理员消息失败:",
            chrome.runtime.lastError.message,
          );
        } else {
          log("[handleAdminMessage] 消息存储成功");
          // 验证存储
          chrome.storage.local.get(["adminMessages"], (verifyResult) => {
            log(
              "[handleAdminMessage] 验证存储结果，消息数量:",
              verifyResult.adminMessages?.length || 0,
            );
          });
        }
      });
    });

    // 发送通知给 popup 或其他监听者
    log("[handleAdminMessage] 准备发送消息通知给 popup...");
    chrome.runtime.sendMessage(
      {
        type: "adminMessage:received",
        payload: messageData,
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (err.message.includes("Receiving end does not exist.")) {
            log(
              "[handleAdminMessage] Popup 未打开，消息已存储，将在下次打开时显示",
            );
          } else {
            log("[handleAdminMessage] 广播管理员消息失败:", err.message);
          }
        } else {
          log("[handleAdminMessage] 消息通知发送成功，响应:", response);
        }
      },
    );

    // 显示浏览器通知（如果用户允许）
    if (chrome.notifications) {
      log("[handleAdminMessage] 准备创建浏览器通知...");
      const notificationId = `admin-message-${Date.now()}`;
      const messageText =
        typeof data === "string"
          ? data
          : data?.message || data?.text || JSON.stringify(data);

      log("[handleAdminMessage] 通知内容:", messageText);

      chrome.notifications.create(
        notificationId,
        {
          type: "basic",
          iconUrl: chrome.runtime.getURL("assets/logo.png") || "",
          title: "管理员消息",
          message:
            messageText.length > 100
              ? messageText.substring(0, 100) + "..."
              : messageText,
        },
        (createdId) => {
          if (chrome.runtime.lastError) {
            log(
              "[handleAdminMessage] 创建通知失败:",
              chrome.runtime.lastError.message,
            );
          } else {
            log("[handleAdminMessage] 通知创建成功，ID:", createdId);
          }
        },
      );
    } else {
      log("[handleAdminMessage] chrome.notifications 不可用");
    }

    log("[handleAdminMessage] 处理完成");
  } catch (error) {
    log("[handleAdminMessage] 处理管理员消息失败:", serializeError(error));
    log("[handleAdminMessage] 错误堆栈:", error?.stack);
  }
}

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
    const normalizedStoredEndpoint = normalizeServiceUrl(storedEndpoint);
    const isCustom = Boolean(
      result[STORAGE_ENDPOINT_CUSTOM_KEY] &&
      normalizedStoredEndpoint &&
      !isOpenSourcePlaceholderUrl(normalizedStoredEndpoint),
    );

    if (isCustom) {
      wsEndpoint = normalizedStoredEndpoint;
      log("使用自定义 WebSocket 端点:", wsEndpoint);
    } else {
      const devModeEnabled = Boolean(result[STORAGE_DEV_MODE_KEY]);
      const storedModeEndpoint = devModeEnabled
        ? result[STORAGE_DEV_WS_BASE_URL_KEY]
        : result[STORAGE_WS_BASE_URL_KEY];
      const normalizedModeEndpoint = normalizeServiceUrl(storedModeEndpoint);
      wsEndpoint = devModeEnabled
        ? normalizedModeEndpoint &&
          !isOpenSourcePlaceholderUrl(normalizedModeEndpoint)
          ? normalizedModeEndpoint
          : DEFAULT_DEV_WS_ENDPOINT
        : normalizedModeEndpoint &&
            !isOpenSourcePlaceholderUrl(normalizedModeEndpoint)
          ? normalizedModeEndpoint
          : DEFAULT_PROD_WS_ENDPOINT;
      log(
        `使用${devModeEnabled ? "开发" : "生产"} WebSocket 端点:`,
        wsEndpoint,
      );
      await storageSet({
        [STORAGE_ENDPOINT_KEY]: wsEndpoint,
        [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
      }).catch((error) => {
        log("写入默认端点失败（可忽略）:", serializeError(error));
      });
    }
  } catch (error) {
    log("确保端点时出错，使用默认端点:", serializeError(error));
    wsEndpoint = DEFAULT_PROD_WS_ENDPOINT;
    storageSet({
      [STORAGE_ENDPOINT_KEY]: wsEndpoint,
      [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
    }).catch((err) => {
      log("写入默认端点失败（可忽略）:", serializeError(err));
    });
  }

  updateWsState({ endpoint: wsEndpoint });
}

function setEndpoint(newEndpoint, callback) {
  const normalized = typeof newEndpoint === "string" ? newEndpoint.trim() : "";

  storageGet([STORAGE_DEV_MODE_KEY])
    .then((result) => {
      const devModeEnabled = Boolean(result[STORAGE_DEV_MODE_KEY]);
      const fallbackEndpoint = devModeEnabled
        ? DEFAULT_DEV_WS_ENDPOINT
        : DEFAULT_PROD_WS_ENDPOINT;
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
      log("WebSocket 端点已更新为:", wsEndpoint, "(custom:", isCustom, ")");
      if (socket) {
        log("端点变更，重新初始化连接");
      }
      connectWebsocketIfAuthenticated("update-endpoint").catch((error) => {
        log("[WS] update-endpoint: 重新连接失败", serializeError(error));
      });
      if (typeof callback === "function") {
        callback(null);
      }
    })
    .catch((error) => {
      log("设置端点失败:", serializeError(error));
      if (typeof callback === "function") {
        callback(error);
      }
    });
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
    const connected = await connectWebsocketIfAuthenticated("initialize");
    if (!connected) {
      log("[WS] initialize: 未登录，等待登录信息后再连接");
    }
    // 5. 初始化本地客户端连接（要求扩展端和客户端都已登录，且账号一致）
    connectClientWebsocket().catch((error) => {
      log("[ClientWS] initialize: 连接本地客户端失败", serializeError(error));
    });
    // 6. 初始化后再次广播状态（确保状态已更新）
    broadcastWsState();
    broadcastClientWsState();
  } catch (error) {
    log("初始化 WebSocket 失败:", serializeError(error));
    updateWsState({
      status: "error",
      lastError: serializeError(error),
    });
  }
}

// =============================================================
// 五、全局错误处理
// =============================================================
self.addEventListener("error", (event) => {
  console.error("[Core][WS] Service Worker 全局错误:", event.error);
  log("Service Worker 全局错误: " + serializeError(event.error));
});

self.addEventListener("unhandledrejection", (event) => {
  console.error(
    "[Core][WS] Service Worker 未处理的 Promise 拒绝:",
    event.reason,
  );
  log("Service Worker 未处理的 Promise 拒绝: " + serializeError(event.reason));
});

// =============================================================
// 六、安装 / 启动 / 存储变更等生命周期事件
// =============================================================

chrome.runtime.onInstalled.addListener(() => {
  log("插件已安装");
  try {
    chrome.storage.local.get(
      [STORAGE_ENDPOINT_KEY, STORAGE_ENDPOINT_CUSTOM_KEY],
      (result) => {
        if (chrome.runtime.lastError) {
          log("获取存储失败:", chrome.runtime.lastError.message);
          return;
        }
        if (!result[STORAGE_ENDPOINT_KEY]) {
          chrome.storage.local.set(
            {
              [STORAGE_ENDPOINT_KEY]: DEFAULT_WS_ENDPOINT,
              [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
            },
            () => {
              if (chrome.runtime.lastError) {
                log("设置默认端点失败:", chrome.runtime.lastError.message);
              }
            },
          );
        }
      },
    );
  } catch (error) {
    log("onInstalled 处理失败:", serializeError(error));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  const tokenChanged = Object.prototype.hasOwnProperty.call(
    changes,
    AUTH_TOKEN_KEY,
  );
  const userInfoChanged = Object.prototype.hasOwnProperty.call(
    changes,
    AUTH_USER_INFO_KEY,
  );
  const devConfigChanged =
    Object.prototype.hasOwnProperty.call(changes, STORAGE_DEV_MODE_KEY) ||
    Object.prototype.hasOwnProperty.call(
      changes,
      STORAGE_DEV_WS_BASE_URL_KEY,
    ) ||
    Object.prototype.hasOwnProperty.call(changes, STORAGE_WS_BASE_URL_KEY);

  if (tokenChanged || userInfoChanged) {
    (async () => {
      const hasSession = await hasAuthenticatedSession();
      if (!hasSession) {
        disconnectWebsocket(EXTENSION_LOGIN_REQUIRED_MESSAGE);
        disconnectClientWebsocket(EXTENSION_LOGIN_REQUIRED_MESSAGE);
        return;
      }

      await forceReconnect("auth-state-change");
      disconnectClientWebsocket("auth-state-change");
      await connectClientWebsocket();
    })().catch((error) => {
      log("[WS] auth-state-change: 处理失败", serializeError(error));
    });
  }

  if (devConfigChanged) {
    forceReconnect("dev-config-change").catch((error) => {
      log("[WS] dev-config-change: 处理失败", serializeError(error));
    });

    disconnectClientWebsocket("dev-config-change");
    connectClientWebsocket().catch((error) => {
      log("[ClientWS] dev-config-change: 处理失败", serializeError(error));
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  log("浏览器启动，开始初始化");
  initialize().catch((error) => {
    log("启动时初始化失败:", serializeError(error));
    updateWsState({
      status: "error",
      lastError: "初始化失败: " + serializeError(error),
    });
  });
});

// =============================================================
// 七、Service Worker 启动入口
// =============================================================
try {
  log("Service Worker 开始初始化...");
  initialize().catch((error) => {
    log("初始化调用失败:", serializeError(error));
    updateWsState({
      status: "error",
      lastError: "初始化失败: " + serializeError(error),
    });
  });
} catch (error) {
  console.error("[Core][WS] Service Worker 初始化异常:", error);
  log("Service Worker 初始化异常: " + serializeError(error));
}

// =============================================================
// 八、扩展内部消息分发（popup / content scripts -> background）
// =============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "control/feature-execute") {
    handleControlFeatureExecute(request)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request?.action === "uploadImageToGallery") {
    const tabId = sender?.tab?.id ?? null;
    const imageUrl = normalizeUploadUrl(request.imageUrl);

    if (!imageUrl) {
      sendResponse({ success: false, error: "未识别到可上传的图片地址" });
      return true;
    }

    ensureClientConnectionAllowed("hover-image-upload")
      .then((access) => {
        if (!access.allowed) {
          throw new Error(access.reason);
        }
        if (isImageUploading(imageUrl, "sticker")) {
          throw new Error("这张图片正在上传，请稍候");
        }
        return performUpload(tabId, imageUrl, "sticker", {
          showLoadingOverlay: false,
        });
      })
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request?.action === "collectPageImagesToCrawler") {
    const tabId = sender?.tab?.id ?? null;
    collectPageImagesToCrawler(tabId, request.imageUrls)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "collectProduct") {
    collectProductToServer(request.data)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "getUserApiKey") {
    getUserApiKeyFromServer(request.feature)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "saveData") {
    chrome.storage.local.get(["crawledData"], (result) => {
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

  if (request.action === "getData") {
    chrome.storage.local.get(["crawledData"], (result) => {
      sendResponse({ data: result.crawledData || [] });
    });
    return true;
  }

  if (request.action === "getWebsocketStatus") {
    sendResponse({ success: true, data: { ...wsState } });
    return true;
  }

  if (request.action === "getClientWebsocketStatus") {
    sendResponse({ success: true, data: { ...clientWsState } });
    return true;
  }

  if (request.action === "reconnectWebsocket") {
    forceReconnect("manual-reconnect")
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "reconnectClientWebsocket") {
    connectClientWebsocket()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "updateDevMode") {
    forceReconnect("dev-mode-switch")
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  if (request.action === "setWebsocketEndpoint") {
    setEndpoint(request.endpoint, (error) => {
      if (error) {
        sendResponse({ success: false, error: serializeError(error) });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }

  // OAuth 回调处理
  if (request.action === "oauthCallback") {
    handleOAuthCallback(request.code, request.redirectUri)
      .then((token) => sendResponse({ success: true, token }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }

  // 打开 OAuth 授权页面
  if (request.action === "openOAuthPage") {
    openOAuthAuthorizePage()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({ success: false, error: serializeError(error) }),
      );
    return true;
  }
});

/**
 * 处理 OAuth 回调：用授权码换取 token
 */
async function handleOAuthCallback(code: string, redirectUri: string): Promise<string> {
  const apiBaseUrl = await getApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      client_id: "yishe-extension",
      client_secret: "yishe-extension-secret-2026",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Token 交换失败");
    throw new Error(errorText);
  }

  const data = await response.json();
  const token = data.accessToken || data.access_token;
  if (!token) {
    throw new Error("响应中未找到 token");
  }

  // 保存 token
  await storageSet({ [AUTH_TOKEN_KEY]: token });

  // 获取用户信息
  try {
    const userResponse = await fetch(`${apiBaseUrl}/user/getUserInfo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (userResponse.ok) {
      const userData = await userResponse.json();
      const userInfo = userData.data || userData;
      await storageSet({ [AUTH_USER_INFO_KEY]: userInfo });
    }
  } catch (e) {
    log("获取用户信息失败:", serializeError(e));
  }

  return token;
}

/**
 * 打开 OAuth 授权页面
 */
async function openOAuthAuthorizePage(): Promise<void> {
  const apiBaseUrl = await getApiBaseUrl();
  const authorizeBaseUrl = apiBaseUrl.includes("localhost")
    ? "http://localhost:1521"
    : "https://admin.1s.design";
  const redirectUri = browser.runtime.getURL("/oauth-callback.html");

  const params = new URLSearchParams({
    client_id: "yishe-extension",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "user:read user:write",
  });

  const authorizeUrl = `${authorizeBaseUrl}/oauth/authorize?${params.toString()}`;
  await browser.tabs.create({ url: authorizeUrl });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    console.log("[Core] 标签页已加载:", tab.url);
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
      log("[ContextMenu] 清除菜单项:", chrome.runtime.lastError.message);
    }

    // 0) 创建根菜单
    chrome.contextMenus.create({
      id: "yishe-extension-root",
      title: "YiShe 扩展功能",
      contexts: ["all"],
    });

    // --- 分组 1: 采集与收藏 ---
    chrome.contextMenus.create({
      id: "yishe-group-collect",
      parentId: "yishe-extension-root",
      title: "采集与收藏",
      contexts: ["all"],
    });

    // 1-1）保存当前网站
    chrome.contextMenus.create({
      id: "save-current-website",
      parentId: "yishe-group-collect",
      title: "保存当前网站",
      contexts: ["all"],
    });

    // 1-2）保存选中文字
    chrome.contextMenus.create({
      id: "save-selected-text",
      parentId: "yishe-group-collect",
      title: "保存选中文字",
      contexts: ["selection"],
    });

    // 1-3）上传图片到图片素材库
    chrome.contextMenus.create({
      id: "upload-image-to-sticker",
      parentId: "yishe-group-collect",
      title: "上传到图片素材库",
      contexts: ["image"],
    });

    // 1-4）上传图片到爬图素材库
    chrome.contextMenus.create({
      id: "upload-image-to-crawler-material",
      parentId: "yishe-group-collect",
      title: "上传到爬图素材库",
      contexts: ["image"],
    });

    // 1-5）批量采集当前页图片到爬图素材库
    chrome.contextMenus.create({
      id: PAGE_IMAGE_COLLECTOR_MENU_ID,
      parentId: "yishe-group-collect",
      title: "批量采集当前页图片到爬图库",
      contexts: ["all"],
    });

    // 1-7）保存当前预览文件到文件资源
    chrome.contextMenus.create({
      id: "save-current-file-resource",
      parentId: "yishe-group-collect",
      title: "保存当前文件到文件资源",
      contexts: ["all"],
    });

    // 1-8）采集并AI分析当前页商品
    chrome.contextMenus.create({
      id: "collect-product-info-with-ai",
      parentId: "yishe-group-collect",
      title: "采集并分析当前页商品",
      contexts: ["all"],
    });

    // --- 分组 2: Temu 助手 ---
    chrome.contextMenus.create({
      id: "yishe-group-temu",
      parentId: "yishe-extension-root",
      title: "Temu 助手",
      contexts: ["all"],
      documentUrlPatterns: ["*://*.temu.com/*"],
    });

    // 2-1）清空 Temu 缓存
    chrome.contextMenus.create({
      id: "clear-temu-cache",
      parentId: "yishe-group-temu",
      title: "一键清空缓存 & Cookie",
      contexts: ["all"],
      documentUrlPatterns: ["*://*.temu.com/*"],
    });

    log("[ContextMenu] 右键菜单已初始化");
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
      throw new Error("无法获取当前标签页");
    }

    // 使用 scripting API 在页面中执行复制操作
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (textToCopy) => {
        // 创建一个临时的 textarea 元素
        const textarea = document.createElement("textarea");
        textarea.value = textToCopy;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();

        try {
          const successful = document.execCommand("copy");
          if (!successful) {
            throw new Error("复制失败");
          }
        } finally {
          document.body.removeChild(textarea);
        }
      },
      args: [text],
    });

    log("[ContextMenu] 文本已复制到剪贴板");
    return true;
  } catch (error) {
    log("[ContextMenu] 复制失败:", serializeError(error));
    throw error;
  }
}

function resolveUploadTargetMeta(target) {
  if (target === "crawler-material") {
    return {
      label: "YiShe 爬图素材库",
      loadingMessage: "正在上传图片到 YiShe 爬图素材库...",
      successMessage: "图片已上传到 YiShe 爬图素材库",
      duplicateMessage: "图片正在上传到 YiShe 爬图素材库，请稍候...",
    };
  }

  return {
    label: "YiShe 图片素材库",
    loadingMessage: "正在上传图片到 YiShe 图片素材库...",
    successMessage: "图片已上传到 YiShe 图片素材库",
    duplicateMessage: "图片正在上传到 YiShe 图片素材库，请稍候...",
  };
}

const PAGE_IMAGE_COLLECTOR_MENU_ID = "collect-page-images-to-crawler-material";
const PAGE_IMAGE_COLLECTOR_OPEN_MESSAGE = "yishe:page-image-collector:open";
const PAGE_IMAGE_COLLECTOR_PROGRESS_MESSAGE =
  "yishe:page-image-collector:progress";

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function ensurePageImageCollectorInjected(tabId) {
  // 当前页采集面板已由 WXT content script 统一注入，
  // 理论上无需在 background 中再次手动执行文件注入。
  return tabId;
}

async function openPageImageCollector(tabId) {
  if (tabId == null) {
    throw new Error("无法获取当前标签页");
  }

  try {
    const response = await sendMessageToTab(tabId, {
      type: PAGE_IMAGE_COLLECTOR_OPEN_MESSAGE,
    });
    if (response?.ok) {
      return response;
    }
  } catch (error) {
    log(
      "[PageImageCollector] 首次打开失败，尝试注入脚本:",
      serializeError(error),
    );
  }

  try {
    await ensurePageImageCollectorInjected(tabId);
    const response = await sendMessageToTab(tabId, {
      type: PAGE_IMAGE_COLLECTOR_OPEN_MESSAGE,
    });
    if (response?.ok) {
      return response;
    }
  } catch (error) {
    log("[PageImageCollector] 采集面板未就绪:", serializeError(error));
  }

  throw new Error("无法打开当前页图片采集面板，请刷新页面后重试");
}

function notifyPageImageCollectorProgress(tabId, payload) {
  if (tabId == null) {
    return;
  }

  chrome.tabs.sendMessage(
    tabId,
    {
      type: PAGE_IMAGE_COLLECTOR_PROGRESS_MESSAGE,
      ...payload,
    },
    () => {
      if (chrome.runtime.lastError) {
        // 内容脚本未就绪时静默忽略
      }
    },
  );
}

function normalizeBatchImageUrls(imageUrls) {
  const normalizedUrls = [];
  const seen = new Set();

  for (const value of Array.isArray(imageUrls) ? imageUrls : []) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }

      const normalized = parsed.href;
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      normalizedUrls.push(normalized);
    } catch (error) {
      // 忽略非法地址
    }
  }

  return normalizedUrls;
}

function shouldAbortCrawlerBatchUpload(error) {
  const message = serializeError(error);
  return (
    message.includes("无法连接到 YiShe 客户端服务") ||
    message.includes("Failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ERR_CONNECTION_REFUSED")
  );
}

function buildCrawlerBatchSummaryMessage(summary) {
  const parts = [`批量采集完成：成功 ${summary.successCount} 张`];

  if (summary.failedCount > 0) {
    parts.push(`失败 ${summary.failedCount} 张`);
  }

  if (summary.skippedCount > 0) {
    parts.push(`跳过 ${summary.skippedCount} 张`);
  }

  if (summary.abortedCount > 0) {
    parts.push(`未继续 ${summary.abortedCount} 张`);
  }

  return parts.join("，");
}

/**
 * 将采集的商品数据提交到服务端
 * @param {Object} collectData - 采集数据
 * @returns {Promise<Object>} - 提交结果
 */
async function collectProductToServer(collectData) {
  log("[CollectProduct] 开始提交采集数据:", collectData);

  try {
    const apiUtils = getApiUtils();
    if (!apiUtils) {
      throw new Error("ApiUtils 不可用");
    }

    const apiBaseUrl = await apiUtils.getApiBaseUrl();
    const token = await apiUtils.getToken();

    if (!apiBaseUrl) {
      throw new Error("API 基础地址未配置");
    }

    const endpoint =
      backgroundGlobal.ApiConfig?.API_ENDPOINTS?.EXTENSION_COLLECT?.CREATE ||
      "/extension-collect";
    const url = `${apiBaseUrl.replace(/\/$/, "")}${endpoint}`;

    const headers = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(collectData),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      log("[CollectProduct] 提交失败:", response.status, errorText);

      if (response.status === 401) {
        throw new Error("未登录，请先登录扩展账号");
      }
      throw new Error(
        `提交失败 (${response.status}): ${errorText || response.statusText}`,
      );
    }

    const result = await response.json();
    log("[CollectProduct] 提交成功:", result);

    return { success: true, data: result };
  } catch (error) {
    log("[CollectProduct] 提交异常:", serializeError(error));
    throw error;
  }
}

/**
 * 从服务端获取用户的 AI API Key
 * @param {string} feature - 功能标识
 * @returns {Promise<Object>} - API Key 信息
 */
async function getUserApiKeyFromServer(feature) {
  log("[GetUserApiKey] 开始获取 API Key:", feature);

  try {
    const apiUtils = getApiUtils();
    if (!apiUtils) {
      throw new Error("ApiUtils 不可用");
    }

    const result = await apiUtils.apiRequest("/user/get-api-key", {
      method: "POST",
      body: JSON.stringify({ feature: feature || "extension_collect" }),
    });

    log("[GetUserApiKey] 获取成功:", result);
    return result;
  } catch (error) {
    log("[GetUserApiKey] 获取异常:", serializeError(error));
    throw error;
  }
}

async function collectPageImagesToCrawler(tabId, imageUrls) {
  const normalizedUrls = normalizeBatchImageUrls(imageUrls);
  if (!normalizedUrls.length) {
    throw new Error("当前页面没有可采集的图片");
  }

  const total = normalizedUrls.length;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let abortedCount = 0;
  const failures = [];

  notifyPageImageCollectorProgress(tabId, {
    phase: "start",
    total,
  });

  for (let index = 0; index < normalizedUrls.length; index += 1) {
    const imageUrl = normalizedUrls[index];
    const current = index + 1;
    const progressMessage = `正在采集到 YiShe 爬图素材库（${current}/${total}）...`;

    setTabBadge(tabId, "...", "#2563eb", progressMessage);

    let status = "success";
    let itemMessage = "图片已上传到 YiShe 爬图素材库";

    try {
      if (isImageUploading(imageUrl, "crawler-material")) {
        status = "skipped";
        skippedCount += 1;
        itemMessage = "图片正在上传中，已跳过";
      } else {
        await performUpload(tabId, imageUrl, "crawler-material", {
          loadingMessage: progressMessage,
          showLoadingOverlay: false,
        });
        successCount += 1;
      }
    } catch (error) {
      status = "error";
      failedCount += 1;
      itemMessage = serializeError(error) || "上传失败";
      failures.push({
        imageUrl,
        message: itemMessage,
      });

      if (shouldAbortCrawlerBatchUpload(error)) {
        abortedCount = total - current;
      }
    }

    notifyPageImageCollectorProgress(tabId, {
      phase: "item",
      current,
      total,
      url: imageUrl,
      status,
      message: itemMessage,
      successCount,
      failedCount,
      skippedCount,
      abortedCount,
    });

    if (abortedCount > 0) {
      break;
    }
  }

  const summary = {
    total,
    successCount,
    failedCount,
    skippedCount,
    abortedCount,
    failures,
  };
  const summaryMessage = buildCrawlerBatchSummaryMessage(summary);
  const toastLevel =
    failedCount > 0 || abortedCount > 0
      ? successCount > 0
        ? "warning"
        : "error"
      : "success";

  showToast(tabId, toastLevel, summaryMessage, 4200);
  notifyPageImageCollectorProgress(tabId, {
    phase: "complete",
    message: summaryMessage,
    ...summary,
  });

  return {
    success: true,
    data: {
      ...summary,
      message: summaryMessage,
      level: toastLevel,
    },
  };
}

/**
 * 执行图片上传
 * @param {number|null} tabId - 标签页 ID
 * @param {string} imageUrl - 图片URL
 * @param {'sticker' | 'crawler-material'} target - 上传目标
 * @param {Object} [options] - 额外选项
 * @returns {Promise<Object>} - 上传结果
 */
async function performUpload(tabId, imageUrl, target, options = {}) {
  const targetMeta = resolveUploadTargetMeta(target);
  const loadingMessage =
    typeof options.loadingMessage === "string" && options.loadingMessage.trim()
      ? options.loadingMessage.trim()
      : targetMeta.loadingMessage;
  const showLoadingOverlay = options.showLoadingOverlay !== false;
  log("[Upload] 开始上传图片:", { tabId, imageUrl, target });
  try {
    markImageUploading(imageUrl, target);
    if (showLoadingOverlay) {
      showLoading(tabId, "show", loadingMessage);
    }

    const imagePayload = await fetchImagePayloadForUpload(imageUrl);

    // 调用本地 yishe-client 提供的接口
    const payload = {
      url: imageUrl,
      name: "", // 可以以后改成从图片 alt / 描述推断
      description: "", // 暂时留空，由服务端或后续编辑补充
      keywords: "", // 暂时留空
      target,
      imageData: imagePayload.imageData,
      fileName: imagePayload.fileName,
      contentType: imagePayload.contentType,
      suffix: imagePayload.suffix,
      width: imagePayload.width,
      height: imagePayload.height,
      fileSize: imagePayload.fileSize,
    };

    const clientBaseUrl = await getEffectiveClientBaseUrl();
    const clientUploadPath =
      backgroundGlobal.ApiConfig?.CLIENT_ENDPOINTS?.MATERIAL_UPLOAD ||
      "/api/material-upload";
    const clientUploadUrl = `${clientBaseUrl}${clientUploadPath}`;
    const localSecret = await getLocalServiceSecret();

    const response = await fetch(clientUploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Local-Secret": localSecret,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(
        "[Upload] 上传图片到素材库失败，HTTP 状态异常:",
        response.status,
        text,
      );
      console.error("[YiShe][UploadImage] 上传失败:", response.status, text);

      // 检查是否是服务未运行
      if (
        response.status === 0 ||
        text.includes("ECONNREFUSED") ||
        text.includes("Failed to fetch")
      ) {
        throw new Error(
          "无法连接到 YiShe 客户端服务，请确保 YiShe 客户端已启动",
        );
      } else {
        throw new Error("上传图片失败（服务端返回错误）");
      }
    }

    let result = null;
    try {
      result = await response.json();
    } catch (e) {
      log("[Upload] 解析上传接口响应失败:", serializeError(e));
      throw new Error("解析服务端响应失败");
    }

    log("[Upload] 图片上传接口响应:", result);
    console.log("[YiShe][UploadImage] 图片上传完成:", {
      imageUrl,
      target,
      result,
    });

    markImageUploadComplete(imageUrl, target);

    return { success: true, result };
  } catch (error) {
    log("[Upload] 上传异常:", serializeError(error));
    console.error("[YiShe][UploadImage] 上传异常:", error);
    markImageUploadComplete(imageUrl, target);
    const errorMessage = serializeError(error);
    if (
      errorMessage.includes("Failed to fetch") ||
      errorMessage.includes("fetch failed") ||
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ERR_CONNECTION_REFUSED")
    ) {
      throw new Error("无法连接到 YiShe 客户端服务，请确保 YiShe 客户端已启动");
    }
    throw error instanceof Error ? error : new Error(errorMessage);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () =>
      reject(reader.error || new Error("读取图片数据失败"));
    reader.readAsDataURL(blob);
  });
}

async function resolveImageSizeFromBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = {
      width: bitmap.width || undefined,
      height: bitmap.height || undefined,
    };
    bitmap.close();
    return size;
  } catch (error) {
    log("[Upload] 读取图片尺寸失败:", serializeError(error));
    return {
      width: undefined,
      height: undefined,
    };
  }
}

function sanitizeUploadFileExtension(extension) {
  const normalized = String(extension || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!normalized) {
    return "jpg";
  }
  if (normalized === "jpeg") {
    return "jpg";
  }
  return normalized;
}

function inferImageExtension(imageUrl, contentType) {
  const urlMatch = String(imageUrl || "").match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
  if (urlMatch) {
    return sanitizeUploadFileExtension(urlMatch[1]);
  }

  const typeMatch = String(contentType || "").match(
    /^image\/([a-zA-Z0-9.+-]+)/i,
  );
  if (typeMatch) {
    const rawType = typeMatch[1].toLowerCase().split("+")[0];
    return sanitizeUploadFileExtension(rawType);
  }

  return "jpg";
}

function hasImageSignature(bytes, offset, signature) {
  if (bytes.length < offset + signature.length) {
    return false;
  }

  return signature.every((value, index) => bytes[offset + index] === value);
}

function readAscii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

async function detectImageContentType(blob) {
  try {
    const buffer = await blob.slice(0, 512).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (hasImageSignature(bytes, 0, [0xff, 0xd8, 0xff])) {
      return "image/jpeg";
    }
    if (
      hasImageSignature(bytes, 0, [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ])
    ) {
      return "image/png";
    }
    if (
      hasImageSignature(bytes, 0, [0x47, 0x49, 0x46, 0x38])
    ) {
      return "image/gif";
    }
    if (
      hasImageSignature(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
      readAscii(bytes, 8, 4) === "WEBP"
    ) {
      return "image/webp";
    }
    if (hasImageSignature(bytes, 0, [0x42, 0x4d])) {
      return "image/bmp";
    }
    if (
      hasImageSignature(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) ||
      hasImageSignature(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])
    ) {
      return "image/tiff";
    }
    if (hasImageSignature(bytes, 0, [0x00, 0x00, 0x01, 0x00])) {
      return "image/x-icon";
    }

    if (readAscii(bytes, 4, 4) === "ftyp") {
      const brand = readAscii(bytes, 8, 4).toLowerCase();
      if (brand === "avif" || brand === "avis") {
        return "image/avif";
      }
      if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
        return "image/heif";
      }
    }

    const text = new TextDecoder()
      .decode(bytes)
      .replace(/^\uFEFF/, "")
      .trimStart()
      .toLowerCase();
    if (text.startsWith("<svg") || (text.startsWith("<?xml") && /<svg[\s>]/i.test(text))) {
      return "image/svg+xml";
    }
  } catch (error) {
    log("[Upload] 检测图片文件头失败:", serializeError(error));
  }

  return "";
}

function sanitizeFileName(value, fallback = "file") {
  let decodedValue = String(value || "").trim();
  try {
    decodedValue = decodeURIComponent(decodedValue);
  } catch (error) {
    // 保留原始值
  }

  const normalized = decodedValue
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function sanitizeFileExtension(extension) {
  return (
    String(extension || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin"
  );
}

function inferFileExtension(fileUrl, contentType) {
  const urlMatch = String(fileUrl || "").match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
  if (urlMatch) {
    return sanitizeFileExtension(urlMatch[1]);
  }

  const normalizedContentType = String(contentType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const contentTypeMap = {
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "pptx",
    "text/plain": "txt",
    "text/csv": "csv",
  };

  return contentTypeMap[normalizedContentType] || "bin";
}

function getFileNameFromContentDisposition(value) {
  const header = String(value || "");
  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    return sanitizeFileName(encodedMatch[1]);
  }

  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return sanitizeFileName(quotedMatch[1]);
  }

  const plainMatch = header.match(/filename=([^;]+)/i);
  if (plainMatch) {
    return sanitizeFileName(plainMatch[1]);
  }

  return "";
}

function inferFileName(fileUrl, contentType, contentDisposition) {
  const fromDisposition = getFileNameFromContentDisposition(contentDisposition);
  if (fromDisposition) {
    return fromDisposition;
  }

  try {
    const parsedUrl = new URL(fileUrl);
    const pathnameName = parsedUrl.pathname.split("/").filter(Boolean).pop();
    if (pathnameName) {
      const decodedName = sanitizeFileName(pathnameName);
      if (decodedName.includes(".")) {
        return decodedName;
      }
      return `${decodedName}.${inferFileExtension(fileUrl, contentType)}`;
    }
  } catch (error) {
    // 忽略非法 URL，使用兜底文件名
  }

  return `file_${Date.now()}.${inferFileExtension(fileUrl, contentType)}`;
}

function getCandidateFileUrl(info, tab) {
  const candidates = [info?.linkUrl, info?.srcUrl, info?.pageUrl, tab?.url];

  for (const candidate of candidates) {
    const normalized = normalizeUploadUrl(candidate);
    if (/^(https?|file):\/\//i.test(normalized)) {
      return normalized;
    }
  }

  return "";
}

function isLocalFileUrl(fileUrl) {
  return /^file:\/\//i.test(String(fileUrl || "").trim());
}

function fileUrlToLocalPath(fileUrl) {
  const parsedUrl = new URL(fileUrl);
  let pathname = parsedUrl.pathname || "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch (error) {
    // 保留原始路径
  }

  if (/^\/[a-zA-Z]:\//.test(pathname)) {
    pathname = pathname.slice(1);
  }

  pathname = pathname.replace(/\//g, "\\");
  if (parsedUrl.hostname) {
    return `\\\\${parsedUrl.hostname}${pathname}`;
  }

  return pathname;
}

async function fetchFilePayloadForUpload(fileUrl) {
  const response = await fetch(fileUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/pdf,application/octet-stream,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`文件抓取失败（HTTP ${response.status}）`);
  }

  const contentType =
    String(response.headers.get("content-type") || "application/octet-stream")
      .split(";")[0]
      .trim() || "application/octet-stream";
  const blob = await response.blob();
  const fileSize = Number(blob.size || 0);
  if (fileSize <= 0) {
    throw new Error("文件内容为空，无法保存");
  }
  if (fileSize > 100 * 1024 * 1024) {
    throw new Error("文件过大，请选择小于100MB的文件");
  }

  const suffix = inferFileExtension(fileUrl, contentType);
  const fileName = inferFileName(
    fileUrl,
    contentType,
    response.headers.get("content-disposition"),
  );
  const fileData = await blobToDataUrl(blob);
  if (!fileData) {
    throw new Error("文件转码失败");
  }

  return {
    fileData,
    fileName,
    contentType,
    suffix,
    fileSize,
  };
}

async function performFileResourceUpload(tabId, fileUrl) {
  log("[FileUpload] 开始保存文件资源:", { tabId, fileUrl });

  try {
    markFileUploading(fileUrl);
    showLoading(tabId, "show", "正在保存文件到 YiShe 文件资源...");

    const isLocalFile = isLocalFileUrl(fileUrl);
    const filePayload = isLocalFile
      ? {
          localFilePath: fileUrlToLocalPath(fileUrl),
          fileName: inferFileName(fileUrl, "application/octet-stream", ""),
          contentType: "application/octet-stream",
          suffix: inferFileExtension(fileUrl, "application/octet-stream"),
          fileSize: undefined,
        }
      : await fetchFilePayloadForUpload(fileUrl);
    const clientBaseUrl = await getEffectiveClientBaseUrl();
    const clientUploadPath =
      backgroundGlobal.ApiConfig?.CLIENT_ENDPOINTS?.FILE_UPLOAD ||
      "/api/file-upload";
    const clientUploadUrl = `${clientBaseUrl}${clientUploadPath}`;
    const localSecret = await getLocalServiceSecret();

    const response = await fetch(clientUploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Local-Secret": localSecret,
      },
      body: JSON.stringify({
        url: fileUrl,
        name: filePayload.fileName,
        description: "",
        fileData: filePayload.fileData,
        localFilePath: filePayload.localFilePath,
        fileName: filePayload.fileName,
        contentType: filePayload.contentType,
        suffix: filePayload.suffix,
        fileSize: filePayload.fileSize,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(
        "[FileUpload] 保存文件资源失败，HTTP 状态异常:",
        response.status,
        text,
      );
      throw new Error(text || "保存文件资源失败（服务端返回错误）");
    }

    const result = await response.json().catch(() => null);
    if (!result?.status && result?.code !== 0) {
      throw new Error(result?.message || "保存文件资源失败");
    }

    markFileUploadComplete(fileUrl);
    return { success: true, result };
  } catch (error) {
    log("[FileUpload] 保存文件资源异常:", serializeError(error));
    markFileUploadComplete(fileUrl);
    const errorMessage = serializeError(error);
    if (
      errorMessage.includes("Failed to fetch") ||
      errorMessage.includes("fetch failed") ||
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ERR_CONNECTION_REFUSED")
    ) {
      throw new Error("无法连接到 YiShe 客户端服务，请确保 YiShe 客户端已启动");
    }
    throw error instanceof Error ? error : new Error(errorMessage);
  }
}

async function fetchImagePayloadForUpload(imageUrl) {
  const response = await fetch(imageUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "image/*",
    },
  });

  if (!response.ok) {
    throw new Error(`图片抓取失败（HTTP ${response.status}）`);
  }

  const blob = await response.blob();
  const fileSize = Number(blob.size || 0);
  if (fileSize <= 0) {
    throw new Error("图片内容为空，无法上传");
  }
  if (fileSize > 50 * 1024 * 1024) {
    throw new Error("图片文件过大，请选择小于50MB的图片");
  }

  const declaredContentType = String(
    response.headers.get("content-type") || "",
  )
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const detectedContentType = await detectImageContentType(blob);
  const contentType = detectedContentType || declaredContentType;

  if (!contentType.startsWith("image/")) {
    throw new Error("当前链接返回的不是图片内容");
  }

  if (!declaredContentType.startsWith("image/") && detectedContentType) {
    log("[Upload] 响应类型不是 image/*，已根据图片文件头修正:", {
      declaredContentType,
      detectedContentType,
      imageUrl,
    });
  }

  const imageData = await blobToDataUrl(blob);
  if (!imageData) {
    throw new Error("图片转码失败");
  }

  const { width, height } = await resolveImageSizeFromBlob(blob);
  const suffix = inferImageExtension(imageUrl, contentType);

  return {
    imageData,
    contentType,
    suffix,
    width,
    height,
    fileSize,
    fileName: `image_${Date.now()}.${suffix}`,
  };
}

/**
 * 处理右键菜单点击事件
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    log("[ContextMenu] 右键菜单项被点击:", info.menuItemId);

    // 1）保存当前网站到 YiShe
    if (info.menuItemId === "save-current-website") {
      const pageUrl = info.pageUrl || tab?.url || null;
      const pageTitle = tab?.title || null;
      const favIconUrl = tab?.favIconUrl || null;

      const tabId = getTabId(tab);

      if (!pageUrl) {
        log("[ContextMenu] 保存网站失败：未获取到页面地址");
        console.warn("[YiShe][SaveWebsite] 缺少页面地址，info =", info);
        showToast(tabId, "warning", "无法识别当前页面地址，暂时无法保存");
        return;
      }

      log("[ContextMenu] 准备保存网站到 YiShe:", {
        pageUrl,
        pageTitle,
        favIconUrl,
      });

      // 显示 loading 状态
      showLoading(tabId, "show", "正在保存网站到 YiShe...");

      // 异步保存网站信息
      // 注意：错误处理和 loading 状态管理已在 saveWebsiteToServer 函数内部处理
      saveWebsiteToServer(
        {
          url: pageUrl,
          name: pageTitle || new URL(pageUrl).hostname,
          description: pageTitle || "",
          icon: favIconUrl || "",
          category: "收藏",
        },
        tab,
      ).catch((error) => {
        // 错误已在 saveWebsiteToServer 函数内部处理，这里只记录日志
        log("[ContextMenu] 保存网站失败:", serializeError(error));
        console.error("[YiShe][SaveWebsite] 保存网站失败:", error);
      });

      return;
    }

    // 2）保存选中文字到 YiShe
    if (info.menuItemId === "save-selected-text") {
      const selectedText = info.selectionText || null;
      const pageUrl = info.pageUrl || tab?.url || null;
      const pageTitle = tab?.title || null;

      const tabId = getTabId(tab);

      if (!selectedText || selectedText.trim().length === 0) {
        log("[ContextMenu] 保存文字失败：未获取到选中文字");
        console.warn("[YiShe][SaveText] 缺少选中文字，info =", info);
        showToast(tabId, "warning", "未选中文字，无法保存");
        return;
      }

      log("[ContextMenu] 准备保存文字到 YiShe:", {
        selectedText:
          selectedText.substring(0, 50) +
          (selectedText.length > 50 ? "..." : ""),
        pageUrl,
        pageTitle,
      });

      // 显示 loading 状态
      showLoading(tabId, "show", "正在保存文字到 YiShe...");

      // 异步保存文字信息
      // 注意：错误处理和 loading 状态管理已在 saveTextToServer 函数内部处理
      saveTextToServer(
        {
          content: selectedText.trim(),
          description: pageTitle ? `来自：${pageTitle}` : "",
          keywords: "",
        },
        tab,
      ).catch((error) => {
        // 错误已在 saveTextToServer 函数内部处理，这里只记录日志
        log("[ContextMenu] 保存文字失败:", serializeError(error));
        console.error("[YiShe][SaveText] 保存文字失败:", error);
      });

      return;
    }

    // 3）批量采集当前页图片到 YiShe 爬图素材库
    if (info.menuItemId === PAGE_IMAGE_COLLECTOR_MENU_ID) {
      const tabId = getTabId(tab);
      const pageUrl = tab?.url || info.pageUrl || "";

      if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
        showToast(
          tabId,
          "warning",
          "当前页面不支持批量采集，请切换到普通网页后重试",
        );
        return;
      }

      try {
        await openPageImageCollector(tabId);
      } catch (error) {
        log("[ContextMenu] 打开当前页图片采集面板失败:", serializeError(error));
        showToast(
          tabId,
          "error",
          error.message || "打开当前页图片采集面板失败，请刷新页面后重试",
        );
      }

      return;
    }

    // 4）保存当前预览文件到 YiShe 文件资源
    if (info.menuItemId === "save-current-file-resource") {
      const tabId = getTabId(tab);
      const fileUrl = getCandidateFileUrl(info, tab);

      if (!fileUrl) {
        showToast(tabId, "warning", "无法识别当前文件地址，暂时无法保存");
        return;
      }

      if (isFileUploading(fileUrl)) {
        showToast(
          tabId,
          "info",
          "当前文件正在保存到 YiShe 文件资源，请稍候...",
        );
        return;
      }

      try {
        await performFileResourceUpload(tabId, fileUrl);
        showLoading(tabId, "hide");
        showToast(tabId, "success", "文件已保存到 YiShe 文件资源");
      } catch (error) {
        log("[ContextMenu] 保存文件资源失败:", serializeError(error));
        showLoading(tabId, "hide");
        showToast(
          tabId,
          "error",
          error.message || "保存文件资源失败，请稍后重试",
        );
      }

      return;
    }

    // 5）采集并AI分析当前页商品
    if (info.menuItemId === "collect-product-info-with-ai") {
      const tabId = getTabId(tab);
      const pageUrl = tab?.url || info.pageUrl || "";

      if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
        showToast(
          tabId,
          "warning",
          "当前页面不支持商品采集，请切换到普通网页后重试",
        );
        return;
      }

      try {
        showLoading(tabId, "show", "正在采集并AI分析...");

        // 提取商品数据
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            if (!window.CoreProductExtractor) {
              return { success: false, error: "商品提取器未加载" };
            }
            return {
              success: true,
              data: window.CoreProductExtractor.extract(),
            };
          },
        });

        if (!results || !results[0] || !results[0].result) {
          throw new Error("提取脚本执行失败");
        }

        const extractResult = results[0].result;
        if (!extractResult.success) {
          throw new Error(extractResult.error || "提取失败");
        }

        const productData = extractResult.data;
        if (!productData.title) {
          throw new Error("未能提取到商品标题，可能不是商品页面");
        }

        // AI 分析
        showLoading(tabId, "show", "正在进行 AI 分析...");
        const aiResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: (pData) => {
            if (!window.CoreSiteModules?.productCollector?.performAiAnalysis) {
              return { success: false, error: "AI 分析模块未加载" };
            }
            return window.CoreSiteModules.productCollector
              .performAiAnalysis(pData)
              .then((result) => ({ success: true, data: result }))
              .catch((err) => ({ success: false, error: err.message }));
          },
          args: [productData],
        });

        let aiAnalysis = null;
        if (aiResults && aiResults[0] && aiResults[0].result) {
          const aiResult = aiResults[0].result;
          if (aiResult.success) {
            aiAnalysis = {
              ...aiResult.data.analysis,
              model: aiResult.data.model,
              provider: aiResult.data.provider,
            };
          } else {
            throw new Error(`AI 分析失败: ${aiResult.error}`);
          }
        } else {
          throw new Error("AI 分析脚本执行失败");
        }

        // 提交到服务端
        showLoading(tabId, "show", "正在保存到服务端...");
        const collectData = {
          collectType: "product",
          sourceUrl: productData.url,
          sourceTitle: (productData.title || "").substring(0, 500),
          data: {
            title: productData.title,
            price: productData.price,
            currency: productData.currency,
            images: productData.images,
            coverImage: productData.coverImage,
            platform: productData.platform,
          },
          aiAnalysis: aiAnalysis,
        };

        const result = await collectProductToServer(collectData);
        showLoading(tabId, "hide");

        if (result.success) {
          showToast(tabId, "success", "采集并分析完成！");
        } else {
          showToast(
            tabId,
            "error",
            "保存失败: " + (result.error || "未知错误"),
          );
        }
      } catch (error) {
        log("[ContextMenu] 商品采集失败:", serializeError(error));
        showLoading(tabId, "hide");
        showToast(tabId, "error", error.message || "商品采集失败，请稍后重试");
      }

      return;
    }

    // 6）上传图片到 YiShe 图片素材 / 爬图素材
    if (
      info.menuItemId === "upload-image-to-sticker" ||
      info.menuItemId === "upload-image-to-crawler-material"
    ) {
      const imageUrl = info.srcUrl || null;
      const pageUrl = info.pageUrl || tab?.url || null;
      const pageTitle = tab?.title || null;
      const target =
        info.menuItemId === "upload-image-to-crawler-material"
          ? "crawler-material"
          : "sticker";
      const targetMeta = resolveUploadTargetMeta(target);

      const tabId = getTabId(tab);

      if (!imageUrl) {
        log("[ContextMenu] 上传图片失败：未获取到图片地址 srcUrl");
        console.warn("[YiShe][UploadImage] 缺少图片地址 srcUrl，info =", info);
        showToast(tabId, "warning", "无法识别当前图片地址，暂时无法上传");
        return;
      }

      // 检查是否正在上传相同的图片
      if (isImageUploading(imageUrl, target)) {
        log("[ContextMenu] 图片正在上传中，跳过重复提交:", {
          imageUrl,
          target,
        });
        showToast(tabId, "info", targetMeta.duplicateMessage);
        return;
      }

      log("[ContextMenu] 准备上传图片:", {
        imageUrl,
        pageUrl,
        pageTitle,
        target,
      });

      try {
        const result = await performUpload(tabId, imageUrl, target);
        log("[ContextMenu] 上传成功:", result);
        showLoading(tabId, "hide");
        showToast(tabId, "success", targetMeta.successMessage);
      } catch (error) {
        log("[ContextMenu] 上传流程异常:", serializeError(error));
        showLoading(tabId, "hide");
        showToast(
          tabId,
          "error",
          error.message || "上传图片时发生异常，请稍后重试",
        );
      }

      return;
    }

    // 7）清空 Temu 缓存
    if (info.menuItemId === "clear-temu-cache") {
      const tabId = getTabId(tab);
      const url = tab?.url || "";

      if (!url.includes("temu.com")) {
        showToast(tabId, "warning", "只能在 Temu 网站上使用此功能");
        return;
      }

      log("[ContextMenu] 开始清空 Temu 缓存...");
      showLoading(tabId, "show", "正在清空 Temu 缓存...");

      try {
        // 1. 清除 localStorage 和 sessionStorage
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              localStorage.clear();
              sessionStorage.clear();
              return { success: true };
            } catch (e) {
              return { success: false, error: e.toString() };
            }
          },
        });

        // 2. 清除 Cookies
        // 获取所有相关 cookie (temu.com 和 .temu.com)
        const allCookies = await chrome.cookies.getAll({});
        const temuCookies = allCookies.filter((c) =>
          c.domain.includes("temu.com"),
        );

        const cookiePromises = temuCookies.map((cookie) => {
          // 构建正确的 URL 以便删除 cookie
          const cookieUrl =
            "http" +
            (cookie.secure ? "s" : "") +
            "://" +
            cookie.domain +
            cookie.path;
          return chrome.cookies.remove({
            url: cookieUrl,
            name: cookie.name,
          });
        });

        await Promise.all(cookiePromises);

        log(
          "[ContextMenu] Temu 缓存清理完成，清除 Cookie 数量:",
          cookiePromises.length,
        );
        showLoading(tabId, "hide");
        showToast(tabId, "success", "Temu 缓存已清空，页面即将刷新");

        // 3. 刷新页面
        setTimeout(() => {
          chrome.tabs.reload(tabId);
        }, 1000);
      } catch (error) {
        log("[ContextMenu] 清空缓存失败:", serializeError(error));
        showLoading(tabId, "hide");
        showToast(tabId, "error", "清空缓存失败: " + error.message);
      }
      return;
    } else {
      // 其他未知菜单项（目前理论上不会出现）
      log("[ContextMenu] 未知的菜单项 ID（目前应不存在）:", info.menuItemId);
    }
  } catch (error) {
    log("[ContextMenu] 处理右键菜单点击失败:", serializeError(error));
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
  log("[ContextMenu] 初始化右键菜单失败:", serializeError(error));
}
