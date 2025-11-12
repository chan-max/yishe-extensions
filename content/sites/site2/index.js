// site2/index.js: 网站2的功能模块

// 创建全局网站模块对象（如果不存在）
if (!window.CoreSiteModules) {
  window.CoreSiteModules = {};
}

window.CoreSiteModules.site2 = {
  // 初始化网站2的功能
  init(siteInfo) {
    console.log('[Core Site2] 网站2功能模块已加载', siteInfo);
    // 在这里添加网站2特定的功能
  },

  // 获取菜单项
  async getMenuItems(siteInfo) {
    return [
      {
        icon: '🎯',
        label: '功能A',
        action: () => {
          this.featureA();
        }
      },
      {
        icon: '⚡',
        label: '功能B',
        action: () => {
          this.featureB();
        }
      },
      {
        icon: '🔧',
        label: '功能C',
        action: () => {
          this.featureC();
        }
      }
    ];
  },

  // 功能A
  featureA() {
    console.log('[Core Site2] 执行功能A');
    window.CoreDOMUtils.showNotification('功能A 已执行', 'success');
  },

  // 功能B
  featureB() {
    console.log('[Core Site2] 执行功能B');
    window.CoreDOMUtils.showNotification('功能B 已执行', 'success');
  },

  // 功能C
  featureC() {
    console.log('[Core Site2] 执行功能C');
    window.CoreDOMUtils.showNotification('功能C 已执行', 'success');
  }
};

