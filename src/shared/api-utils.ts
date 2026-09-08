import { API_ENDPOINTS, DEV_CONFIG, PROD_CONFIG } from "@/shared/api-config";
import { sendRuntimeMessage, storageGet, storageSet } from "@/shared/extension";
import type { UserInfo } from "@/shared/types";

type JsonRecord = Record<string, unknown>;

export const STORAGE_KEYS = {
  TOKEN: "accessToken",
  USER_INFO: "userInfo",
  DEV_MODE: "devMode",
  API_BASE_URL: "apiBaseUrl",
  WS_BASE_URL: "wsBaseUrl",
  DEV_API_BASE_URL: "devApiBaseUrl",
  DEV_WS_BASE_URL: "devWsBaseUrl",
} as const;

export const DEFAULT_CONFIG = {
  PROD_API_BASE_URL: PROD_CONFIG.API_BASE_URL,
  PROD_WS_BASE_URL: PROD_CONFIG.WS_BASE_URL,
  DEV_API_BASE_URL: DEV_CONFIG.API_BASE_URL,
  DEV_WS_BASE_URL: DEV_CONFIG.WS_BASE_URL,
} as const;

function normalizeServiceUrl(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isConfiguredServiceUrl(value: unknown) {
  const normalized = normalizeServiceUrl(value).toLowerCase();
  return Boolean(normalized && !normalized.includes("example.invalid"));
}

export function formatServiceUrlForDisplay(value: unknown) {
  return isConfiguredServiceUrl(value)
    ? normalizeServiceUrl(value)
    : "未配置（开源默认占位值）";
}

function assertServiceUrlConfigured(value: unknown, label = "服务地址") {
  if (!isConfiguredServiceUrl(value)) {
    throw new Error(
      `${label} 未配置，请先填写真实生产地址，或切换到开发模式连接本地服务`,
    );
  }
}

async function isDevMode() {
  const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.DEV_MODE]);
  return Boolean(result[STORAGE_KEYS.DEV_MODE]);
}

function resolveStoredServiceUrl(storedValue: unknown, fallbackValue: string) {
  const normalized = normalizeServiceUrl(storedValue);
  return isConfiguredServiceUrl(normalized) ? normalized : fallbackValue;
}

async function getApiBaseUrl() {
  const devMode = await isDevMode();
  if (devMode) {
    const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.DEV_API_BASE_URL]);
    return resolveStoredServiceUrl(
      result[STORAGE_KEYS.DEV_API_BASE_URL],
      DEFAULT_CONFIG.DEV_API_BASE_URL,
    );
  }

  const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.API_BASE_URL]);
  return resolveStoredServiceUrl(
    result[STORAGE_KEYS.API_BASE_URL],
    DEFAULT_CONFIG.PROD_API_BASE_URL,
  );
}

async function getWsBaseUrl() {
  const devMode = await isDevMode();
  if (devMode) {
    const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.DEV_WS_BASE_URL]);
    return resolveStoredServiceUrl(
      result[STORAGE_KEYS.DEV_WS_BASE_URL],
      DEFAULT_CONFIG.DEV_WS_BASE_URL,
    );
  }

  const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.WS_BASE_URL]);
  return resolveStoredServiceUrl(
    result[STORAGE_KEYS.WS_BASE_URL],
    DEFAULT_CONFIG.PROD_WS_BASE_URL,
  );
}

async function setDevMode(enabled: boolean) {
  await storageSet({ [STORAGE_KEYS.DEV_MODE]: enabled });
  try {
    await sendRuntimeMessage({
      action: "updateDevMode",
      devMode: enabled,
    });
  } catch {
    // service worker may not be ready yet
  }
}

async function setApiBaseUrl(url: string, isDev = false) {
  const key = isDev ? STORAGE_KEYS.DEV_API_BASE_URL : STORAGE_KEYS.API_BASE_URL;
  await storageSet({ [key]: normalizeServiceUrl(url) });
}

async function setWsBaseUrl(url: string, isDev = false) {
  const key = isDev ? STORAGE_KEYS.DEV_WS_BASE_URL : STORAGE_KEYS.WS_BASE_URL;
  await storageSet({ [key]: normalizeServiceUrl(url) });
}

