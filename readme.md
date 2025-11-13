# Core 多功能工具集

一个多功能 Chrome 插件，聚焦通用工具面板与悬浮机器人 UI。

## 功能特点

- 🤖 **悬浮机器人**: 页面右下角显示悬浮面板入口
- 🎨 **美观 UI**: 现代化的界面设计，流畅的动画效果
- 🧰 **通用工具**: 提供页面信息、快捷操作等常用能力
- 🖱️ **可拖拽**: 机器人图标可以拖拽到任意位置

## 目录结构

```
core/
├── manifest.json                 # 插件配置文件
├── content/
│   ├── content-base.js          # 基础 content script
│   ├── components/
│   │   └── floating-robot.js    # 悬浮机器人组件
│   ├── sites/                   # 网站功能模块目录
│   │   ├── common.js            # 通用功能（所有网站）
│   │   ├── site1/               # 网站1的功能文件夹
│   │   │   └── index.js         # 网站1的功能模块
│   │   └── site2/               # 网站2的功能文件夹
│   │       └── index.js         # 网站2的功能模块
│   ├── styles/
│   │   └── robot.css            # 机器人样式
│   └── utils/                   # 工具函数
│       ├── dom-utils.js         # DOM 操作工具
│       └── site-detector.js     # 页面信息采集工具
├── background/
│   └── service-worker.js        # 后台服务 Worker
├── popup/
│   ├── popup.html               # 弹窗界面
│   ├── popup.js                 # 弹窗逻辑
│   └── popup.css                # 弹窗样式
└── icons/                       # 插件图标（可选）
```

## 目录组织说明

- **通用功能**: 放在 `content/sites/common.js`
- **网站特定功能**: 放在 `content/sites/{模块名}/index.js`，只有匹配的网站才会加载
- **模块文件夹**: 每个网站的功能放在独立的文件夹中，便于组织和管理多个文件

## 安装步骤

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `core` 文件夹
5. 完成！插件会显示在浏览器工具栏

## 使用方法

1. **打开任意网页**
2. **查看悬浮机器人**: 页面右下角会显示一个机器人图标 🤖
3. **点击机器人**: 点击机器人图标，会显示功能菜单
4. **选择功能**: 菜单中会显示常用工具
5. **使用功能**: 点击菜单项执行相应功能
6. **拖拽机器人**: 可以拖拽机器人图标到任意位置

## 菜单项格式

```javascript
{
  icon: '🎯',           // 图标（可选）
  label: '功能名称',     // 显示文本
  action: () => {},     // 点击时执行的操作
  disabled: false       // 是否禁用（可选）
}
```

## 工具函数

### DOM 工具 (dom-utils.js)

- `createElement(tag, className, innerHTML)`: 创建元素
- `addStyles(css)`: 添加样式
- `waitForElement(selector, timeout)`: 等待元素出现
- `debounce(func, wait)`: 防抖函数
- `throttle(func, limit)`: 节流函数
- `showNotification(message, type)`: 显示通知

### 网站检测 (site-detector.js)

- `detectSite()`: 检测当前网站
- `getCurrentSiteInfo()`: 获取当前网站信息

## 代码组织原则

1. **模块化**: 每个网站的功能应该独立成模块
2. **文件夹组织**: 每个网站的功能放在独立的文件夹中
3. **通用功能**: 通用功能放在 `common.js` 中
4. **错误处理**: 添加适当的错误处理逻辑
5. **日志输出**: 使用 `console.log` 方便调试
6. **代码注释**: 添加清晰的中文注释

## 常见问题

**Q: 机器人图标不显示？**  
A: 检查浏览器控制台是否有错误，确保页面已完全加载。某些特殊页面（如 chrome:// 页面）可能不支持。

**Q: 功能菜单不显示？**  
A: 检查浏览器控制台是否有错误，确保网站配置正确，模块文件存在。

**Q: 如何禁用某个网站的功能？**  
A: 在 `config/sites.json` 中将对应网站的 `enabled` 设置为 `false`。

**Q: 如何修改机器人位置？**  
A: 编辑 `content/styles/robot.css` 中的 `.core-robot-container` 样式，或者直接拖拽机器人图标。

**Q: 如何添加新功能？**  
A: 在对应的网站模块文件夹中修改 `index.js` 文件，添加菜单项和功能函数。

**Q: 为什么网站功能要放在文件夹中？**  
A: 便于组织和管理多个文件，当一个网站的功能比较复杂时，可以在文件夹中创建多个文件。

## 开发建议

1. **模块化**: 每个网站的功能应该独立成模块
2. **文件夹组织**: 使用文件夹组织网站功能，便于管理
3. **可复用**: 通用功能放在 `common.js` 中
4. **错误处理**: 添加适当的错误处理逻辑
5. **日志输出**: 使用 `console.log` 方便调试
6. **代码注释**: 添加清晰的中文注释

## 下一步

- [ ] 添加更多网站功能模块
- [ ] 实现数据存储和导出功能
- [ ] 添加设置页面
- [ ] 支持自定义机器人样式
- [ ] 添加功能快捷键
- [ ] 实现数据爬取功能

## 学习资源

- [Chrome 扩展开发文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 指南](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Content Scripts 文档](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)

祝开发愉快！🎉
