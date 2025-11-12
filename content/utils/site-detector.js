// site-detector.js: 网站检测工具，根据当前 URL 匹配对应的网站配置

// 创建全局网站检测对象
window.CoreSiteDetector = {
  sitesConfig: null,

  // 加载网站配置
  async loadSitesConfig() {
    if (this.sitesConfig) {
      return this.sitesConfig;
    }

    try {
      const response = await fetch(chrome.runtime.getURL('config/sites.json'));
      this.sitesConfig = await response.json();
      return this.sitesConfig;
    } catch (error) {
      console.error('[Core] 加载网站配置失败:', error);
      return { sites: [] };
    }
  },

  // 检测当前网站
  async detectSite() {
    const config = await this.loadSitesConfig();
    const hostname = window.location.hostname;
    const url = window.location.href;

    // 遍历配置，查找匹配的网站（先查找特定网站，最后查找通用功能）
    const specificSites = config.sites.filter(site => 
      site.enabled && !site.domains.includes('<all_urls>')
    );
    
    const defaultSite = config.sites.find(site => 
      site.domains.includes('<all_urls>') && site.enabled
    );

    // 先查找特定网站
    for (const site of specificSites) {
      for (const domain of site.domains) {
        if (hostname === domain || hostname.endsWith('.' + domain)) {
          return {
            id: site.id,
            name: site.name,
            module: site.module,
            domain: hostname,
            url: url
          };
        }
      }
    }

    // 如果没有匹配到特定网站，返回通用功能
    if (defaultSite) {
      return {
        id: defaultSite.id,
        name: defaultSite.name,
        module: defaultSite.module,
        domain: hostname,
        url: url
      };
    }

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
