## 背景脚本（background）结构总览

> 这一节只讲 **background 目录**，帮你快速搞清楚「哪个文件负责什么」，看代码时不迷路。

### 1. 文件一览

- `background/service-worker.js`
  - 整个插件后台逻辑的 **入口文件**
  - 主要职责：
    - 加载依赖（`socket.io`、`handlers/base.js`、`handlers/index.js`）
    - 管理与 **后端 WebSocket** 的连接（1s.design:1520）
    - 管理与 **本地 Electron 客户端** 的 WebSocket 连接（localhost:1519）
    - 维护连接状态（`wsState` / `clientWsState`），并广播给前端（popup 等）
    - 处理全局生命周期事件：`onInstalled`、`onStartup`、`storage.onChanged` 等
    - 管理右键菜单（context menu），目前只保留「打印当前页面信息」

- `background/handlers/base.js`
  - **基础工具库**，不做具体业务。
  - 提供的方法（被其他逻辑复用）：
    - `serializeError(error)`：把错误安全地转成字符串
    - `guessExtension(url, contentType)`：根据 URL / Content-Type 猜图片后缀
    - `createTabAndWait(url, timeoutMs)`：创建一个后台标签页并等待加载完成
    - `waitForTabComplete(tabId, timeoutMs)`：等待指定标签页加载完成
    - `executeScript(tabId, func, args)`：往标签页里注入函数并执行
    - `storageGet(keys)` / `storageSet(data)`：对 `chrome.storage.local` 的 Promise 封装

- `background/handlers/index.js`
  - **命令路由器（Router）**
  - 内部维护一个 `handlers` 映射表：`command => handler`
  - 对外暴露：
    - `Router.handle(data, { logFn, socket })`：根据 `data.command` 分发到对应 handler
    - `Router.register(command, handler)`：注册新命令处理器
    - `Router.getCommands()`：查看当前已注册的命令列表
  - 当前项目中，Pinterest / Sora 等爬取功能已移除，所以这里暂时只保留 Router 壳子，方便以后扩展。

---

### 2. 建议的阅读顺序（给初学者）

1. **从 `service-worker.js` 顶部开始看「分区注释」**
   - 已经按功能分成几块：
     - 一、依赖加载 & 全局配置
     - 二、错误序列化 & 通用工具
     - ……
     - 五、全局错误处理
     - 六、安装 / 启动 / 存储变更等生命周期事件
     - 七、Service Worker 启动入口
     - 八、扩展内部消息分发
   - 先理解「每一块大概负责什么」，不用把每一行细节都看懂。

2. **再看 `handlers/base.js`**
   - 这里的函数你可以当成「工具箱」，常用就记住：
     - `serializeError` / `guessExtension`
     - `createTabAndWait` / `executeScript`
     - `storageGet` / `storageSet`
   - 以后你要写新功能，可以直接调用这些工具。

3. **最后看 `handlers/index.js`（Router）**
   - 当前项目里它比较简单，主要是预留一个「命令总线」。
   - 以后如果你要做类似「执行某个爬图命令」「执行某个批量任务」，可以：
     - 在新文件 `background/handlers/xxx.js` 里写具体逻辑
     - 在初始化时调用：`global.MessageHandlers.Router.register('xxx/do-something', yourHandler)`

---

### 3. 以后如果要继续拆分的方向（可选）

目前为了减少改动，`service-worker.js` 仍然是一个「大脑 + 神经系统」的综合文件。以后你熟悉了，可以按下面方向继续拆：

- `background/ws-server.js`
  - 只负责和后端 WebSocket 相关的逻辑（`initWebsocket`、`connectWebsocketIfAuthenticated`、心跳等）
- `background/ws-client.js`
  - 只负责和本地客户端 WebSocket 相关的逻辑
- `background/context-menus.js`
  - 只放右键菜单相关的逻辑（`initContextMenus` + `onClicked`）

拆分原则：

- **一个文件只关心一类事情**
- 入口文件 `service-worker.js` 只做：
  - 加载这些模块
  - 调用它们的初始化函数
  - 连接生命周期事件

---

### 4. 给你的一个「脑图」

可以把 background 理解成下面这种思维导图结构：

- `service-worker.js`
  - 依赖加载
  - WebSocket 状态管理
  - 初始化流程 `initialize()`
  - 全局事件监听（安装 / 启动 / 存储 / 消息 / 右键菜单）
- `handlers/base.js`
  - 错误处理
  - 标签页 / 脚本注入
  - storage 工具
- `handlers/index.js`
  - Router（命令分发）

只要记住这一张图，再配合文件中的分区注释，你就可以「一目了然」地知道每一段代码的大致用途，慢慢从整体到细节地看。以后要加新功能，我们也可以在这个结构下，帮你一步步扩展。 


