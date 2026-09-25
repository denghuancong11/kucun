# Unismar 耗材库存系统

该仓库包含 Node.js 后端、React 前端、SQLite schema 与迁移、领星浏览器扩展及采集脚本、合成测试夹具和 Windows 部署脚本。当前数据库结构版本为 schema 28。

## 运行环境

- Windows 10/11
- Node.js 24.x 与 npm 11
- PowerShell 7（`pwsh.exe`，构建领星扩展压缩包时使用）
- Microsoft Edge；浏览器页面验收默认使用 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

## 安装、构建和验证

在仓库根目录执行：

```powershell
npm ci
npm ci --prefix web
npm run build
```

`npm run build` 会从 `scripts/` 同步两个领星采集脚本到 `edge-extension/`，生成扩展压缩包，并构建 React 前端。`web/dist/` 和 `web/public/aster-lingxing-extension.zip` 都是可重建产物，默认不提交。

常用验证命令：

```powershell
npm test
npm run test:migration
npm run test:warehouse-fba
npm run test:teams
npm run test:teams-page
npm run test:warehouse-fba-page
npm run test:page
```

页面测试需要已安装的 Edge。测试数据库、随机端口和生成文件相互隔离；默认测试输出位于被忽略的 `.test-output/` 或系统临时目录。测试不会读取正式数据库、历史备份或本机业务 Excel。

## 新建本地数据库并启动

以下示例使用独立状态目录和 4174 端口，不接触其他运行中的服务：

```powershell
$env:ASTER_STATE_ROOT = Join-Path $env:LOCALAPPDATA 'UnismarInventory\development'
$env:HOST = '127.0.0.1'
$env:PORT = '4174'
$env:PROD = '1'
npm run initialize
npm start
```

首次初始化会创建 schema 28 数据库和合成演示目录；不会导入正式库存数据。停止本地开发服务可在运行窗口按 `Ctrl+C`。不要把 `ASTER_STATE_ROOT` 指向正式数据目录。

## 历史数据库迁移与私有来源

schema 1–27 的迁移需要 47 条私有在途来源，以核验并修正套/箱、库存批次和团队关联。缺少文件、格式无效或不能逐行匹配时，迁移会报错且不会提交新的 schema 版本；不得用示例文件代替，也不得跳过修正。

迁移前将本地保留的 `.local-private/legacy-inbound-sources.local.json` 放到仓库根目录下的同一路径，或在 PowerShell 中显式设置：

```powershell
$env:ASTER_PRIVATE_INBOUND_SOURCES = 'C:\private\legacy-inbound-sources.local.json'
npm run migrate
```

`scripts/fixtures/legacy-inbound-sources.example.json` 仅展示格式，其中是合成的一行样例，不满足历史迁移所需的 47 行校验。schema 28 数据库无需重复迁移。

原运行配置中的仓库名称保存在被忽略的 `.local-private/runtime-config.local.json`。没有该本地文件时，新副本使用合成默认名称；也可通过 `ASTER_OVERSEAS_WAREHOUSES` 环境变量覆盖，多个名称以分号分隔。

## 领星扩展

从仓库根目录运行 `node scripts/build-edge-extension.mjs` 可同步采集脚本并生成 `web/public/aster-lingxing-extension.zip`。也可在 Edge 的扩展管理页启用开发人员模式，加载 `edge-extension/` 目录。

扩展不会保存领星密码或绕过登录验证。使用者需在浏览器中自行登录，并在扩展设置里配置库存服务地址。扩展源码位于 `edge-extension/`，采集脚本的维护源位于 `scripts/`。

## 部署脚本

`deploy/` 内脚本用于 Windows 计划任务、防火墙和服务部署，依赖既有的持久化数据库及构建产物。安装服务时需先设置 `ASTER_LAN_SUBNET` 为目标主机的局域网 CIDR 网段。开发和空库初始化请使用上面的 npm 命令；运行部署安装或卸载脚本前应按目标 Windows 主机配置部署参数。

## 仓库数据边界

正式 SQLite 数据库及 WAL/SHM、历史备份、原始业务表格、会话与凭据、日志、截图和审查证据、临时库、依赖缓存、`node_modules`、历史发布目录及旧部署副本均不属于仓库。真实在途来源和原始仓库配置仅保存在本地 `.local-private/`，Git 忽略该目录。
