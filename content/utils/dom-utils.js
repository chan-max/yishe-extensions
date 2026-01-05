// dom-utils.js: DOM 操作工具函数 + 全局 Toast 消息提示
//
// 说明：
// - 这里封装了一套轻量的 DOM / storage / runtime 工具
// - 同时提供一个统一的 Toast 系统（成功 / 失败 / 警告 / 普通），
//   在任意页面都可以调用，并支持自动消失 + 动画 +堆叠展示。

// 创建全局工具对象（DOM / storage / runtime）
window.CoreDOMUtils = {
  // 创建元素
  createElement(tag, className = '', innerHTML = '') {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (innerHTML) {
      element.innerHTML = innerHTML;
    }
    return element;
  },

  // 添加样式
  addStyles(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  },

  // 等待元素出现
  waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`元素 ${selector} 未找到`));
      }, timeout);
    });
  },

  // 防抖函数
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // 节流函数
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  // 发送消息到 background
  sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  },

  // 获取存储数据
  async getStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key]);
      });
    });
  },

  // 设置存储数据
  async setStorage(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve();
      });
    });
  },

  /**
   * 兼容旧接口：简单通知，内部转到 Toast 系统
   */
  showNotification(message, type = 'info') {
    if (window.CoreToast && typeof window.CoreToast.show === 'function') {
      window.CoreToast.show({ message, type });
    } else {
      alert(message);
    }
  }
};

// =============================================================
// 全局 Toast 系统（CoreToast）
// =============================================================

