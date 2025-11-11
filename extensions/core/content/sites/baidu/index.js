// baidu/index.js: Baidu 网站功能模块

// 创建全局网站模块对象（如果不存在）
if (!window.CoreSiteModules) {
  window.CoreSiteModules = {};
}

window.CoreSiteModules.baidu = {
  // 初始化：可在这里放置站点就绪逻辑
  init(siteInfo) {
    console.log('[Core Baidu] 模块已加载', siteInfo);
  },

  // 菜单项
  async getMenuItems(siteInfo) {
    return [
      {
        icon: '🎯',
        label: '聚焦搜索框',
        action: () => {
          const input = document.querySelector('#kw');
          if (input) {
            input.focus();
            window.CoreDOMUtils.showNotification('已聚焦搜索框', 'success');
          } else {
            window.CoreDOMUtils.showNotification('未找到搜索框', 'warning');
          }
        }
      },
      {
        icon: '🔎',
        label: '输入并搜索',
        action: () => {
          const keyword = prompt('请输入搜索关键词:');
          if (!keyword) return;
          const input = document.querySelector('#kw');
          if (input) {
            input.value = keyword;
            const btn = document.querySelector('#su');
            if (btn) {
              btn.click();
            } else {
              // 回车触发
              const event = new KeyboardEvent('keydown', { key: 'Enter' });
              input.dispatchEvent(event);
            }
            window.CoreDOMUtils.showNotification(`搜索: ${keyword}`, 'info');
          } else {
            window.CoreDOMUtils.showNotification('未找到搜索框', 'warning');
          }
        }
      },
      {
        icon: '✨',
        label: '高亮搜索结果',
        action: () => {
          // 常见结果容器选择器：#content_left 下的条目
          let count = 0;
          document.querySelectorAll('#content_left > div, #content_left .c-container').forEach(el => {
            el.style.outline = '2px solid #ff9800';
            el.style.outlineOffset = '2px';
            count += 1;
          });
          window.CoreDOMUtils.showNotification(`已高亮 ${count} 条结果`, 'success');
        }
      },
      {
        icon: '📋',
        label: '复制首条结果链接',
        action: () => {
          const firstLink = document.querySelector('#content_left a[href]');
          if (firstLink && firstLink.href) {
            this.copyToClipboard(firstLink.href);
            window.CoreDOMUtils.showNotification('已复制首条链接', 'success');
          } else {
            window.CoreDOMUtils.showNotification('未找到结果链接', 'warning');
          }
        }
      }
    ];
  },

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


