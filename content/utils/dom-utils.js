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
      icon: '●',
      className: 'core-toast-info'
    },
    success: {
      icon: '✓',
      className: 'core-toast-success'
    },
    warning: {
      icon: '▲',
      className: 'core-toast-warning'
    },
    error: {
      icon: '✕',
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
        min-width: 280px;
        max-width: 400px;
        padding: 14px 16px;
        border-radius: 14px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.4),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset;
        background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%);
        color: #f8fafc;
        font-size: 14px;
        line-height: 1.5;
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(148, 163, 184, 0.25);
        transform: translateX(120%);
        opacity: 0;
        pointer-events: auto;
        animation: core-toast-slide-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        transition: transform 0.2s ease, opacity 0.2s ease;
      }

      .core-toast-icon {
        font-size: 16px;
        line-height: 1;
        margin-top: 2px;
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
      }

      .core-toast-success .core-toast-icon {
        color: #22c55e;
      }

      .core-toast-error .core-toast-icon {
        color: #ef4444;
      }

      .core-toast-warning .core-toast-icon {
        color: #eab308;
      }

      .core-toast-info .core-toast-icon {
        color: #3b82f6;
      }

      .core-toast-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .core-toast-title {
        font-size: 14px;
        font-weight: 600;
        color: #f1f5f9;
        letter-spacing: 0.01em;
      }

      .core-toast-message {
        font-size: 13px;
        color: #cbd5e1;
        word-break: break-word;
        line-height: 1.6;
        letter-spacing: 0.01em;
      }

      .core-toast-close {
        border: none;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        padding: 4px;
        margin-left: 4px;
        font-size: 16px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        transition: all 0.2s ease;
      }

      .core-toast-close:hover {
        background: rgba(148, 163, 184, 0.15);
        color: #f1f5f9;
        transform: scale(1.1);
      }

      .core-toast-close:active {
        transform: scale(0.95);
      }

      .core-toast-progress {
        position: relative;
        width: 100%;
        height: 3px;
        border-radius: 999px;
        overflow: hidden;
        margin-top: 10px;
        background: rgba(148, 163, 184, 0.2);
        backdrop-filter: blur(4px);
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
        box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
      }

      .core-toast-info {
        border-color: rgba(59, 130, 246, 0.4);
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.4),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset,
                    0 0 20px rgba(59, 130, 246, 0.1);
      }

      .core-toast-info .core-toast-progress-inner {
        background: linear-gradient(90deg, #60a5fa, #3b82f6);
        box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
      }

      .core-toast-success {
        border-color: rgba(34, 197, 94, 0.4);
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.4),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset,
                    0 0 20px rgba(34, 197, 94, 0.1);
      }

      .core-toast-success .core-toast-progress-inner {
        background: linear-gradient(90deg, #4ade80, #22c55e);
        box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
      }

      .core-toast-warning {
        border-color: rgba(234, 179, 8, 0.5);
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.4),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset,
                    0 0 20px rgba(234, 179, 8, 0.1);
      }

      .core-toast-warning .core-toast-progress-inner {
        background: linear-gradient(90deg, #facc15, #eab308);
        box-shadow: 0 0 8px rgba(234, 179, 8, 0.5);
      }

      .core-toast-error {
        border-color: rgba(239, 68, 68, 0.5);
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.4),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset,
                    0 0 20px rgba(239, 68, 68, 0.1);
      }

      .core-toast-error .core-toast-progress-inner {
        background: linear-gradient(90deg, #f97373, #ef4444);
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
      }

      @keyframes core-toast-slide-in {
        from {
          transform: translateX(120%) translateY(-10px);
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
          transform: translateX(120%) translateY(-5px);
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
    
    // 保存 toast 引用，方便后续操作
    toast._closeButton = rightEl;

    // 进度条动画（使用 CSS transform 缩放）
    const totalDuration = duration;
    progressInner.style.animation = `core-toast-progress ${totalDuration}ms linear forwards`;

    return toast;
  }

  function dismissToast(toast) {
    if (!toast || toast._closing) return;
    toast._closing = true;
    
    // 从 activeToasts 中移除（如果存在）
    if (toast._toastKey && activeToasts.has(toast._toastKey)) {
      activeToasts.delete(toast._toastKey);
    }
    
    toast.style.animation = 'core-toast-slide-out 0.25s cubic-bezier(0.4, 0, 1, 1) forwards';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 250);
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

  // 用于跟踪正在显示的 toast，防止重复显示相同消息
  const activeToasts = new Map();

  function showToast(options) {
    const {
      message = '',
      type = 'info',
      title,
      duration = 2600
    } = options || {};

    if (!message) return;

    // 创建唯一标识符，用于检测重复消息
    const toastKey = `${type}:${message}`;
    
    // 如果相同的消息正在显示，则不重复创建
    if (activeToasts.has(toastKey)) {
      return;
    }

    const toast = createToastElement({
      type,
      message,
      title,
      duration
    });

    // 在 toast 元素上保存 key，方便后续移除
    toast._toastKey = toastKey;

    // 记录正在显示的 toast
    activeToasts.set(toastKey, toast);

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

// =============================================================
// 全局 Loading 系统（CoreLoading）
// =============================================================

;(function initCoreLoading() {
  if (window.CoreLoading) return;

  const LOADING_CONTAINER_ID = 'core-loading-container';
  const LOADING_BASE_CLASS = 'core-loading';

  // 注入样式，只注入一次
  if (!document.getElementById('core-loading-styles')) {
    const style = document.createElement('style');
    style.id = 'core-loading-styles';
    style.textContent = `
      #${LOADING_CONTAINER_ID} {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483646;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(8px) saturate(180%);
        -webkit-backdrop-filter: blur(8px) saturate(180%);
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        animation: core-loading-backdrop-fade-in 0.25s ease-out;
      }

      #${LOADING_CONTAINER_ID}.core-loading-active {
        display: flex;
      }

      .${LOADING_BASE_CLASS} {
        background: linear-gradient(135deg, rgba(30, 41, 59, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%);
        border-radius: 20px;
        padding: 32px 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5),
                    0 0 0 1px rgba(255, 255, 255, 0.05) inset;
        border: 1px solid rgba(148, 163, 184, 0.2);
        min-width: 220px;
        max-width: 360px;
        animation: core-loading-fade-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }

      .core-loading-spinner {
        width: 48px;
        height: 48px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .core-loading-spinner::before {
        content: '';
        position: absolute;
        width: 48px;
        height: 48px;
        border: 4px solid rgba(59, 130, 246, 0.15);
        border-radius: 50%;
      }

      .core-loading-spinner::after {
        content: '';
        position: absolute;
        width: 48px;
        height: 48px;
        border: 4px solid transparent;
        border-top-color: #3b82f6;
        border-right-color: #3b82f6;
        border-radius: 50%;
        animation: core-loading-spin 0.9s cubic-bezier(0.5, 0, 0.5, 1) infinite;
      }

      .core-loading-message {
        color: #f1f5f9;
        font-size: 15px;
        font-weight: 500;
        text-align: center;
        line-height: 1.6;
        margin: 0;
        letter-spacing: 0.01em;
      }

      @keyframes core-loading-backdrop-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      @keyframes core-loading-fade-in {
        from {
          opacity: 0;
          transform: scale(0.9) translateY(-10px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }

      @keyframes core-loading-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @keyframes core-loading-fade-out {
        from {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
        to {
          opacity: 0;
          transform: scale(0.95) translateY(-5px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getContainer() {
    let container = document.getElementById(LOADING_CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = LOADING_CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  function createLoadingElement(message) {
    const container = getContainer();
    
    // 如果已存在，先移除
    const existing = container.querySelector(`.${LOADING_BASE_CLASS}`);
    if (existing) {
      existing.remove();
    }

    const loading = document.createElement('div');
    loading.className = LOADING_BASE_CLASS;

    const spinner = document.createElement('div');
    spinner.className = 'core-loading-spinner';
    // spinner 使用 ::before 和 ::after 伪元素，不需要添加子元素

    const messageEl = document.createElement('div');
    messageEl.className = 'core-loading-message';
    messageEl.textContent = message || '处理中...';

    loading.appendChild(spinner);
    loading.appendChild(messageEl);
    container.appendChild(loading);

    return loading;
  }

  function showLoading(message = '处理中...') {
    const container = getContainer();
    createLoadingElement(message);
    container.classList.add('core-loading-active');
  }

  function hideLoading() {
    const container = getContainer();
    if (!container) return;
    
    container.classList.remove('core-loading-active');
    
    // 添加淡出动画
    const loading = container.querySelector(`.${LOADING_BASE_CLASS}`);
    if (loading) {
      loading.style.animation = 'core-loading-fade-out 0.25s cubic-bezier(0.4, 0, 1, 1) forwards';
      setTimeout(() => {
        if (loading.parentNode) {
          loading.parentNode.removeChild(loading);
        }
      }, 250);
    }
  }

  // 暴露全局 Loading API
  window.CoreLoading = {
    show: showLoading,
    hide: hideLoading,
    isVisible() {
      const container = getContainer();
      return container && container.classList.contains('core-loading-active');
    }
  };

  // 支持 background 通过 runtime 消息触发：
  // chrome.tabs.sendMessage(tabId, {
  //   type: 'core:loading',
  //   action: 'show' | 'hide',
  //   message: '加载中...'
  // })
  if (!window.__coreLoadingMessageListenerAttached && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.type === 'core:loading') {
        const action = request.action || 'show';
        const message = request.message || '处理中...';
        
        if (action === 'show') {
          showLoading(message);
        } else if (action === 'hide') {
          hideLoading();
        }
        
        sendResponse && sendResponse({ ok: true });
        return true;
      }
      return false;
    });
    window.__coreLoadingMessageListenerAttached = true;
  }
})();