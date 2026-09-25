# 领星采集脚本

两份采集脚本的唯一维护源为本目录：

- `lingxing-page-collector.js`：读取指标报表中的 ASIN、筛选区间、销量、毛利与库存字段。
- `lingxing-removal-page-collector.js`：按移除单号和 FNSKU 汇总包裹行。

脚本仅读取浏览器页面，不提交订单、收货或库存操作。扩展在已有报表标签中运行脚本，并将采集结果回传到配置的库存服务。未登录、验证码、目标记录不唯一或字段不完整时会返回错误，不绕过权限校验。

运行 `node scripts/build-edge-extension.mjs` 会把这两份维护源复制到 `edge-extension/` 并生成扩展压缩包。不要直接编辑生成副本；下一次构建会覆盖它们。

`npm run test:collectors` 和 `npm run test:edge-sync` 使用仓库内合成页面与隔离服务，不读取正式业务数据。
