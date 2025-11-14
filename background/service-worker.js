// service-worker.js: 后台服务 Worker
/* global io, COS */

// 简单的日志函数（在 log 函数定义之前使用）
function simpleLog(...args) {
  console.log('[Core][WS]', ...args);
}

// 脚本加载状态
let scriptsLoaded = {
  cos: false,
  socketio: false,
  error: null
};

// 加载依赖库（不抛出错误，避免 service worker 崩溃）
(function() {
  try {
// 尝试加载 cos-js-sdk-v5 库（优先使用本地文件，如果没有则使用 CDN）
try {
      importScripts('../libs/cos-js-sdk-v5.main.js');
      scriptsLoaded.cos = true;
      simpleLog('COS SDK 已从本地文件加载');
} catch (e) {
  // 如果本地文件不存在，尝试从 CDN 加载
      console.warn('[Core][WS] 本地 COS SDK 文件不存在，尝试从 CDN 加载...', e);
      try {
  importScripts('https://cdn.jsdelivr.net/npm/cos-js-sdk-v5@1.10.1/dist/cos-js-sdk-v5.min.js');
        scriptsLoaded.cos = true;
        simpleLog('COS SDK 已从 CDN 加载');
      } catch (cdnError) {
        console.error('[Core][WS] COS SDK CDN 加载失败:', cdnError);
        scriptsLoaded.error = 'COS SDK 加载失败: ' + cdnError.message;
      }
    }

    // 加载 socket.io 客户端
    try {
importScripts('../libs/socket.io.min.js');
      scriptsLoaded.socketio = true;
      simpleLog('Socket.IO 已加载');
    } catch (e) {
      console.error('[Core][WS] Socket.IO 加载失败:', e);
      scriptsLoaded.error = (scriptsLoaded.error || '') + ' Socket.IO 加载失败: ' + e.message;
    }
  } catch (error) {
    console.error('[Core][WS] 脚本加载过程出现异常:', error);
    scriptsLoaded.error = '脚本加载异常: ' + error.message;
  }
})();

const USE_PRODUCTION_WS = false;
const PROD_WS_ENDPOINT = 'https://1s.design:1520/ws';
const DEV_WS_ENDPOINT = 'http://localhost:1520/ws';
const DEFAULT_WS_ENDPOINT = USE_PRODUCTION_WS ? PROD_WS_ENDPOINT : DEV_WS_ENDPOINT;
const STORAGE_ENDPOINT_KEY = 'wsEndpoint';
const STORAGE_ENDPOINT_CUSTOM_KEY = 'wsEndpointCustom';
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 10000;

const COS_CONFIG = Object.freeze({
  SecretId: 'AKIDMdmaMD0uiNwkVH0gTJFKXaXJyV4hHmAL',
  SecretKey: 'HPdigqyzpgTNICCQnK0ZF6zrrpkbL4un',
  Bucket: '1s-1257307499',
  Region: 'ap-beijing',
});

// COS 客户端实例
let cosClient = null;

// 初始化 COS 客户端（参考 cos.ts 的实现）
function initCOSClient() {
  if (cosClient) {
    return cosClient;
  }

  if (!scriptsLoaded.cos || typeof COS === 'undefined') {
    const errorMsg = scriptsLoaded.error || 'COS SDK 未加载，请确保 cos-js-sdk-v5 库已正确导入';
    log('COS SDK 初始化失败:', errorMsg);
    throw new Error(errorMsg);
  }

  log('初始化 COS 客户端...');
  cosClient = new COS({
    SecretId: COS_CONFIG.SecretId,
    SecretKey: COS_CONFIG.SecretKey,
    Bucket: COS_CONFIG.Bucket,
    Region: COS_CONFIG.Region,
  });

  log('COS 客户端初始化成功');
  return cosClient;
}

// 获取 COS 客户端
function getCOSClient() {
  if (!cosClient) {
    return initCOSClient();
  }
  return cosClient;
}
const SERVER_UPLOAD_URL = 'https://1s.design:1520/api/crawler/material/add';
const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/4040ef7e-9776-4010-bf53-c30e4451b449';
const COS_UPLOAD_PREFIX = 'crawler/pinterest';
const COS_SIGN_TIME_OFFSET = 60; // seconds
const COS_SIGN_TIME_WINDOW = 600; // seconds
const textEncoder = new TextEncoder();

