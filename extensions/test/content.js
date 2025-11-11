// content.js: 注入到网页中的脚本
// 这个脚本可以直接操作网页的 DOM（文档对象模型）

// 存储高亮的元素，方便后续清除
let highlightedElements = [];

// 监听来自 popup.js 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    // 响应 ping 消息，表示 content script 已加载
    sendResponse({ success: true, ready: true });
    return true;
  } else if (request.action === 'highlight') {
    // 执行高亮操作
    const count = highlightText(request.text);
    sendResponse({ success: true, count: count });
    return true;
  } else if (request.action === 'clear') {
    // 执行清除操作
    clearHighlights();
    sendResponse({ success: true });
    return true;
  }
  
  // 返回 true 表示会异步发送响应
  return true;
});

// 高亮文本函数
function highlightText(searchText) {
  // 先清除之前的高亮
  clearHighlights();
  
  if (!searchText) {
    return 0;
  }
  
  let count = 0;
  const searchTextLower = searchText.toLowerCase();
  
  // 使用更简单的方法：遍历所有文本节点
  function walkTextNodes(node, callback) {
    if (node.nodeType === Node.TEXT_NODE) {
      // 如果是文本节点，执行回调
      callback(node);
    } else {
      // 如果是元素节点，遍历子节点
      // 排除脚本和样式标签
      if (node.tagName !== 'SCRIPT' && 
          node.tagName !== 'STYLE' && 
          node.tagName !== 'NOSCRIPT') {
        for (let child of node.childNodes) {
          walkTextNodes(child, callback);
        }
      }
    }
  }
  
  // 收集所有需要高亮的文本节点
  const nodesToHighlight = [];
  
  walkTextNodes(document.body, (textNode) => {
    const text = textNode.textContent;
    if (text && text.toLowerCase().includes(searchTextLower)) {
      nodesToHighlight.push(textNode);
    }
  });
  
  // 高亮所有匹配的文本节点
  nodesToHighlight.forEach(textNode => {
    const text = textNode.textContent;
    const searchIndex = text.toLowerCase().indexOf(searchTextLower);
    
    if (searchIndex !== -1) {
      const parent = textNode.parentNode;
      
      // 分割文本
      const beforeText = text.substring(0, searchIndex);
      const matchText = text.substring(searchIndex, searchIndex + searchText.length);
      const afterText = text.substring(searchIndex + searchText.length);
      
      // 创建文档片段
      const fragment = document.createDocumentFragment();
      
      // 添加前面的文本
      if (beforeText) {
        fragment.appendChild(document.createTextNode(beforeText));
      }
      
      // 创建高亮标记
      const mark = document.createElement('mark');
      mark.className = 'highlight-mark';
      mark.textContent = matchText;
      fragment.appendChild(mark);
      
      // 添加后面的文本
      if (afterText) {
        fragment.appendChild(document.createTextNode(afterText));
      }
      
      // 替换原来的文本节点
      parent.replaceChild(fragment, textNode);
      
      // 记录高亮的元素
      highlightedElements.push(mark);
      count++;
    }
  });
  
  // 滚动到第一个高亮的位置
  if (highlightedElements.length > 0) {
    highlightedElements[0].scrollIntoView({ 
      behavior: 'smooth', 
      block: 'center' 
    });
  }
  
  return count;
}

// 清除所有高亮
function clearHighlights() {
  highlightedElements.forEach(mark => {
    // 获取高亮标记的父节点
    const parent = mark.parentNode;
    
    // 获取高亮标记的文本内容
    const highlightText = mark.textContent;
    
    // 获取前后的文本节点
    const prevSibling = mark.previousSibling;
    const nextSibling = mark.nextSibling;
    
    // 合并所有文本
    let fullText = '';
    if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
      fullText += prevSibling.textContent;
    }
    fullText += highlightText;
    if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
      fullText += nextSibling.textContent;
    }
    
    // 创建新的文本节点
    const textNode = document.createTextNode(fullText);
    
    // 替换高亮标记和相邻的文本节点
    if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
      parent.removeChild(prevSibling);
    }
    if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
      parent.removeChild(nextSibling);
    }
    parent.replaceChild(textNode, mark);
  });
  
  // 清空数组
  highlightedElements = [];
}

// 控制台输出，方便调试
console.log('页面高亮插件已加载');
