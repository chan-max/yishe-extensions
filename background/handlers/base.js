// handlers/base.js: 消息处理器基础工具函数
(function(global) {
  'use strict';

  /**
   * 序列化错误对象为字符串
   */
  global.MessageHandlers = global.MessageHandlers || {};
  global.MessageHandlers.Base = {
    serializeError(error) {
      if (!error) return 'Unknown error';
      if (typeof error === 'string') return error;
      if (error.message) return error.message;
      try {
        return JSON.stringify(error);
      } catch (e) {
        return String(error);
      }
    },

    /**
     * 从 URL 或 Content-Type 猜测文件扩展名
     */
    guessExtension(url, contentType) {
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
    },

    /**
     * 创建标签页并等待加载完成
     */
    async createTabAndWait(url, timeoutMs = 45000) {
      if (!chrome?.tabs?.create) {
        throw new Error('当前环境不支持创建标签页');
      }

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

      await this.waitForTabComplete(tab.id, timeoutMs);
      return tab;
    },

    /**
     * 等待标签页加载完成
     */
    waitForTabComplete(tabId, timeoutMs = 45000) {
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
    },

    /**
     * 执行脚本注入
     */
    async executeScript(tabId, func, args = []) {
      if (!chrome?.scripting?.executeScript) {
        throw new Error('当前环境不支持脚本注入，请检查扩展权限');
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
      });

      const first = Array.isArray(results) ? results[0] : null;
      return first?.result;
    },

    /**
     * Storage 工具函数
     */
    storageGet(keys) {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, (result) => {
          resolve(result || {});
        });
      });
    },

    storageSet(data) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(data, () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(undefined);
          }
        });
      });
    },
  };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

