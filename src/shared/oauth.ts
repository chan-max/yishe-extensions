/**
 * OAuth 2.0 授权码模式 - 浏览器插件客户端
 *
 * 流程：
 * 1. 打开标签页跳转到 yishe-admin 授权页面
 * 2. 用户授权后回调到指定页面
 * 3. 提取 code 并换取 token
 *
 * 环境兼容：
 * - 开发环境：localhost:1521
 * - 生产环境：admin.1s.design
 */

import { API_ENDPOINTS } from './api-config'
import { storageGet, storageSet, getExtensionUrl } from './extension'
import { STORAGE_KEYS } from './api-utils'

/** OAuth 客户端配置 */
const OAUTH_CLIENT_ID = 'yishe-extension'
const OAUTH_CLIENT_SECRET = 'yishe-extension-secret-2026'
const OAUTH_SCOPE = 'user:read user:write'

/** 回调页面路径（本地 HTML 页面，用于接收授权码） */
const CALLBACK_PAGE = '/oauth-callback.html'

/** 获取 API 基础地址 */
async function getApiBaseUrl(): Promise<string> {
  const result = await storageGet<Record<string, unknown>>([
    STORAGE_KEYS.API_BASE_URL,
  ])
  const stored = result[STORAGE_KEYS.API_BASE_URL]
  if (typeof stored === 'string' && stored.trim()) {
    return stored.trim()
  }
  return 'https://api.1s.design/api'
}

/** 获取授权页面 URL */
function getAuthorizeBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.includes('localhost')) {
    return 'http://localhost:1521'
  }
  return 'https://admin.1s.design'
}

/** 获取回调地址 */
function getRedirectUri(): string {
  // 使用插件自身的回调页面
  return getExtensionUrl(CALLBACK_PAGE)
}

/** 生成授权 URL */
export function buildAuthorizeUrl(apiBaseUrl: string, state?: string): string {
  const baseUrl = getAuthorizeBaseUrl(apiBaseUrl)
  const redirectUri = getRedirectUri()
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPE,
  })
  if (state) {
    params.set('state', state)
  }
  return `${baseUrl}/oauth/authorize?${params.toString()}`
}

/** 打开授权页面 */
export async function openAuthorizePage(): Promise<void> {
  const apiBaseUrl = await getApiBaseUrl()
  const url = buildAuthorizeUrl(apiBaseUrl)

  const tabsApi = typeof chrome !== 'undefined' && chrome.tabs ? chrome.tabs : (typeof browser !== 'undefined' ? browser.tabs : null)
  if (tabsApi?.create) {
    tabsApi.create({ url })
  } else {
    window.open(url, '_blank')
  }
}

/** 用授权码换取 token */
export async function exchangeToken(code: string): Promise<string> {
  const apiBaseUrl = await getApiBaseUrl()
  const redirectUri = getRedirectUri()

  const response = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Token 交换失败')
    throw new Error(errorText)
  }

  const data = await response.json()
  const token = data.accessToken || data.access_token
  if (!token) {
    throw new Error('响应中未找到 token')
  }

  // 保存 token
  await storageSet({ [STORAGE_KEYS.TOKEN]: token })
  return token
}

/** 从 URL 中提取授权码 */
export function extractCodeFromUrl(url: string): { code: string; state?: string } | null {
  try {
    const urlObj = new URL(url)
    const code = urlObj.searchParams.get('code')
    if (!code) return null
    const state = urlObj.searchParams.get('state') || undefined
    return { code, state }
  } catch {
    return null
  }
}
