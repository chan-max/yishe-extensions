# yishe 的插件工具集合

这是一个 Chrome 浏览器插件集合仓库，包含多个实用的浏览器插件。

## 插件列表

### core - 多功能工具集

一个模块化的多功能 Chrome 插件，支持不同网站的不同功能，带有悬浮机器人 UI。

**功能：**
- 🤖 页面右下角悬浮机器人图标
- 🎯 自动检测当前网站，加载对应功能模块
- 📦 模块化设计，易于扩展和维护
- 🎨 现代化的 UI 设计
- 🖱️ 可拖拽的机器人图标

**快速开始：**
1. 进入 `extensions/core` 目录
2. 查看 `README.md` 文件中的安装和使用说明
3. 按照说明安装和测试插件

**适用人群：**
- 需要为多个网站开发不同功能的开发者
- 需要数据爬取、页面增强等功能的用户
- 想要学习模块化 Chrome 插件开发的开发者

### test - 页面高亮测试插件

一个简单的测试插件，用于学习和测试 Chrome 插件开发。

**功能：**
- 在网页上搜索并高亮显示文本
- 一键清除所有高亮
- 自动滚动到第一个高亮位置

**快速开始：**
1. 进入 `extensions/test` 目录
2. 查看 `README.md` 文件中的安装和使用说明
3. 按照说明安装和测试插件

**适用人群：**
- Chrome 插件开发初学者
- 想要学习浏览器插件开发的开发者
- 需要测试插件功能的开发者

## 如何添加新插件

1. 在 `extensions` 目录下创建一个新文件夹
2. 在新文件夹中创建插件文件
3. 在 `README.md` 中添加插件说明
4. 提交代码

## 开发规范

- 每个插件应该有自己的文件夹
- 每个插件应该包含 `README.md` 说明文件
- 代码应该包含详细的中文注释
- 遵循 Chrome 扩展开发最佳实践
- 使用 Manifest V3 规范

## 学习资源

- [Chrome 扩展开发文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 指南](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Chrome 扩展示例](https://github.com/GoogleChrome/chrome-extensions-samples)

## 许可证

MIT License
