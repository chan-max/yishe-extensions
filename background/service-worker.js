// service-worker.js: 后台服务 Worker
/* global io */

// 简单的日志函数（在 log 函数定义之前使用）
function simpleLog(...args) {
  console.log('[Core][WS]', ...args);
}

// 脚本加载状态
let scriptsLoaded = {
  socketio: false,
  error: null
};

// 加载依赖库（不抛出错误，避免 service worker 崩溃）
(function() {
  try {
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

async function processPinterestUploadCommand(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const options = payload?.options || {};
  const notifyFeishu = Boolean(options.notifyFeishu);
  const description = (options.description || '').trim();
  const source = (options.source || 'pinterest').trim() || 'pinterest';
  const pageInfo = options.page || null;
  const uploadToServer = Boolean(options.uploadToServer);

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

      log(`[Pinterest] 正在处理图片 ${index + 1}/${items.length}:`, item.imageUrl);

      // 获取图片后缀
      const extension = guessExtension(item.imageUrl, null);
      const suffix = extension.replace('.', '').toLowerCase() || 'jpg';

      // 如果启用上传到服务器，则上传到 crawler 表
      if (uploadToServer) {
        try {
          // 构建上传到服务器的 payload
          const serverPayload = {
            url: item.imageUrl, // 使用原始地址作为 url
            originUrl: item.imageUrl, // 原始地址
            name: item?.description || item?.alt || `Pinterest图片_${index + 1}`,
            description: description || item?.description || item?.alt || '',
            keywords: item?.description || item?.alt || '',
            suffix: suffix,
            source: source,
            meta: {
              original: {
                id: item?.id,
                imageUrl: item?.imageUrl,
                description: item?.description || item?.alt || '',
                url: item?.url , // Pinterest pin 页面链接
              },
              page: pageInfo,
              collectedAt: payload?.collectedAt || new Date().toISOString(),
            },
          };

          log(`[Pinterest] 正在上传到服务器 ${index + 1}/${items.length}`);
          const serverResponse = await uploadMaterialToServer(serverPayload);
          
          resultEntry.serverStatus = 'success';
          resultEntry.serverResponse = serverResponse;
          log(`[Pinterest] 图片 ${index + 1} 上传到服务器成功`);
        } catch (serverError) {
          resultEntry.serverStatus = 'failed';
          resultEntry.serverError = serializeError(serverError);
          log(`[Pinterest] 图片 ${index + 1} 上传到服务器失败:`, resultEntry.serverError);
          // 上传失败不影响整体流程，继续处理
        }
      }

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
    message: `成功处理 ${successCount} 张图片${failCount > 0 ? `，${failCount} 张失败` : ''}`,
  };

  if (failCount > 0) {
    summary.error = '部分图片处理失败';
  }

  log('[Pinterest] 处理完成:', summary);
  return summary;
}

const PINTEREST_SCHEDULE_ALARM_NAME = 'pinterest-scheduled-scrape';
const PINTEREST_SCHEDULE_STORAGE_KEY = 'pinterestScheduleConfig';

async function handlePinterestSchedule(payload) {
  const action = payload?.action;
  
  if (action === 'set') {
    const intervalMinutes = payload?.intervalMinutes || 60;
    const params = payload?.params || {};
    
    // 保存定时任务配置
    const scheduleConfig = {
      params,
      intervalMinutes,
      createdAt: new Date().toISOString(),
    };
    
    try {
      await storageSet({ [PINTEREST_SCHEDULE_STORAGE_KEY]: scheduleConfig });
      
      // 清除旧的定时任务
      try {
        await chrome.alarms.clear(PINTEREST_SCHEDULE_ALARM_NAME);
      } catch (e) {
        // 忽略清除失败（可能不存在）
      }
      
      // 创建新的定时任务（周期性的）
      chrome.alarms.create(PINTEREST_SCHEDULE_ALARM_NAME, {
        periodInMinutes: intervalMinutes,
      });
      
      log(`[Pinterest] 定时任务已设置：每 ${intervalMinutes} 分钟执行一次`);
      return {
        success: true,
        message: `定时任务已设置：每 ${intervalMinutes} 分钟执行一次`,
      };
    } catch (error) {
      log('[Pinterest] 设置定时任务失败:', serializeError(error));
      return {
        success: false,
        error: serializeError(error),
      };
    }
  } else if (action === 'clear') {
    try {
      await chrome.alarms.clear(PINTEREST_SCHEDULE_ALARM_NAME);
      await storageSet({ [PINTEREST_SCHEDULE_STORAGE_KEY]: null });
      log('[Pinterest] 定时任务已清除');
      return {
        success: true,
        message: '定时任务已清除',
      };
    } catch (error) {
      log('[Pinterest] 清除定时任务失败:', serializeError(error));
      return {
        success: false,
        error: serializeError(error),
      };
    }
  } else if (action === 'get') {
    try {
      const config = await storageGet([PINTEREST_SCHEDULE_STORAGE_KEY]);
      const scheduleConfig = config[PINTEREST_SCHEDULE_STORAGE_KEY];
      
      // 检查定时任务是否存在
      const alarm = await new Promise((resolve) => {
        chrome.alarms.get(PINTEREST_SCHEDULE_ALARM_NAME, (alarm) => {
          resolve(alarm);
        });
      });
      
      return {
        success: true,
        enabled: Boolean(alarm && scheduleConfig),
        config: scheduleConfig,
        nextAlarmTime: alarm?.scheduledTime || null,
      };
    } catch (error) {
      return {
        success: false,
        error: serializeError(error),
      };
    }
  }
  
  return {
    success: false,
    error: '未知的定时任务操作',
  };
}

// Pinterest 爬取相关的辅助函数（在页面上下文中执行）
async function scrapePinsInPage(options = {}) {
  try {
    const {
      maxCount = 50,
      maxRounds = 60,
      scrollDelay = 1200,
      maxIdleRounds = 3,
      timeout = 60000,
    } = options;

    const start = Date.now();
    const seen = new Set();
    const items = [];
    let idleRounds = 0;

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function collectOnce() {
      const pins = [];
      document
        .querySelectorAll('div[data-test-id="pin"], [data-grid-item="true"]')
        .forEach((pinElement) => {
          const linkElement = pinElement.querySelector('a[href*="/pin/"]');
          const imgElement = pinElement.querySelector('img');
          const descriptionElement = pinElement.querySelector('[data-test-id="pin-description"]');

          if (!linkElement || !imgElement) {
            return;
          }

          const idMatch = linkElement.href.match(/\/pin\/(\d+)/);
          const id = idMatch ? idMatch[1] : linkElement.href;
          if (!id || seen.has(id)) {
            return;
          }

          seen.add(id);

          const imageUrl = imgElement.srcset
            ? imgElement.srcset.split(',').pop().trim().split(' ')[0]
            : imgElement.currentSrc || imgElement.src;

          pins.push({
            id,
            url: linkElement.href,
            imageUrl,
            alt: imgElement.alt || imgElement.title || '',
            description: descriptionElement ? descriptionElement.innerText.trim() : '',
          });
        });
      return pins;
    }

    for (let round = 0; round < maxRounds; round += 1) {
      if (Date.now() - start > timeout) {
        break;
      }

      const newPins = collectOnce();
      if (newPins.length === 0) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
        items.push(...newPins);
      }

      if (items.length >= maxCount) {
        break;
      }

      if (idleRounds >= maxIdleRounds) {
        break;
      }

      window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
      await sleep(scrollDelay);
    }

    return {
      items,
      collectedAt: new Date().toISOString(),
      page: {
        url: location.href,
        title: document.title,
      },
      metrics: {
        elapsedMs: Date.now() - start,
        total: items.length,
      },
    };
  } catch (error) {
    return { error: error?.message || '采集过程中出现未知错误' };
  }
}

function waitForPinsInPage(timeoutMs = 15000, pollInterval = 600) {
  const start = Date.now();

  function hasPins() {
    return document.querySelector('div[data-test-id="pin"], [data-grid-item="true"]');
  }

  if (hasPins()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (hasPins()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, pollInterval);
  });
}

