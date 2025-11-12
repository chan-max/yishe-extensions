# 图标文件说明

这个文件夹用于存放插件的图标文件。

## 需要的图标文件

- `icon16.png` - 16x16 像素，用于浏览器工具栏
- `icon48.png` - 48x48 像素，用于扩展管理页面
- `icon128.png` - 128x128 像素，用于 Chrome 网上应用店

## 如何创建图标

### 方法1: 使用在线工具
1. 访问 [Favicon Generator](https://www.favicon-generator.org/)
2. 上传你的图片或使用在线编辑器
3. 下载不同尺寸的图标

### 方法2: 使用图片编辑软件
1. 使用 Photoshop、GIMP 等软件
2. 创建 128x128 的图片
3. 导出为不同尺寸的 PNG 文件

### 方法3: 使用占位图标
如果你暂时没有图标，可以：
1. 创建一个简单的彩色方块
2. 或者使用文字图标生成器
3. 或者从 [Icon Finder](https://www.iconfinder.com/) 下载免费图标

## 临时解决方案

如果暂时没有图标文件，可以修改 `manifest.json`，删除图标相关配置：

```json
{
  "manifest_version": 3,
  "name": "Core 多功能工具集",
  "version": "1.0.0",
  "permissions": [...],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Core 工具集"
  },
  ...
}
```

删除 `default_icon` 和 `icons` 配置后，插件仍然可以正常工作，只是没有自定义图标。

