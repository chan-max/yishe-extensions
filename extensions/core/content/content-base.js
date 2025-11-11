// content-base.js: 基础 content script，负责初始化悬浮机器人和加载对应网站的功能模块

(function() {
  'use strict';

  // 防止重复加载
  if (window.coreExtensionLoaded) {
    return;
  }
  window.coreExtensionLoaded = true;

  // 初始化悬浮机器人
  function initFloatingRobot() {
    if (window.CoreFloatingRobot && window.CoreFloatingRobot.init) {
      try {
        window.CoreFloatingRobot.init();
      } catch (error) {
        console.error('[Core] 初始化悬浮机器人失败:', error);
      }
    } else {
      console.error('[Core] 悬浮机器人组件未加载');
    }
  }

  // 加载对应网站的功能模块
  async function loadSiteModule() {
    try {
      if (!window.CoreSiteDetector) {
        console.error('[Core] 网站检测工具未加载');
        // 即使检测工具未加载，也尝试加载通用模块
        loadModule('common');
        return;
      }

      const siteInfo = await window.CoreSiteDetector.detectSite();

      if (!siteInfo) {
        console.log('[Core] 未匹配到网站配置，使用通用功能');
        loadModule('common');
        return;
      }

      console.log(`[Core] 检测到网站: ${siteInfo.name} (${siteInfo.id})`);

      // 加载通用模块（所有网站都加载）
      loadModule('common');

      // 加载特定网站模块
      if (siteInfo.module && siteInfo.module !== 'common') {
        loadModule(siteInfo.module, true); // true 表示是网站特定模块，放在文件夹中
      }
    } catch (error) {
      console.error('[Core] 加载网站模块失败:', error);
      // 出错时也加载通用模块
      loadModule('common');
    }
  }

  // 加载模块（避免重复加载）
  function loadModule(moduleName, isSiteModule = false) {
    // 如果模块已经加载，跳过
    if (window.CoreSiteModules && window.CoreSiteModules[moduleName]) {
      console.log(`[Core] 模块 ${moduleName} 已加载`);
      return;
    }

    // 检查是否正在加载
    const loadingKey = `core_module_loading_${moduleName}`;
    if (window[loadingKey]) {
      console.log(`[Core] 模块 ${moduleName} 正在加载中...`);
      return;
    }
    window[loadingKey] = true;

    // 根据模块类型确定路径
    // 通用模块：content/sites/common.js
    // 网站模块：content/sites/{moduleName}/index.js
    const modulePath = isSiteModule 
      ? `content/sites/${moduleName}/index.js`
      : `content/sites/${moduleName}.js`;

    // 动态注入模块脚本
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(modulePath);
    
    script.onload = () => {
      // 等待模块注册
      setTimeout(() => {
        if (window.CoreSiteModules && window.CoreSiteModules[moduleName]) {
          const module = window.CoreSiteModules[moduleName];
          // 获取当前网站信息并初始化
          if (module.init && typeof module.init === 'function') {
            window.CoreSiteDetector.detectSite().then(siteInfo => {
              if (siteInfo) {
                try {
                  module.init(siteInfo);
                  console.log(`[Core] 已初始化 ${moduleName} 模块`);
                } catch (error) {
                  console.error(`[Core] 初始化 ${moduleName} 模块失败:`, error);
                }
              }
            }).catch(() => {
              // 即使检测失败，也尝试初始化
              try {
                module.init({});
              } catch (error) {
                console.error(`[Core] 初始化 ${moduleName} 模块失败:`, error);
              }
            });
          }
        }
        window[loadingKey] = false;
      }, 100);
    };

    script.onerror = () => {
      console.error(`[Core] 加载模块 ${moduleName} 失败，路径: ${modulePath}`);
      window[loadingKey] = false;
    };

    document.head.appendChild(script);
  }

  // 初始化
  function init() {
    // 等待 DOM 加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
          initFloatingRobot();
          loadSiteModule();
        }, 200);
      });
    } else {
      setTimeout(() => {
        initFloatingRobot();
        loadSiteModule();
      }, 200);
    }
  }

  // 启动
  init();
})();