const CLIENT_SOURCE = 'yishe-extension';
const CLIENT_INFO_QUERY_KEY = 'clientInfo';
const CLIENT_SOURCE_QUERY_KEY = 'clientSource';
const CLIENT_VERSION_QUERY_KEY = 'extensionVersion';
const CLIENT_ID_QUERY_KEY = 'clientId';
const LOCATION_CACHE_KEY = 'wsLocationCache';
const LOCATION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const LOCATION_ENDPOINT = 'https://ipapi.co/json/';

let clientMetadata = null;
let clientMetadataPromise = null;
let locationLookupStarted = false;

let wsEndpoint = DEFAULT_WS_ENDPOINT;
let socket = null;
let heartbeatTimer = null;
let heartbeatTimeoutTimer = null;
let lastPingTimestampMs = null;

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

function log(...args) {
  console.log('[Core][WS]', ...args);
}

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

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return input;
}

async function sha1Hex(input) {
  const data = typeof input === 'string' ? textEncoder.encode(input) : toUint8Array(input);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return bufferToHex(hash);
}

async function hmacSha1(key, message) {
  const keyData = typeof key === 'string' ? textEncoder.encode(key) : toUint8Array(key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: { name: 'SHA-1' } }, false, ['sign']);
  const data = typeof message === 'string' ? textEncoder.encode(message) : toUint8Array(message);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(signature);
}

function encodeCosPath(pathname) {
  // COS 路径编码规则：分段编码，保留斜杠
  if (!pathname) return '/';
  // 确保以 / 开头
  const normalized = pathname.startsWith('/') ? pathname : '/' + pathname;
  // 分段编码，但保留斜杠
  return normalized
    .split('/')
    .map((segment) => segment ? encodeURIComponent(segment) : '')
    .join('/');
}

function canonicalizeQuery(params = {}) {
  const entries = Object.entries(params)
    .filter(([key]) => key !== undefined && key !== null)
    .map(([key, value]) => [String(key).toLowerCase(), value === undefined || value === null ? '' : String(value)]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    return { paramList: '', paramString: '' };
  }
  const paramList = entries.map(([key]) => encodeURIComponent(key)).join(';');
  const paramString = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return { paramList, paramString };
}

function canonicalizeHeaders(headers = {}) {
  const normalized = Object.entries(headers)
    .filter(([key]) => key)
    .map(([key, value]) => [String(key).toLowerCase(), (value ?? '').toString().trim()]);
  if (!normalized.length) {
    return { headerList: '', headerString: '' };
  }
  normalized.sort((a, b) => a[0].localeCompare(b[0]));
  // headerList: 用于 q-header-list，需要对 key 进行 URL 编码，用分号连接
  const headerList = normalized.map(([key]) => encodeURIComponent(key)).join(';');
  // headerString: 用于 FormatString，格式为 key=value&key=value
  // 根据腾讯云 COS 文档，key 和 value 都需要 URL 编码
  const headerString = normalized
    .map(([key, value]) => {
      const encodedKey = encodeURIComponent(key);
      const encodedValue = encodeURIComponent(value);
      return `${encodedKey}=${encodedValue}`;
    })
    .join('&');
  return { headerList, headerString };
}

function getSignTimeWindow() {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.max(now - COS_SIGN_TIME_OFFSET, 0);
  const end = now + COS_SIGN_TIME_WINDOW;
  return `${start};${end}`;
}