async function createTabAndWait(url, timeoutMs = 45000) {
  if (!chrome?.tabs?.create) {
    throw new Error('当前环境不支持创建标签页');
  }

  // 在后台打开标签页，不激活（不跳转）
  const tab = await new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (createdTab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || '创建标签页失败'));
        return;
      }
      resolve(createdTab);
    });
  });

  await waitForTabComplete(tab.id, timeoutMs);
  return tab;
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待页面加载超时，可能网络较慢或链接不可达'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve(tab);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function executeScrape(tabId, options) {
  if (!chrome?.scripting?.executeScript) {
    throw new Error('当前环境不支持脚本注入，请检查扩展权限');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapePinsInPage,
    args: [options],
  });

  const first = Array.isArray(results) ? results[0] : null;
  const result = first?.result;

  if (!result || typeof result !== 'object') {
    throw new Error('采集结果无效，可能页面结构发生变更');
  }
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

async function waitForPinContent(tabId, timeoutMs, pollInterval) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: waitForPinsInPage,
    args: [timeoutMs, pollInterval],
  });

  const first = Array.isArray(results) ? results[0] : null;
  return Boolean(first?.result);
}

async function executeScheduledPinterestScrape(params) {
  // 如果提供了参数，使用参数执行；否则从存储中读取定时任务配置
  if (params) {
    return await executePinterestScrapeWithParams(params);
  }
  
  log('[Pinterest] 开始执行定时爬取任务');
  
  const DEFAULT_SOURCE = 'pinterest';
  
  try {
    // 获取定时任务配置
    const config = await storageGet([PINTEREST_SCHEDULE_STORAGE_KEY]);
    const scheduleConfig = config[PINTEREST_SCHEDULE_STORAGE_KEY];
    
    if (!scheduleConfig || !scheduleConfig.params) {
      log('[Pinterest] 定时任务配置不存在，跳过执行');
      return {
        success: false,
        error: '定时任务配置不存在',
      };
    }
    
    const taskParams = scheduleConfig.params;
    
    log('[Pinterest] 定时任务参数:', {
      targetUrl: taskParams.targetUrl,
      maxCount: taskParams.count,
      uploadToServer: taskParams.uploadToServer,
      notifyFeishu: taskParams.notifyFeishu,
    });
    
    // 执行爬取
    const result = await executePinterestScrapeWithParams(taskParams);
    
    // 如果需要上传到服务器
    const shouldUpload = Boolean(taskParams?.uploadToServer || taskParams?.notifyFeishu);
    if (shouldUpload && result?.data?.items?.length) {
      log('[Pinterest] 采集完成，正在准备上传到服务器…');
      
      try {
        const uploadResponse = await processPinterestUploadCommand({
          items: result.data.items,
          options: {
            uploadToServer: Boolean(taskParams.uploadToServer),
            notifyFeishu: Boolean(taskParams.notifyFeishu),
            description: taskParams.description || '',
            source: taskParams.sourceTag?.trim() || DEFAULT_SOURCE,
            page: result.data.page || null,
          },
        });
        
        if (uploadResponse?.items) {
          const { successCount = 0, failCount = 0 } = uploadResponse;
          log(`[Pinterest] 上传完成：成功 ${successCount} 条${failCount ? `，失败 ${failCount} 条` : ''}`);
        } else if (uploadResponse?.error) {
          log(`[Pinterest] 上传失败：${uploadResponse.error}`);
        }
      } catch (error) {
        log('[Pinterest] 上传过程出现异常:', serializeError(error));
      }
    }
    
    log('[Pinterest] 定时爬取任务执行完成');
    return result;
  } catch (error) {
    log('[Pinterest] 执行定时爬取任务失败:', serializeError(error));
    return {
      success: false,
      error: serializeError(error),
    };
  }
}