async function getToken() {
  const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.TOKEN]);
  return (result[STORAGE_KEYS.TOKEN] as string | null) || null;
}

async function setToken(token: string | null) {
  await storageSet({ [STORAGE_KEYS.TOKEN]: token });
}

async function clearToken() {
  await setToken(null);
}

async function getUserInfo() {
  const result = await storageGet<Record<string, unknown>>([STORAGE_KEYS.USER_INFO]);
  return (result[STORAGE_KEYS.USER_INFO] as UserInfo | null) || null;
}

async function setUserInfo(userInfo: UserInfo | null) {
  await storageSet({ [STORAGE_KEYS.USER_INFO]: userInfo });
}

async function clearUserInfo() {
  await setUserInfo(null);
}

function normalizeApiResponse<T>(raw: T) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const candidate = raw as JsonRecord;
  const hasData = Object.prototype.hasOwnProperty.call(candidate, "data");
  const hasEnvelopeMeta =
    Object.prototype.hasOwnProperty.call(candidate, "code") ||
    Object.prototype.hasOwnProperty.call(candidate, "status") ||
    Object.prototype.hasOwnProperty.call(candidate, "msg") ||
    Object.prototype.hasOwnProperty.call(candidate, "message");

  if (hasData && hasEnvelopeMeta) {
    return candidate.data as T;
  }

  return raw;
}

async function apiRequest<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = await getApiBaseUrl();
  const token = await getToken();
  const isAbsoluteUrl = url.startsWith("http://") || url.startsWith("https://");

  if (!isAbsoluteUrl) {
    assertServiceUrlConfigured(baseUrl, "API 基础地址");
  }

  const fullUrl = isAbsoluteUrl
    ? url
    : `${baseUrl.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;

  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const hasBody = options.body !== undefined && options.body !== null;
  if (hasBody && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(fullUrl, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "请求失败");
    let errorMessage = errorText || `HTTP ${response.status}`;

    try {
      const parsed = JSON.parse(errorText) as JsonRecord;
      errorMessage = String(parsed.message || parsed.msg || errorMessage);
    } catch {
      // keep raw text
    }

    const error = new Error(errorMessage);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return normalizeApiResponse(await response.json()) as T;
  }

  return (await response.text()) as T;
}

function getDeviceInfo() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timestamp: new Date().toISOString(),
  };
}

async function fetchUserInfo() {
  try {
    const data = await apiRequest<UserInfo>(API_ENDPOINTS.USER.GET_USER_INFO, {
      method: "POST",
      body: JSON.stringify({}),
    });

    if (!data) {
      throw new Error("获取用户信息失败：响应为空");
    }

    await setUserInfo(data);
    return data;
  } catch (error) {
    const maybeStatus = (error as Error & { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);
    if (maybeStatus === 401 || message.includes("401")) {
      await clearToken();
      await clearUserInfo();
    }
    throw error;
  }
}

async function login(username: string, password: string, rememberMe = false) {
  const apiBaseUrl = await getApiBaseUrl();
  assertServiceUrlConfigured(apiBaseUrl, "API 基础地址");

  const response = await fetch(`${apiBaseUrl}${API_ENDPOINTS.AUTH.LOGIN}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      password,
      terminalType: "extension",
      deviceInfo: getDeviceInfo(),
      rememberMe,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "登录失败");
    let errorMessage = errorText || `HTTP ${response.status}`;

    try {
      const parsed = JSON.parse(errorText) as JsonRecord;
      errorMessage = String(parsed.message || parsed.msg || errorMessage);
    } catch {
      // keep raw text
    }

    throw new Error(errorMessage);
  }

  const data = normalizeApiResponse(await response.json()) as JsonRecord;
  const token = data?.token;

  if (!token || typeof token !== "string") {
    throw new Error("登录响应中未找到 token");
  }

  await setToken(token);
  await fetchUserInfo();
  return data;
}

async function logout() {
  try {
    await apiRequest(API_ENDPOINTS.AUTH.LOGOUT, {
      method: "POST",
    });
  } catch {
    // even if remote logout fails, clear local auth state
  } finally {
    await clearToken();
    await clearUserInfo();
  }
}

export const ApiUtils = {
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
  isConfiguredServiceUrl,
  formatServiceUrlForDisplay,
};