async function generateCosAuthorization({ method, pathname, host, params = {}, headers: customHeaders = {} }) {
  const methodLower = method.toLowerCase();
  const signTime = getSignTimeWindow();
  const keyTime = signTime;
  const { paramList, paramString } = canonicalizeQuery(params);
  
  // 构建签名所需的请求头（只包含需要参与签名的头部）
  const signHeaders = {
    host: host.toLowerCase(),
    ...customHeaders
  };
  
  // 移除空值的头部
  Object.keys(signHeaders).forEach(key => {
    if (!signHeaders[key]) {
      delete signHeaders[key];
    }
  });
  
  const { headerList, headerString } = canonicalizeHeaders(signHeaders);
  
  // 确保 pathname 以 / 开头（用于签名）
  const normalizedPathname = pathname && pathname.startsWith('/') ? pathname : '/' + (pathname || '');
  
  // 重要：根据 COS 签名规范，FormatString 中的路径应该是原始路径（未编码）
  // 但实际请求 URL 中的路径需要编码
  // 这里使用原始路径进行签名
  const signPath = normalizedPathname;
  
  // 构建格式字符串（必须严格按照格式：method\npathname\nparamString\nheaderString\n）
  // 注意：pathname 使用原始路径，不是编码后的路径
  // 确保格式正确：每个部分后面都有换行符，最后还有一个换行符
  const formatString = `${methodLower}\n${signPath}\n${paramString}\n${headerString}\n`;
  
  // 计算格式字符串的 SHA1
  const formatSha1 = await sha1Hex(formatString);
  const stringToSign = `sha1\n${signTime}\n${formatSha1}\n`;
  
  // 详细日志输出
  log('[COS Sign] === 签名调试信息 ===');
  log('[COS Sign] 方法:', methodLower);
  log('[COS Sign] 路径（原始，用于签名）:', signPath);
  log('[COS Sign] 路径长度:', signPath.length);
  log('[COS Sign] 参数字符串:', paramString || '(空)');
  log('[COS Sign] 头部字符串:', headerString || '(空)');
  log('[COS Sign] Header List:', headerList || '(空)');
  log('[COS Sign] 格式字符串（十六进制）:', Array.from(new TextEncoder().encode(formatString)).map(b => b.toString(16).padStart(2, '0')).join(' '));
  log('[COS Sign] 格式字符串（可见字符）:', formatString.replace(/\n/g, '\\n'));
  log('[COS Sign] FormatString SHA1:', formatSha1);
  log('[COS Sign] StringToSign:', stringToSign.replace(/\n/g, '\\n'));
  log('[COS Sign] ====================');
  
  const signKeyBytes = await hmacSha1(COS_CONFIG.SecretKey, keyTime);
  const signatureBytes = await hmacSha1(signKeyBytes, stringToSign);
  const signature = bufferToHex(signatureBytes.buffer);
  
  const authorization = `q-sign-algorithm=sha1` +
    `&q-ak=${COS_CONFIG.SecretId}` +
    `&q-sign-time=${signTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}` +
    `&q-url-param-list=${paramList}` +
    `&q-signature=${signature}`;
  
  log('[COS Sign] 签名:', authorization.substring(0, 100) + '...');
  
  return {
    authorization,
    signTime,
  };
}

function buildCosHost() {
  return `${COS_CONFIG.Bucket}.cos.${COS_CONFIG.Region}.myqcloud.com`;
}

function sanitizeFileName(name) {
  if (!name) return 'item';
  return name
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'item';
}

function guessExtension(url, contentType) {
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

async function downloadImageAsBlob(url) {
  const response = await fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
  }).catch((error) => {
    throw new Error(`下载图片失败: ${serializeError(error)}`);
  });

  if (!response || !response.ok) {
    const status = response ? `${response.status} ${response.statusText}` : '网络错误';
    throw new Error(`下载图片失败 (${status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  const blob = await response.blob();
  return { blob, contentType, size: blob.size };
}

// 使用 fetch API 上传文件到 COS（Service Worker 环境，不支持 XMLHttpRequest）
async function cosPutObject(key, blob) {
  try {
    log('[COS Upload] 开始上传文件到 COS...');
    log('[COS Upload] Key:', key);
    log('[COS Upload] Blob 类型:', typeof blob);
    log('[COS Upload] Blob 大小:', blob?.size);
    log('[COS Upload] Blob 名称:', blob?.name);

    // 构建 COS 上传 URL
    const host = buildCosHost();
    // pathname 应该以 / 开头，不先编码
    const pathname = '/' + (key.startsWith('/') ? key.slice(1) : key);
    // 编码后的路径用于 URL
    const encodedPath = encodeCosPath(pathname);
    const url = `https://${host}${encodedPath}`;
    
    log('[COS Upload] 原始路径:', pathname);
    log('[COS Upload] 编码路径:', encodedPath);
    log('[COS Upload] 上传 URL:', url);

    // 构建请求头（用于签名和请求）
    const contentType = blob.type || 'application/octet-stream';
    const contentLength = String(blob.size);
    
    // 注意：COS 签名规范中，如果请求头包含在 header-list 中，则必须参与签名
    // 为了简化，我们先只包含 host，如果失败再添加其他头部
    const { authorization } = await generateCosAuthorization({
      method: 'PUT',
      pathname: pathname, // 使用原始路径，函数内部会编码
      host: host,
      // 暂时不包含 content-type 和 content-length 在签名中，先测试
      // 如果需要，可以添加：headers: { 'content-type': contentType }
    });

    log('[COS Upload] 签名已生成');

    // 使用 fetch API 上传文件（使用编码后的路径）
    // 注意：不要手动设置 Host 头，浏览器会自动设置
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': authorization,
        'Content-Type': contentType,
        'Content-Length': contentLength,
        // 不要设置 Host，浏览器会自动设置
      },
      body: blob,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      log('[COS Upload] 错误响应:', errorText);
      throw new Error(`COS 上传失败: ${response.status} ${response.statusText} - ${errorText}`);
    }

    log('[COS Upload] 上传成功');
    
    // 构建文件 URL（使用编码后的路径）
    const fileUrl = `https://${host}${encodedPath}`;
    
    return {
      key: key,
      url: fileUrl,
    };
  } catch (error) {
    log('[COS Upload] 上传失败:', serializeError(error));
    throw new Error(`COS 上传失败: ${serializeError(error)}`);
  }
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

