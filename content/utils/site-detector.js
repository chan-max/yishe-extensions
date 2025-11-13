// site-detector.js: 网站检测工具，根据当前 URL 匹配对应的网站配置

// 创建全局网站检测对象
window.CoreSiteDetector = {
  async loadSitesConfig() {
      return { sites: [] };
  },

  async detectSite() {
    return null;
  },

  // 获取当前网站信息
  getCurrentSiteInfo() {
    return {
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      url: window.location.href,
      protocol: window.location.protocol
    };
  }
};