;(function initCoreToast() {
  if (window.CoreToast) return;

  const TOAST_CONTAINER_ID = 'core-toast-container';
  const TOAST_BASE_CLASS = 'core-toast';

  const TYPE_CONFIG = {
    info: {
      icon: 'ℹ️',
      className: 'core-toast-info'
    },
    success: {
      icon: '✅',
      className: 'core-toast-success'
    },
    warning: {
      icon: '⚠️',
      className: 'core-toast-warning'
    },
    error: {
      icon: '❌',
      className: 'core-toast-error'
    }
  };

  // 注入样式，只注入一次
  if (!document.getElementById('core-toast-styles')) {
    const style = document.createElement('style');
    style.id = 'core-toast-styles';
    style.textContent = `
      #${TOAST_CONTAINER_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      .${TOAST_BASE_CLASS} {
        min-width: 260px;
        max-width: 360px;
        padding: 12px 14px;
        border-radius: 12px;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        box-shadow: 0 12px 38px rgba(15, 23, 42, 0.20);
        background: rgba(15, 23, 42, 0.92);
        color: #f8fafc;
        font-size: 13px;
        line-height: 1.5;
        backdrop-filter: blur(16px);
        border: 1px solid rgba(148, 163, 184, 0.35);
        transform: translateX(120%);
        opacity: 0;
        pointer-events: auto;
        animation: core-toast-slide-in 0.24s ease-out forwards;
      }

      .core-toast-icon {
        font-size: 16px;
        line-height: 1;
        margin-top: 1px;
      }

      .core-toast-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .core-toast-title {
        font-size: 13px;
        font-weight: 600;
      }

      .core-toast-message {
        font-size: 12px;
        color: #e5e7eb;
        word-break: break-word;
      }

      .core-toast-close {
        border: none;
        background: transparent;
        color: #9ca3af;
        cursor: pointer;
        padding: 0;
        margin-left: 4px;
        font-size: 14px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
      }

      .core-toast-close:hover {
        background: rgba(148, 163, 184, 0.2);
        color: #e5e7eb;
      }

      .core-toast-progress {
        position: relative;
        width: 100%;
        height: 2px;
        border-radius: 999px;
        overflow: hidden;
        margin-top: 8px;
        background: rgba(148, 163, 184, 0.25);
      }

      .core-toast-progress-inner {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 100%;
        transform-origin: left;
        background: linear-gradient(90deg, #4ade80, #22c55e);
        animation-timing-function: linear;
      }

      .core-toast-info {
        border-color: rgba(59, 130, 246, 0.6);
      }

      .core-toast-info .core-toast-progress-inner {
        background: linear-gradient(90deg, #60a5fa, #3b82f6);
      }

      .core-toast-success {
        border-color: rgba(34, 197, 94, 0.6);
      }

      .core-toast-success .core-toast-progress-inner {
        background: linear-gradient(90deg, #4ade80, #22c55e);
      }

      .core-toast-warning {
        border-color: rgba(234, 179, 8, 0.7);
      }

      .core-toast-warning .core-toast-progress-inner {
        background: linear-gradient(90deg, #facc15, #eab308);
      }

      .core-toast-error {
        border-color: rgba(239, 68, 68, 0.8);
      }

      .core-toast-error .core-toast-progress-inner {
        background: linear-gradient(90deg, #f97373, #ef4444);
      }

      @keyframes core-toast-slide-in {
        from {
          transform: translateX(120%) translateY(-8px);
          opacity: 0;
        }
        to {
          transform: translateX(0) translateY(0);
          opacity: 1;
        }
      }

      @keyframes core-toast-slide-out {
        from {
          transform: translateX(0) translateY(0);
          opacity: 1;
        }
        to {
          transform: translateX(120%) translateY(-8px);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getContainer() {
    let container = document.getElementById(TOAST_CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = TOAST_CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  function createToastElement({ type, message, title, duration }) {
    const config = TYPE_CONFIG[type] || TYPE_CONFIG.info;
    const container = getContainer();

    const toast = document.createElement('div');
    toast.className = `${TOAST_BASE_CLASS} ${config.className}`;

    const iconEl = document.createElement('div');
    iconEl.className = 'core-toast-icon';
    iconEl.textContent = config.icon;

    const contentEl = document.createElement('div');
    contentEl.className = 'core-toast-content';

    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'core-toast-title';
      titleEl.textContent = title;
      contentEl.appendChild(titleEl);
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'core-toast-message';
    msgEl.textContent = message;
    contentEl.appendChild(msgEl);

    const rightEl = document.createElement('button');
    rightEl.className = 'core-toast-close';
    rightEl.title = '关闭';
    rightEl.textContent = '✕';

    const progress = document.createElement('div');
    progress.className = 'core-toast-progress';
    const progressInner = document.createElement('div');
    progressInner.className = 'core-toast-progress-inner';
    progress.appendChild(progressInner);
    contentEl.appendChild(progress);

    toast.appendChild(iconEl);
    toast.appendChild(contentEl);
    toast.appendChild(rightEl);
    container.appendChild(toast);

    // 点击关闭
    rightEl.addEventListener('click', () => {
      dismissToast(toast);
    });

    // 进度条动画（使用 CSS transform 缩放）
    const totalDuration = duration;
    progressInner.style.animation = `core-toast-progress ${totalDuration}ms linear forwards`;

    return toast;
  }

  function dismissToast(toast) {
    if (!toast || toast._closing) return;
    toast._closing = true;
    toast.style.animation = 'core-toast-slide-out 0.18s ease-in forwards';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 180);
  }

  // 进度条动画关键帧（依赖 duration 通过 animation-duration 控制）
  if (!document.getElementById('core-toast-progress-styles')) {
    const style = document.createElement('style');
    style.id = 'core-toast-progress-styles';
    style.textContent = `
      @keyframes core-toast-progress {
        from {
          transform: scaleX(1);
        }
        to {
          transform: scaleX(0);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function showToast(options) {
    const {
      message = '',
      type = 'info',
      title,
      duration = 2600
    } = options || {};

    if (!message) return;

    const toast = createToastElement({
      type,
      message,
      title,
      duration
    });

    // 自动关闭
    const timer = setTimeout(() => {
      dismissToast(toast);
    }, duration);

    // 鼠标悬停时暂停关闭（可选交互）
    toast.addEventListener('mouseenter', () => {
      clearTimeout(timer);
    });
  }

  // 暴露全局 Toast API
  window.CoreToast = {
    show: showToast,
    success(message, duration) {
      showToast({ message, type: 'success', duration });
    },
    error(message, duration) {
      showToast({ message, type: 'error', duration });
    },
    warning(message, duration) {
      showToast({ message, type: 'warning', duration });
    },
    info(message, duration) {
      showToast({ message, type: 'info', duration });
    }
  };

  // 支持 background 通过 runtime 消息触发：
  // chrome.tabs.sendMessage(tabId, {
  //   type: 'core:toast',
  //   level: 'success' | 'error' | 'warning' | 'info',
  //   message: '内容',
  //   duration: 3000
  // })
  if (!window.__coreToastMessageListenerAttached && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.type === 'core:toast') {
        const level = request.level || request.typeLevel || 'info';
        const msg = request.message || request.text || '';
        const duration = request.duration || undefined;
        if (msg) {
          showToast({ message: msg, type: level, duration });
        }
        sendResponse && sendResponse({ ok: true });
        return true;
      }
      return false;
    });
    window.__coreToastMessageListenerAttached = true;
  }
})();
