// common.js: 通用功能模块（适用于所有网站）

// 创建全局网站模块对象（如果不存在）
if (!window.CoreSiteModules) {
  window.CoreSiteModules = {};
}

window.CoreSiteModules.common = {
  // 初始化通用功能
  init(siteInfo) {
    console.log('[Core Common] 通用功能模块已加载', siteInfo);
  },

  // 获取菜单项
  async getMenuItems(siteInfo) {
    return [
      {
        icon: '🔍',
        label: '页面信息',
        action: () => {
          this.showPageInfo();
        }
      },
      {
        icon: '📊',
        label: '性能监控',
        action: () => {
          this.showPerformanceInfo();
        }
      },
      {
        icon: '📋',
        label: '复制页面标题',
        action: () => {
          this.copyToClipboard(document.title);
          window.CoreDOMUtils.showNotification('页面标题已复制', 'success');
        }
      },
      {
        icon: '🔗',
        label: '复制页面链接',
        action: () => {
          this.copyToClipboard(window.location.href);
          window.CoreDOMUtils.showNotification('页面链接已复制', 'success');
        }
      }
    ];
  },

  // 显示页面信息
  showPageInfo() {
    const info = {
      title: document.title,
      url: window.location.href,
      hostname: window.location.hostname,
      protocol: window.location.protocol,
      language: document.documentElement.lang || '未知'
    };

    const message = `页面标题: ${info.title}\n页面链接: ${info.url}\n域名: ${info.hostname}\n协议: ${info.protocol}\n语言: ${info.language}`;
    alert(message);
  },

  // 显示性能信息
  showPerformanceInfo() {
    if (!window.performance || !window.performance.timing) {
      alert('浏览器不支持性能监控');
      return;
    }

    const timing = window.performance.timing;
    const loadTime = timing.loadEventEnd - timing.navigationStart;
    const domReadyTime = timing.domContentLoadedEventEnd - timing.navigationStart;

    const message = `页面加载时间: ${loadTime}ms\nDOM 就绪时间: ${domReadyTime}ms`;
    alert(message);
  },

  // 复制到剪贴板
  copyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
};
