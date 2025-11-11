// popup.js: 弹窗逻辑

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 显示当前网站信息
    if (tab && tab.url) {
      try {
        const url = new URL(tab.url);
        const siteInfo = document.getElementById('currentSite');
        siteInfo.innerHTML = `
          <div class="site-info">
            <span class="site-domain">${url.hostname}</span>
            <span class="site-path">${url.pathname}</span>
          </div>
        `;
      } catch (error) {
        document.getElementById('currentSite').textContent = '无法解析 URL';
      }
    }

    // 加载数据统计
    loadDataStats();

    // 刷新按钮
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        if (tab && tab.id) {
          chrome.tabs.reload(tab.id);
          window.close();
        }
      });
    }

    // 设置按钮
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        // 如果没有设置页面，可以打开扩展管理页面
        chrome.runtime.openOptionsPage().catch(() => {
          chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
        });
      });
    }
  } catch (error) {
    console.error('[Core Popup] 初始化失败:', error);
  }
});

// 加载数据统计
function loadDataStats() {
  chrome.storage.local.get(['crawledData'], (result) => {
    const data = result.crawledData || [];
    const dataCountEl = document.getElementById('dataCount');
    if (dataCountEl) {
      dataCountEl.textContent = data.length;
    }
  });
}
