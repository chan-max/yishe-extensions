// 登录页面逻辑
(async function() {
  // 动态加载 API 工具
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('utils/api.js');
  document.head.appendChild(script);
  
  // 等待脚本加载
  await new Promise((resolve, reject) => {
    script.onload = () => {
      // 等待一小段时间确保 ApiUtils 已挂载到 window
      setTimeout(() => {
        if (window.ApiUtils) {
          resolve();
        } else {
          reject(new Error('ApiUtils 未加载'));
        }
      }, 50);
    };
    script.onerror = () => reject(new Error('加载 api.js 失败'));
    setTimeout(() => reject(new Error('加载 api.js 超时')), 2000);
  });
  
  const ApiUtils = window.ApiUtils;
  
  const loginForm = document.getElementById('login-form');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const rememberMeInput = document.getElementById('rememberMe');
  const loginBtn = document.getElementById('login-btn');
  const loginBtnText = document.getElementById('login-btn-text');
  const loginBtnLoading = document.getElementById('login-btn-loading');
  const loginError = document.getElementById('login-error');
  const devModeToggle = document.getElementById('dev-mode-toggle');
  const devModeInfo = document.getElementById('dev-mode-info');
  
  // 加载开发模式状态
  async function loadDevMode() {
    const isDev = await ApiUtils.isDevMode();
    devModeToggle.checked = isDev;
    await updateDevModeInfo();
  }
  
  // 更新开发模式信息显示
  async function updateDevModeInfo() {
    const isDev = devModeToggle.checked;
    devModeInfo.style.display = isDev ? 'block' : 'none';
  }
  
  // 开发模式切换
  devModeToggle.addEventListener('change', async () => {
    await ApiUtils.setDevMode(devModeToggle.checked);
    await updateDevModeInfo();
  });
  
  // 显示错误
  function showError(message) {
    loginError.textContent = message;
    loginError.style.display = 'block';
    setTimeout(() => {
      loginError.style.display = 'none';
    }, 5000);
  }
  
  // 设置加载状态
  function setLoading(loading) {
    loginBtn.disabled = loading;
    if (loading) {
      loginBtnText.style.display = 'none';
      loginBtnLoading.style.display = 'inline';
    } else {
      loginBtnText.style.display = 'inline';
      loginBtnLoading.style.display = 'none';
    }
  }
  
  // 表单提交
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const rememberMe = rememberMeInput.checked;
    
    if (!username || !password) {
      showError('请输入用户名和密码');
      return;
    }
    
    setLoading(true);
    loginError.style.display = 'none';
    
    try {
      await ApiUtils.login(username, password, rememberMe);
      
      // 登录成功，跳转到控制页面
      const controlUrl = chrome.runtime.getURL('pages/control.html');
      window.location.href = controlUrl;
    } catch (error) {
      console.error('登录失败:', error);
      showError(error.message || '登录失败，请检查用户名和密码');
    } finally {
      setLoading(false);
    }
  });
  
  // 检查是否已登录
  async function checkLoginStatus() {
    const token = await ApiUtils.getToken();
    if (token) {
      // 已登录，跳转到控制页面
      const controlUrl = chrome.runtime.getURL('pages/control.html');
      window.location.href = controlUrl;
    }
  }
  
  // 初始化
  await loadDevMode();
  await checkLoginStatus();
})();

