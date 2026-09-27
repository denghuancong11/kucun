# 审批中心询库 Excel 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在审批中心把当前角色可见的全部硒鼓与墨盒询库单据导出为字段类型正确的 `.xlsx`。

**Architecture:** 复用 `fetchApprovals(role)` 在导出时主动读取权限过滤后的新数据；浏览器把 `inquiries` 转成仅含 11 列的 OOXML 工作簿并下载。Excel 字符串以显式文本单元格编码，数量以数值单元格编码，现有后端过滤与页面草稿保持独立。

**Tech Stack:** React 18、TypeScript、Vite 6、Playwright、fflate ZIP 编解码。

---

### Task 1: 建立真实页面导出回归

**Files:**
- Create: `web/scripts/approval-inquiry-export-page-check.mjs`
- Modify: `package.json`

- [x] 创建隔离 SQLite、权限配置、随机端口后启动 `server.mjs`，用 Playwright 打开真实审批中心。
- [x] 在测试中等待“导出询库”按钮并监听下载；先运行脚本，确认当前版本因页面没有该按钮而失败。
- [x] 将脚本加入 `test:page`，并预留工作簿 ZIP/XML 检查、权限、筛选、最新值及失败分支断言。

### Task 2: 实现询库工作簿与页面入口

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`
- Create: `web/src/utils/inquiry-export.ts`
- Modify: `web/src/views/ApprovalCenter.tsx`

- [x] 添加 fflate ZIP 依赖；工作簿只含 `[Content_Types].xml`、根关系、workbook、workbook 关系和单张工作表。
- [x] 固定表头为 `型号`、`商务部审核数量`、`供应商库存回复`、`发货仓库`、`采购备注`、`调拨部门`、`调拨店铺`、`调拨运营`、`已贴FNSKU`、`提交时间`、`状况`。
- [x] 字符串使用 inline string 并 XML 转义；数量仅在字段为 `null` 时留空，数字 0 写作数值单元格。
- [x] 导出按钮直接调用 `fetchApprovals(role)`；仅使用响应的 `inquiries`，呈现进行中、失败和无数据提示；成功后下载固定名称的 `.xlsx`。
- [x] 状况按采购零回复自动归档、助理完成及其余 `statusText` 分别转换；提交时间调用现有 `displayTime(createdAt)`。

### Task 3: 完成端到端验收与回归

**Files:**
- Modify: `web/scripts/approval-inquiry-export-page-check.mjs`

- [x] 在隔离库准备两类、多张同型号询库、调拨、空字段、历史数量差异、0回复、助理完成、旧终态隐藏及特殊文本。
- [x] 下载真实文件，用 `fflate.unzipSync` 检查 OOXML 工作表、严格 11 列、每单独一行、文本/数值单元格和全部目标值。
- [x] 切换筛选/待办/折叠状态，验证范围仍与该角色 API 响应完全一致；以第二客户端更新采购回复证明点击时取得新值。
- [x] 验证草稿不入文件、API 失败不下载缓存、空询库提示、连续点击只产生一次请求、权限与隐藏规则生效，且导出不改变业务记录、库存和事件。
- [x] 运行 `npm run test:approval-export`、`npm run lint`、`npm --prefix web run build`、`npm test`、`npm run test:source-scope` 和 `node web/scripts/approvals-page-check.mjs`。

### Task 4: 独立审查并提交

**Files:**
- Review: 本次全部源码、测试、锁文件与验收文档

- [x] 对照需求逐项审查数据来源、筛选隔离、权限、状态映射、Excel 单元格类型和失败行为；独立审查确认初始测试缺口补齐后愿景已满足。
- [x] 测试只写入隔离的临时库，检查导出前后单据、库存和事件一致。
- [x] 只暂存本次相关文件，按仓库提交格式创建一个有 Why / Why this works / Remaining 正文的提交。
