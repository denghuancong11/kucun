# 领星浏览器扩展

扩展为 Chromium Manifest V3 扩展，源码位于 `edge-extension/`。维护中的领星页面采集脚本位于 `scripts/lingxing-page-collector.js` 和 `scripts/lingxing-removal-page-collector.js`。

## 构建与加载

在仓库根目录运行：

```powershell
node scripts/build-edge-extension.mjs
```

脚本会将维护源同步到扩展目录，并生成 `web/public/aster-lingxing-extension.zip`。压缩包是可重建产物，不提交。也可在 Edge 扩展管理页启用开发人员模式并加载 `edge-extension/`。

## 使用

1. 在 Edge 中自行登录领星并打开具备所需权限的报表页。
2. 打开扩展设置，填写库存服务地址并连接。
3. 在库存系统页面发起同步。扩展只在已有的报表页执行读取操作，并将采集结果发送到配置的库存服务。

扩展不保存登录密码、不执行登录操作，也不替代人工处理订单、移除单或库存入库。浏览器闹钟用于恢复连接和待确认任务；浏览器或操作系统调度可能延迟实际触发时间。

## 开发验证

`npm run test:collectors` 使用合成页面检查采集字段；`npm run test:edge-sync` 使用本地模拟服务验证扩展消息与回执流程。两者均不连接正式库存数据库或领星账户。
