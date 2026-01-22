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

  // 上传弹窗相关变量
  let uploadDialog = null;
  let isTextSelectionMode = false;
  let uploadResolve = null;
  let uploadReject = null;
  let currentImageInfo = null;

  // 创建上传弹窗
  function createUploadDialog(imageInfo) {
    console.log('[YiShe] 创建上传弹窗:', imageInfo);
    currentImageInfo = imageInfo;

    if (uploadDialog) {
      console.log('[YiShe] 移除旧弹窗');
      uploadDialog.remove();
    }

    uploadDialog = document.createElement('div');
    uploadDialog.innerHTML = `
      <div id="upload-dialog-content" style="
        position: fixed;
        top: 20px;
        left: 20px;
        background: white;
        border: 1px solid #e1e5e9;
        border-radius: 8px;
        padding: 0;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        min-width: 380px;
        max-width: 480px;
        max-height: 70vh;
        overflow: hidden;
        user-select: none;
      ">
        <div id="dialog-header" style="
          padding: 16px 20px;
          border-bottom: 1px solid #e1e5e9;
          cursor: move;
          display: flex;
          align-items: center;
          justify-content: space-between;
        ">
          <h3 style="margin: 0; font-size: 15px; font-weight: 500; color: #333;">上传图片到 YiShe 素材库</h3>
          <button id="close-dialog" style="
            background: none;
            border: none;
            color: #999;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 4px;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: background 0.2s;
          " onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='none'">×</button>
        </div>

        <div style="padding: 20px;">
          <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; border: 1px solid #e1e5e9; margin-bottom: 16px;">
            <div style="font-size: 12px; color: #666; margin-bottom: 6px; font-weight: 500;">图片信息</div>
            <div style="font-size: 12px; color: #333; word-break: break-all; line-height: 1.4;">
              ${imageInfo.imageUrl.length > 80 ? imageInfo.imageUrl.substring(0, 80) + '...' : imageInfo.imageUrl}
            </div>
          </div>

          <div style="margin-bottom: 20px;">
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-weight: 500; color: #333; margin-bottom: 6px; font-size: 13px;">
                AI分析增强（可选）
              </label>
              <div style="color: #666; font-size: 12px; line-height: 1.4;">
                请在页面上选择相关文字，AI将使用这些信息生成更准确的内容描述
              </div>
              <div style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
                <span id="text-status" style="color: #666; font-size: 12px; flex: 1;">请在页面上拖拽选择文字...</span>
                <button id="finish-selection-btn" style="
                  background: #52c41a;
                  border: none;
                  border-radius: 4px;
                  padding: 4px 8px;
                  color: white;
                  cursor: pointer;
                  font-size: 11px;
                  font-weight: 500;
                  transition: background 0.2s;
                  display: none;
                " onmouseover="this.style.background='#389e0d'" onmouseout="this.style.background='#52c41a'">完成选择</button>
              </div>
            </div>

            <div style="width: 100%;">
              <textarea id="selected-text-input" style="
                width: 100%;
                min-height: 80px;
                padding: 8px 10px;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                font-size: 12px;
                font-family: inherit;
                resize: vertical;
                background: #ffffff;
                transition: border-color 0.2s;
                line-height: 1.5;
                color: #333;
              " placeholder="未选择文字内容，可在此手动输入或编辑" onfocus="this.style.borderColor='#6900ff'" onblur="this.style.borderColor='#d1d5db'"></textarea>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 10px;">
            <button id="cancel-upload" style="
              background: #ffffff;
              border: 1px solid #d1d5db;
              border-radius: 4px;
              padding: 8px 16px;
              cursor: pointer;
              font-size: 12px;
              color: #6b7280;
              transition: background 0.2s;
            " onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background='#ffffff'">取消</button>
            <button id="confirm-upload" style="
              background: #6900ff;
              border: none;
              border-radius: 4px;
              padding: 8px 16px;
              color: white;
              cursor: pointer;
              font-size: 12px;
              font-weight: 500;
              transition: background 0.2s;
            " onmouseover="this.style.background='#5a00d9'" onmouseout="this.style.background='#6900ff'">上传到素材库</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(uploadDialog);

    let selectedText = '';

    // 绑定事件
    const cancelBtn = uploadDialog.querySelector('#cancel-upload');
    const confirmBtn = uploadDialog.querySelector('#confirm-upload');
    const textStatus = uploadDialog.querySelector('#text-status');
    const selectedTextInput = uploadDialog.querySelector('#selected-text-input');
    const closeBtn = uploadDialog.querySelector('#close-dialog');
    const finishSelectionBtn = uploadDialog.querySelector('#finish-selection-btn');
    const dialogHeader = uploadDialog.querySelector('#dialog-header');
    const dialogContent = uploadDialog.querySelector('#upload-dialog-content');

    cancelBtn.addEventListener('click', () => {
      hideUploadDialog();
      if (uploadReject) {
        uploadReject(new Error('用户取消'));
      }
    });

    closeBtn.addEventListener('click', () => {
      hideUploadDialog();
      if (uploadReject) {
        uploadReject(new Error('用户取消'));
      }
    });

    confirmBtn.addEventListener('click', () => {
      console.log('[YiShe] 用户点击上传按钮，文字:', selectedText);
      hideUploadDialog();
      if (uploadResolve) {
        uploadResolve({ action: 'upload', selectedText });
      }
    });

    // 监听textarea输入变化
    selectedTextInput.addEventListener('input', () => {
      selectedText = selectedTextInput.value.trim();
      updateTextStatus(textStatus, selectedText);
    });

    // 完成选择按钮事件
    finishSelectionBtn.addEventListener('click', () => {
      cleanupTextSelection();
      finishSelectionBtn.style.display = 'none';
      updateTextStatus(textStatus, selectedText);
    });

    // 自动开始文字选择模式
    startTextSelection(textStatus, selectedTextInput, finishSelectionBtn, (text) => {
      selectedText = text;
    });

    // ESC键关闭
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        hideUploadDialog();
        if (uploadReject) {
          uploadReject(new Error('用户取消'));
        }
      }
    };
    document.addEventListener('keydown', handleEscape);

    // 拖拽功能
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dialogStartX = 0;
    let dialogStartY = 0;

    dialogHeader.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = dialogContent.getBoundingClientRect();
      dialogStartX = rect.left;
      dialogStartY = rect.top;
      dialogContent.style.cursor = 'move';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;

      const newLeft = Math.max(0, Math.min(window.innerWidth - dialogContent.offsetWidth, dialogStartX + deltaX));
      const newTop = Math.max(0, Math.min(window.innerHeight - dialogContent.offsetHeight, dialogStartY + deltaY));

      dialogContent.style.left = newLeft + 'px';
      dialogContent.style.top = newTop + 'px';
      dialogContent.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        dialogContent.style.cursor = 'default';
      }
    });
  }

  // 隐藏上传弹窗
  function hideUploadDialog() {
    if (uploadDialog) {
      uploadDialog.remove();
      uploadDialog = null;
    }
    // 清理文字选择状态
    if (isTextSelectionMode) {
      cleanupTextSelection();
    }
    // 移除键盘事件监听器（如果存在）
    if (typeof handleEscape === 'function') {
      document.removeEventListener('keydown', handleEscape);
    }
  }

  // 开始文字选择
  function startTextSelection(statusElement, textInputElement, finishButton, onTextSelected) {
    if (isTextSelectionMode) {
      cleanupTextSelection();
      return;
    }

    isTextSelectionMode = true;
    statusElement.textContent = '请在页面上拖拽选择文字...';
    statusElement.style.color = '#1890ff';

    // 创建选择提示
    const hint = document.createElement('div');
    hint.id = 'yishe-text-selection-hint';
    hint.innerHTML = `
      <div style="
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #6900ff;
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 10001;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        pointer-events: none;
      ">
        请在页面上拖拽选择文字，弹窗会自动获取所选内容
      </div>
    `;
    document.body.appendChild(hint);

    let currentSelectedText = '';

    // 监听鼠标选择事件
    const handleMouseUp = () => {
      const selection = window.getSelection();
      currentSelectedText = selection.toString().trim();
      if (currentSelectedText) {
        statusElement.textContent = `已选择 ${currentSelectedText.length} 个字符`;
        statusElement.style.color = '#52c41a';
        textInputElement.value = currentSelectedText;
        finishButton.style.display = 'inline-block';
        onTextSelected(currentSelectedText);
      }
    };

    document.addEventListener('mouseup', handleMouseUp);

    // 添加键盘快捷键 (Enter确认，Escape取消)
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' && currentSelectedText) {
        cleanupTextSelection();
        finishButton.style.display = 'none';
        updateTextStatus(statusElement, currentSelectedText);
      } else if (e.key === 'Escape') {
        cleanupTextSelection();
        finishButton.style.display = 'none';
        statusElement.textContent = '已取消文字选择';
        statusElement.style.color = '#666';
      }
    };

    document.addEventListener('keydown', handleKeyDown);
  }

  // 更新文字状态显示
  function updateTextStatus(statusElement, text) {
    if (text && text.length > 0) {
      statusElement.textContent = `已选择 ${text.length} 个字符`;
      statusElement.style.color = '#52c41a';
    } else {
      statusElement.textContent = '未选择文字';
      statusElement.style.color = '#666';
    }
  }

  // 清理文字选择状态
  function cleanupTextSelection() {
    isTextSelectionMode = false;
    const hint = document.getElementById('yishe-text-selection-hint');
    if (hint) {
      hint.remove();
    }
  }

  // 监听来自background script的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'yishe:show-upload-dialog') {
      console.log('[YiShe] 收到显示弹窗消息:', request.data);

      // 显示上传弹窗
      createUploadDialog(request.data);

      // 设置 Promise 回调
      uploadResolve = (result) => {
        console.log('[YiShe] 弹窗操作完成:', result);
        sendResponse(result);
      };

      uploadReject = (error) => {
        console.log('[YiShe] 弹窗操作取消:', error);
        sendResponse({ action: 'cancel', error: error.message });
      };

      return true; // 保持消息通道开放
    }
  });

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
