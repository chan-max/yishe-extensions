# 页面高亮测试插件

一个简单的 Chrome 浏览器插件示例，用于学习和测试。插件可以在网页上高亮显示指定的文本。

## 功能

- 在任意网页上搜索并高亮显示文本
- 一键清除所有高亮
- 自动滚动到第一个高亮位置

## 安装

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `test` 文件夹
5. 完成！插件会显示在浏览器工具栏

## 使用

1. 打开任意网页
2. 点击浏览器工具栏上的插件图标
3. 输入要搜索的文本，点击"高亮"按钮
4. 点击"清除"按钮可清除所有高亮

## 文件说明

- `manifest.json` - 插件配置文件
- `popup.html` - 插件弹窗界面
- `popup.js` - 弹窗逻辑脚本
- `content.js` - 注入到网页中的脚本（执行高亮操作）
- `styles.css` - 高亮样式文件

## 架构设计

如果您需要实现多个功能（如多个网站爬取），请查看 `架构设计建议.md` 文件，了解单插件 vs 多插件的选择建议。

## 常见问题

**Q: 插件无法加载？**  
A: 检查 `manifest.json` 文件格式是否正确，确保所有引用的文件都存在。

**Q: 高亮功能不工作？**  
A: 按 F12 打开开发者工具查看控制台错误，确保插件已正确加载，刷新网页后重试。

**Q: 出现 "Could not establish connection" 错误？**  
A: 已修复！插件会自动检测并注入 content script，如果仍有问题，请刷新页面后重试。

**Q: 如何修改高亮颜色？**  
A: 编辑 `styles.css` 文件中的 `.highlight-mark` 样式，修改 `background-color` 属性。

## 学习资源

- [Chrome 扩展开发文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 指南](https://developer.chrome.com/docs/extensions/mv3/intro/)

## 下一步

尝试添加以下功能：
- 保存搜索历史
- 支持多个关键词同时高亮
- 支持正则表达式搜索
- 添加不同的高亮颜色主题