function buildDatePath() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

async function processPinterestUploadCommand(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const options = payload?.options || {};
  const notifyFeishu = Boolean(options.notifyFeishu);
  const description = (options.description || '').trim();
  const source = (options.source || 'pinterest').trim() || 'pinterest';
  const pageInfo = options.page || null;

  if (!items.length) {
    return {
      success: false,
      error: '没有可处理的图片数据',
    };
  }

  const results = [];
  let successCount = 0;
  let failCount = 0;

  log('[Pinterest] 开始处理图片，数量:', items.length);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const resultEntry = {
      id: item?.id || item?.imageUrl || `item-${index}`,
      imageUrl: item?.imageUrl,
      description: item?.description || item?.alt || '',
    };

    try {
      if (!item?.imageUrl) {
        throw new Error('缺少图片地址');
      }

      log(`[Pinterest] 正在下载图片 ${index + 1}/${items.length}:`, item.imageUrl);

      // 只下载图片，不上传
      const download = await downloadImageAsBlob(item.imageUrl);
      const extension = guessExtension(item.imageUrl, download.contentType);
      const baseName = sanitizeFileName(item?.id || `pin-${index + 1}`);

      // 将 Blob 转换为 base64 或创建 Blob URL（在 Service Worker 中）
      // 由于 Service Worker 不能直接创建 Blob URL，我们需要转换为 base64
      const base64 = await blobToBase64(download.blob);
      
      resultEntry.downloaded = true;
      resultEntry.blobSize = download.size;
      resultEntry.contentType = download.contentType;
      resultEntry.extension = extension.replace('.', '').toLowerCase();
      resultEntry.baseName = baseName;
      resultEntry.dataUrl = `data:${download.contentType};base64,${base64}`;
      resultEntry.meta = {
        original: {
          id: item?.id,
          imageUrl: item?.imageUrl,
          description: item?.description || item?.alt || '',
        },
        page: pageInfo,
        collectedAt: payload?.collectedAt || new Date().toISOString(),
      };

      successCount += 1;
      log(`[Pinterest] 图片 ${index + 1} 处理成功`);
    } catch (error) {
      failCount += 1;
      resultEntry.error = serializeError(error);
      log('[Pinterest] 单项处理失败:', resultEntry.error);
    }

    results.push(resultEntry);
  }

  if (notifyFeishu) {
    const lines = [
      'Pinterest 采集任务完成 ✅',
      `成功: ${successCount}，失败: ${failCount}`,
      `来源: ${source}`,
    ];
    if (pageInfo?.url) {
      lines.push(`页面: ${pageInfo.url}`);
    }
    if (failCount) {
      const failedExample = results.filter((item) => item.error).slice(0, 3);
      if (failedExample.length) {
        lines.push('失败示例:');
        failedExample.forEach((entry) => {
          lines.push(`- ${entry.imageUrl} => ${entry.error}`);
        });
      }
    }
    await sendFeishuNotification(lines);
  }

  const summary = {
    success: failCount === 0,
    successCount,
    failCount,
    items: results,
    source,
    page: pageInfo,
    message: `成功获取 ${successCount} 张图片${failCount > 0 ? `，${failCount} 张失败` : ''}`,
  };

  if (failCount > 0) {
    summary.error = '部分图片获取失败';
  }

  log('[Pinterest] 处理完成:', summary);
  return summary;
}

