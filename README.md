# Unismar 耗材库存系统

该仓库包含 Node.js 后端、React 前端、SQLite schema 与迁移、领星浏览器扩展及采集脚本、合成测试夹具和 Windows 部署脚本。当前数据库结构版本为 schema 36。

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
npm run test:ink-approval-v36
npm run test:upgrade-template
npm run test:relocation-workflow
npm run test:relocation-waybills
npm run test:transfer-workflow
```

`npm test` 和 `npm run check` 不是全系统覆盖结论；墨盒审批、升级、模板、运单、团队权限以及页面恢复等专项须按变更影响补充执行。测试证据需记录受测源码和构建指纹，历史分阶段 PASS 数量不能代表当前源码全部通过。

页面测试需要已安装的 Edge。测试数据库、随机端口和生成文件相互隔离；默认测试输出位于被忽略的 `.test-output/` 或系统临时目录。默认测试使用合成数据。`test:upgrade-real-warehouses` 须显式提供本轮核准的静态数据库副本 `ASTER_REAL_CONFIG_BASELINE_DB` 及配置副本 `ASTER_RUNTIME_CONFIG`，仅写入再次复制的新隔离目录；不得传入正式库。原模板比对须显式指定 `ASTER_UPGRADE_TEMPLATE`，只读原文件。

## 新建本地数据库并启动

以下示例使用独立状态目录和 4174 端口，不接触其他运行中的服务：

```powershell
$env:ASTER_STATE_ROOT = Join-Path $env:LOCALAPPDATA 'UnismarInventory\development'
$env:HOST = '127.0.0.1'
$env:PORT = '4174'
$env:PROD = '1'
npm run initialize -- --state-root "$env:ASTER_STATE_ROOT"
npm start
```

首次初始化会创建 schema 36 数据库和合成演示目录；不会导入正式库存数据。停止本地开发服务可在运行窗口按 `Ctrl+C`。不要把 `ASTER_STATE_ROOT` 指向正式数据目录。

## 历史数据库迁移与私有来源

schema 1–27 的迁移需要 47 条私有在途来源，以核验并修正套/箱、库存批次和团队关联。缺少文件、格式无效或不能逐行匹配时，迁移会报错且不会提交新的 schema 版本；不得用示例文件代替，也不得跳过修正。

迁移前将本地保留的 `.local-private/legacy-inbound-sources.local.json` 放到仓库根目录下的同一路径，或在 PowerShell 中显式设置：

```powershell
$env:ASTER_PRIVATE_INBOUND_SOURCES = 'C:\private\legacy-inbound-sources.local.json'
npm run migrate
```

`scripts/fixtures/legacy-inbound-sources.example.json` 仅展示格式，其中是合成的一行样例，不满足历史迁移所需的 47 行校验。schema 28–35 使用同一受控脚本升级至 schema 36；当前版本无需重复迁移。

schema 36 增加墨盒独立 Alan 审核节点。采购／物流可跳过尚未办理的 Alan 直接最终回复；跳过字段保持空值，Alan 回复 0 仍进入待采购回复。调拨按各阶段差额调整预锁，采购归档才扣实际库存；询库不占库存。采购／物流回撤保留 Alan 结果，商务回撤清空后续当前结果并从历史恢复原数量。迁移只将尚待后续回复的旧墨盒单据转入 Alan 阶段，已回复单据继续原阶段。

原运行配置中的仓库名称保存在被忽略的 `.local-private/runtime-config.local.json`。没有该本地文件时，新副本使用合成默认名称；也可通过 `ASTER_OVERSEAS_WAREHOUSES` 环境变量覆盖，多个名称以分号分隔。

移仓账号的简称、房间号保存在本地 `.local-private/warehouse-accounts.local.json`，由已确认的地址表生成，也可通过 `ASTER_WAREHOUSE_ACCOUNTS` 指定文件。部署时保留该文件和仓库配置，复制到候选版本后重新计算发布指纹；它们不提交 Git。缺少账号简称或房间号时，RMA更新会明确报错，不补值。运行合成仓库回归时设置 `ASTER_OVERSEAS_WAREHOUSES=SyntheticWarehouseA;SyntheticWarehouseB`，避免使用本机正式仓库名称。

## 转仓升级

首次导入读取“转仓升级”工作表第2—3行合并表头及第4行起的数据，前9项必填；退仓数量为非负整数销售套数。状况由系统设为“已在第三方海外仓”，后续字段留空。物流在升级库存中分别下载RMA、实际清点数量、升级进度更新模板，更新模板与数据流导出统一使用原模板15列，第1行空白，第2—3行纵向合并表头，第4行起为数据。Excel不含转仓单号或记录版本，按前9项固定业务资料精确匹配；无匹配、匹配不唯一或文件多行对应同一记录时整批停止。内容相同的独立记录继续保留，不能通过原模板分别更新。RMA和清点量可修正，不退回资料步骤。

升级进度填写当前升级中量和累计完成量，两者之和不得超过清点量，清点量不得超过退仓量。新增完成量按差额记入独立批次；原入库批次和本次扣回量在导入确认页面填写，只有累计量减少时生效，不加入Excel。指定入库存在当前锁定或下游占用时整批拒绝。模板预览不推进业务，确认采用事务、记录版本及同一请求去重。

转仓入库实际仓库固定为“Aster海外仓”，发货方式为“Aster海外仓-升级后库存”。这些批次为两团共享的公共库存，其他批次权限不变。套/箱留空，不自动补值，补齐前不能调拨；本轮没有新增补填入口。入库型号必须已存在于库存目录并有明确类目。schema34迁移若发现旧只读转仓记录，会列出原记录并停止，必须先确认阶段和入库事实，不能按旧完成数量自动补账。

移仓更新模板、数据流导出和运单导出共用原模板19列，第1行空白，第2行表头，第3行起为数据。移仓按型号、来源、发货计划号、发货时间、业务版本号、FNSKU、初始调拨数量、调拨店铺和订单号精确匹配；订单号空白也参与匹配。物流仍只更新RMA和原始地址。FBA剩余库存继续按来源余额扣除已移仓量计算。单号和记录版本保留在系统内部。

Excel不携带记录版本，不能据此识别文件导出后发生的所有变更；导入预览使用系统当前值，确认提交校验预览时的内部版本。非本次允许更新字段与当前值不一致时会拒绝，不能把这种值比较当作导出版本检查。运单文件仅含内部文档用途属性，不添加页面标识、单元格、隐藏列、批注或说明页；改名后仍拒绝用于导入。若另存工具删除该属性，系统无法从逐格相同的内容追溯文件来源。

原模板样式资源位于 `upgrade-workbook-template.json`，仅提取表头、样式和布局，不含原示例。独立验收 `npm run test:upgrade-template`；设置 `ASTER_UPGRADE_TEMPLATE` 为用户原文件路径时逐项比较原模板SHA-256、列宽、行高、字体、合并结构与实际导出，测试仍使用隔离业务数据。

隔离验收：`npm run test:transfer-workflow`。包含接口、实际XLSX独立读取、真实Edge页面、并发/重试、公共库存和schema33迁移；不写正式业务库。

## 领星扩展

从仓库根目录运行 `node scripts/build-edge-extension.mjs` 可同步采集脚本并生成 `web/public/aster-lingxing-extension.zip`。也可在 Edge 的扩展管理页启用开发人员模式，加载 `edge-extension/` 目录。

扩展不会保存领星密码或绕过登录验证。使用者需在浏览器中自行登录，并在扩展设置里配置库存服务地址。扩展源码位于 `edge-extension/`，采集脚本的维护源位于 `scripts/`。 移仓同步沿用“移除入库单”，读取该页面全部分页和展开后的匹配包裹商品行；按账号、订单号、FNSKU自动写入承运商、运单号与累计已发货量。同一包裹不重复扣减来源余额，同步本身不入库。此范围不保证领星未推送到该页面的历史包裹，不能表述为完整历史订单取数。

## 部署脚本

`deploy/` 内脚本用于 Windows 计划任务、防火墙和服务部署，依赖既有的持久化数据库及构建产物。安装服务时需先设置 `ASTER_LAN_SUBNET` 为目标主机的局域网 CIDR 网段。开发和空库初始化请使用上面的 npm 命令；运行部署安装或卸载脚本前应按目标 Windows 主机配置部署参数。

## 仓库数据边界

正式 SQLite 数据库及 WAL/SHM、历史备份、原始业务表格、会话与凭据、日志、截图和审查证据、临时库、依赖缓存、`node_modules`、历史发布目录及旧部署副本均不属于仓库。真实在途来源和原始仓库配置仅保存在本地 `.local-private/`，Git 忽略该目录。
