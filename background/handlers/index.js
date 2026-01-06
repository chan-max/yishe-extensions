// handlers/index.js: 消息路由分发器
(function(global) {
  'use strict';

  /**
   * 消息处理器映射表
   * key: 消息命令类型
   * value: 处理器对象
   */
  const handlers = new Map();

  /**
   * 处理管理员消息
   * @param {Object} data - 消息数据
   * @param {Object} options - 选项，包含 logFn 和 socket
   * @returns {Promise<Object>} 处理结果
   */
  async function handleMessage(data, options = {}) {
    const { logFn = console.log, socket = null } = options;
    
    // 检查是否是命令消息
    if (!data || typeof data !== 'object' || !data.command) {
      return {
        handled: false,
        reason: '不是命令消息',
      };
    }
    
    const command = data.command;
    const handler = handlers.get(command);
    
    if (!handler) {
      logFn(`[MessageHandler] 未找到命令处理器: ${command}`);
      return {
        handled: false,
        reason: `未找到命令处理器: ${command}`,
      };
    }
    
    try {
      logFn(`[MessageHandler] 开始处理命令: ${command}`);
      await handler.handle(data, { logFn, socket });
      logFn(`[MessageHandler] 命令处理完成: ${command}`);
      return {
        handled: true,
        command,
      };
    } catch (error) {
      logFn(`[MessageHandler] 命令处理失败: ${command}`, error);
      return {
        handled: true,
        command,
        error: error?.message || '处理失败',
      };
    }
  }

  /**
   * 注册新的消息处理器
   * @param {string} command - 命令类型
   * @param {Object} handler - 处理器对象，必须包含 handle 方法
   */
  function registerHandler(command, handler) {
    if (!handler || typeof handler.handle !== 'function') {
      throw new Error('处理器必须包含 handle 方法');
    }
    handlers.set(command, handler);
    console.log(`[MessageHandler] 已注册处理器: ${command}`);
  }

  /**
   * 获取所有已注册的命令列表
   */
  function getRegisteredCommands() {
    return Array.from(handlers.keys());
  }

  // 自动注册已加载的处理器
  // 当前暂不做自动注册，需要手动注册处理器。
  // 如后续有新的命令处理器，可在其他脚本中通过 Router.register 手动注册：
  //   global.MessageHandlers.Router.register('your/command', yourHandler);

  // 暴露到全局
  global.MessageHandlers = global.MessageHandlers || {};
  global.MessageHandlers.Router = {
    handle: handleMessage,
    register: registerHandler,
    getCommands: getRegisteredCommands,
  };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