// 将 Blob 转换为 Base64（用于在 Service Worker 中传递图片数据）
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // base64 字符串（去掉 data:xxx;base64, 前缀）
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function handleControlFeatureExecute(request) {
  const featureId = request?.featureId;
  const payload = request?.payload || {};

  if (featureId === 'pinterest-scraper') {
    if (payload.command === 'pinterest/upload') {
      return await processPinterestUploadCommand(payload);
    }
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

  const metadata = await ensureClientMetadata();
  const query = buildConnectionQuery(metadata);

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

function handleAdminMessage(data) {
  log('[handleAdminMessage] 开始处理管理员消息');
  log('[handleAdminMessage] 输入数据:', data);
  
  try {
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

async function ensureEndpoint() {
  try {
    const result = await storageGet([STORAGE_ENDPOINT_KEY, STORAGE_ENDPOINT_CUSTOM_KEY]);
    const storedEndpoint = result[STORAGE_ENDPOINT_KEY];
    const isCustom = Boolean(result[STORAGE_ENDPOINT_CUSTOM_KEY]);

    if (isCustom && storedEndpoint) {
      wsEndpoint = storedEndpoint;
      log('使用自定义 WebSocket 端点:', wsEndpoint);
    } else {
      wsEndpoint = DEFAULT_WS_ENDPOINT;
      log('使用默认 WebSocket 端点:', wsEndpoint);
      await storageSet({
        [STORAGE_ENDPOINT_KEY]: DEFAULT_WS_ENDPOINT,
        [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
      }).catch((error) => {
        log('写入默认端点失败（可忽略）:', serializeError(error));
      });
    }
  } catch (error) {
    log('确保端点时出错，使用默认端点:', serializeError(error));
    wsEndpoint = DEFAULT_WS_ENDPOINT;
    storageSet({
      [STORAGE_ENDPOINT_KEY]: DEFAULT_WS_ENDPOINT,
      [STORAGE_ENDPOINT_CUSTOM_KEY]: false,
    }).catch((err) => {
      log('写入默认端点失败（可忽略）:', serializeError(err));
    });
  }

  updateWsState({ endpoint: wsEndpoint });
}

function setEndpoint(newEndpoint, callback) {
  const normalized = typeof newEndpoint === 'string' ? newEndpoint.trim() : '';
  const effectiveEndpoint = normalized || DEFAULT_WS_ENDPOINT;
  const isCustom = Boolean(normalized) && effectiveEndpoint !== DEFAULT_WS_ENDPOINT;

  storageSet({
    [STORAGE_ENDPOINT_KEY]: effectiveEndpoint,
    [STORAGE_ENDPOINT_CUSTOM_KEY]: isCustom,
  })
    .then(() => {
      wsEndpoint = effectiveEndpoint;
      updateWsState({ endpoint: wsEndpoint });
      log('WebSocket 端点已更新为:', wsEndpoint, '(custom:', isCustom, ')');
      if (socket) {
        log('端点变更，重新初始化连接');
        initWebsocket();
      }
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

async function initialize() {
  try {
    await ensureEndpoint();
    await ensureClientMetadata();
    prefetchLocationInfo();
    // 初始化前先广播一次状态（确保 popup 能获取到初始状态）
    broadcastWsState();
    await initWebsocket();
    // 初始化后再次广播状态（确保状态已更新）
    broadcastWsState();
  } catch (error) {
    log('初始化 WebSocket 失败:', serializeError(error));
    updateWsState({
      status: 'error',
      lastError: serializeError(error),
    });
  }
}

// 全局错误处理
self.addEventListener('error', (event) => {
  console.error('[Core][WS] Service Worker 全局错误:', event.error);
  log('Service Worker 全局错误: ' + serializeError(event.error));
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[Core][WS] Service Worker 未处理的 Promise 拒绝:', event.reason);
  log('Service Worker 未处理的 Promise 拒绝: ' + serializeError(event.reason));
});

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

// 初始化 Service Worker
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

  if (request.action === 'reconnectWebsocket') {
    initWebsocket();
    sendResponse({ success: true });
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

