/* 无新增依赖的项目级静态检查。TypeScript 严格检查由 npm run typecheck 执行；
   本脚本约束本轮最关键的前端数据边界，避免业务状态重新落回浏览器。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = path.join(webRoot, "src");
const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
};
walk(sourceRoot);

const failures = [];
for (const file of files) {
  const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
  const source = fs.readFileSync(file, "utf8");
  if (/\bdebugger\b/.test(source)) failures.push(`${relative}: 禁止 debugger`);
  if (/console\.(log|debug)\s*\(/.test(source)) failures.push(`${relative}: 禁止遗留 console.log/debug`);
  if (/\bfetch\s*\(/.test(source) && relative !== "api.ts") failures.push(`${relative}: HTTP 请求必须集中在 api.ts`);
  // 同步按钮仅持久化请求编号以恢复查询，任务状态和业务数据仍由服务端提供。
  if (/localStorage/.test(source) && relative !== "components/LingxingSync.tsx") {
    failures.push(`${relative}: localStorage 仅允许保存同步请求编号`);
  }
}

const requirementSource = fs.readFileSync(path.join(sourceRoot, "views", "Requirement1.tsx"), "utf8");
if (/from\s+["']\.\.\/data["']/.test(requirementSource)) {
  failures.push("views/Requirement1.tsx: 库存页不得从静态 data.ts 读取业务数据");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`PASS frontend architecture lint (${files.length} TypeScript files)`);
