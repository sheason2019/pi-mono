# d-pi 官方文档站

Docusaurus 站点源码，部署后供 d-pi 终端用户查阅。

## 开发

```bash
npm install
npm run start    # http://localhost:3000
```

## 构建

```bash
npm run build
npm run serve    # 本地预览 build 产物
```

## 写新页面

1. 在 `docs/<section>/` 下新增 `xxx.md`
2. 在 `sidebars.ts` 对应 section 的 `items` 加一项
3. `npm run start` 浏览器热重载验证
4. `npm run build` 验 broken link
5. 单独 `git add docs/<新文件> sidebars.ts` 提交
