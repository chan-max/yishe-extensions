// popup.js: 处理弹窗界面的逻辑

// 等待页面加载完成
document.addEventListener('DOMContentLoaded', function() {
  // 获取页面元素
  const searchInput = document.getElementById('searchText');
  const highlightBtn = document.getElementById('highlightBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusDiv = document.getElementById('status');
  
  // 显示状态信息
  function showStatus(message, isSuccess = true) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + (isSuccess ? 'success' : 'error');
    
    // 3秒后自动清除状态
    setTimeout(() => {
      statusDiv.textContent = '';
      statusDiv.className = 'status';
    }, 3000);
  }
  
  // 检查并注入 content script（如果需要）
  async function ensureContentScript(tabId) {
    try {
      // 先尝试发送一个测试消息，检查 content script 是否存在
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        return true; // content script 已存在
      } catch (error) {
        // content script 不存在，需要注入
        // 检查是否是特殊页面（chrome://, chrome-extension:// 等）
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && (tab.url.startsWith('chrome://') || 
                        tab.url.startsWith('chrome-extension://') ||
                        tab.url.startsWith('edge://') ||
                        tab.url.startsWith('about:'))) {
          showStatus('此页面不支持插件功能', false);
          return false;
        }
        
        // 注入 content script
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content.js']
        });
        
        // 注入样式
        await chrome.scripting.insertCSS({
          target: { tabId: tabId },
          files: ['styles.css']
        });
        
        // 等待一小段时间让脚本加载
        await new Promise(resolve => setTimeout(resolve, 100));
        return true;
      }
    } catch (error) {
      console.error('注入 content script 失败:', error);
      showStatus('无法在此页面使用插件', false);
      return false;
    }
  }
  
  // 发送消息到 content script（带重试）
  async function sendMessageToContent(action, data = {}) {
    try {
      // 获取当前激活的标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.id) {
        showStatus('无法获取当前标签页', false);
        return null;
      }
      
      // 确保 content script 已注入
      const scriptReady = await ensureContentScript(tab.id);
      if (!scriptReady) {
        return null;
      }
      
      // 发送消息
      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action, ...data }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch (error) {
      throw error;
    }
  }
  
  // 高亮按钮点击事件
  highlightBtn.addEventListener('click', async () => {
    const searchText = searchInput.value.trim();
    
    if (!searchText) {
      showStatus('请输入要搜索的文本', false);
      return;
    }
    
    try {
      const response = await sendMessageToContent('highlight', { text: searchText });
      if (response && response.success) {
        showStatus(`已高亮 ${response.count} 处文本`);
      } else {
        showStatus('高亮失败', false);
      }
    } catch (error) {
      showStatus('执行失败: ' + error.message, false);
    }
  });
  
  // 清除按钮点击事件
  clearBtn.addEventListener('click', async () => {
    try {
      const response = await sendMessageToContent('clear');
      if (response && response.success) {
        showStatus('已清除所有高亮');
      } else {
        showStatus('清除失败', false);
      }
    } catch (error) {
      showStatus('执行失败: ' + error.message, false);
    }
  });
  
  // 支持按 Enter 键触发高亮
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      highlightBtn.click();
    }
  });
});
