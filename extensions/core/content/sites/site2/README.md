# Site2 功能模块

这是网站2的功能模块文件夹。

## 文件说明

- `index.js` - 主模块文件（必需），包含模块的初始化和菜单项定义

## 如何添加更多文件

如果功能比较复杂，可以在这个文件夹中添加更多文件：

```
site2/
├── index.js          # 主模块文件（必需）
├── utils.js          # 工具函数
├── crawler.js        # 爬虫功能
└── styles.css        # 样式文件
```

然后在 `index.js` 中通过动态加载的方式引入其他文件。

## 注意事项

- `index.js` 是必需的，插件会加载这个文件
- 模块必须注册到 `window.CoreSiteModules.site2`
- 必须实现 `init()` 和 `getMenuItems()` 方法