async function handleControlFeatureExecute(request) {
  const featureId = request?.featureId;
  const payload = request?.payload || {};

  if (featureId === 'pinterest-scraper') {
    if (payload.command === 'pinterest/upload') {
      return await processPinterestUploadCommand(payload);
    }
    if (payload.command === 'pinterest/schedule') {
      return await handlePinterestSchedule(payload);
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
    // 检查是否是 Pinterest 爬取命令
    if (data && typeof data === 'object' && data.command === 'pinterest/scrape') {
      log('[handleAdminMessage] 收到 Pinterest 爬取命令');
      handlePinterestScrapeCommand(data).catch((error) => {
        log('[handleAdminMessage] 处理 Pinterest 爬取命令失败:', serializeError(error));
      });
      return; // 爬取命令不需要存储和通知
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

// 处理 Pinterest 爬取命令
async function handlePinterestScrapeCommand(data) {
  const params = data.params || {};
  const DEFAULT_URL = 'https://www.pinterest.com/today/';
  const DEFAULT_MAX_COUNT = 10;
  const DEFAULT_SOURCE = 'pinterest';
  
  log('[Pinterest] 收到爬取命令:', params);
  
  try {
    // 执行爬取任务
    const result = await executeScheduledPinterestScrape(params);
    
    // 如果需要上传到服务器
    const shouldUpload = Boolean(params?.uploadToServer || params?.notifyFeishu);
    if (shouldUpload && result?.data?.items?.length) {
      log('[Pinterest] 开始上传到服务器…');
      
      try {
        const uploadResponse = await processPinterestUploadCommand({
          items: result.data.items,
          options: {
            uploadToServer: Boolean(params.uploadToServer),
            notifyFeishu: Boolean(params.notifyFeishu),
            description: params.description || '',
            source: params.sourceTag?.trim() || DEFAULT_SOURCE,
            page: result.data.page || null,
          },
        });
        
        if (uploadResponse?.items) {
          const { successCount = 0, failCount = 0 } = uploadResponse;
          log(`[Pinterest] 上传完成：成功 ${successCount} 条${failCount ? `，失败 ${failCount} 条` : ''}`);
        } else if (uploadResponse?.error) {
          log(`[Pinterest] 上传失败：${uploadResponse.error}`);
        }
      } catch (error) {
        log('[Pinterest] 上传过程出现异常:', serializeError(error));
      }
    }
    
    // 通过 WebSocket 发送结果回管理系统（如果需要）
    if (socket && socket.connected) {
      socket.emit('pinterest-scrape-result', {
        success: true,
        message: result.message || '爬取完成',
        data: {
          itemCount: result.data?.items?.length || 0,
          timestamp: new Date().toISOString(),
        },
      });
    }
  } catch (error) {
    log('[Pinterest] 处理爬取命令失败:', serializeError(error));
    
    // 通过 WebSocket 发送错误回管理系统
    if (socket && socket.connected) {
      socket.emit('pinterest-scrape-result', {
        success: false,
        error: serializeError(error),
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// 执行 Pinterest 爬取任务（接受参数）
async function executePinterestScrapeWithParams(params) {
  const DEFAULT_URL = 'https://www.pinterest.com/today/';
  const CONTENT_SCRIPT_TIMEOUT = 60000;
  const PIN_READY_TIMEOUT = 15000;
  const PIN_READY_POLL_INTERVAL = 600;
  const DEFAULT_MAX_COUNT = 10;
  
  const targetUrl = params?.targetUrl?.trim() || DEFAULT_URL;
  const maxCount = params?.count && Number.isFinite(params.count) ? params.count : DEFAULT_MAX_COUNT;
  let tab = null;
  
  try {
    log('[Pinterest] 开始执行爬取任务:', { targetUrl, maxCount });
    
    // 创建标签页并等待加载
    tab = await createTabAndWait(targetUrl);
    
    log('[Pinterest] 页面加载完成，等待内容渲染…');
    
    // 等待内容渲染
    const ready = await waitForPinContent(tab.id, PIN_READY_TIMEOUT, PIN_READY_POLL_INTERVAL);
    if (!ready) {
      throw new Error('在限定时间内未检测到图片列表，请确认页面内容或登录状态');
    }
    
    log('[Pinterest] 内容就绪，开始采集图片…');
    const scrapeOptions = {
      maxCount,
      scrollDelay: 1200,
      maxRounds: 60,
      maxIdleRounds: 3,
      timeout: CONTENT_SCRIPT_TIMEOUT,
    };
    
    // 执行爬取
    const data = await executeScrape(tab.id, scrapeOptions);
    
    log(`[Pinterest] 采集完成，共 ${data.items.length} 条图片链接`);
    
    return {
      success: true,
      data,
      message: `采集完成，共 ${data.items.length} 条图片链接`,
    };
  } catch (error) {
    log('[Pinterest] 执行爬取任务失败:', serializeError(error));
    return {
      success: false,
      error: serializeError(error),
    };
  } finally {
    // 运行结束后自动关闭标签页
    if (tab && tab.id) {
      try {
        chrome.tabs.remove(tab.id, () => {
          if (chrome.runtime.lastError) {
            log('[Pinterest] 关闭标签页失败:', chrome.runtime.lastError.message);
          } else {
            log('[Pinterest] 标签页已自动关闭');
          }
        });
      } catch (error) {
        log('[Pinterest] 关闭标签页异常:', serializeError(error));
      }
    }
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
    await ensureEndpoint();
    await ensureClientMetadata();
    prefetchLocationInfo();
    // 初始化前先广播一次状态（确保 popup 能获取到初始状态）
    broadcastWsState();
    await initWebsocket();
    // 初始化后再次广播状态（确保状态已更新）
    broadcastWsState();
    // 恢复 Pinterest 定时任务
    await restorePinterestSchedule();
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

// 监听定时任务触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PINTEREST_SCHEDULE_ALARM_NAME) {
    log('[Pinterest] 定时任务触发:', alarm);
    executeScheduledPinterestScrape().catch((error) => {
      log('[Pinterest] 定时任务执行失败:', serializeError(error));
    });
  }
});

