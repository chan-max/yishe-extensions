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

  // 加载基础功能模块
  function loadSiteModule() {
      loadModule('common');
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
          if (module.init && typeof module.init === 'function') {
                try {
              const siteInfo = window.CoreSiteDetector?.getCurrentSiteInfo?.() || {};
                  module.init(siteInfo);
                  console.log(`[Core] 已初始化 ${moduleName} 模块`);
                } catch (error) {
                  console.error(`[Core] 初始化 ${moduleName} 模块失败:`, error);
                }
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
