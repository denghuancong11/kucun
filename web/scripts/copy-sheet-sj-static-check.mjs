import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

// Read-only checks for the approved upgrade copy. No browser, service, or database.
const web = path.resolve(import.meta.dirname, '..');
const names = ['views/Requirement4.tsx', 'components/DirectUpgrade.tsx', 'components/RelocationUpgrade.tsx', 'components/RelocationUpdate.tsx', 'components/RelocationWaybills.tsx', 'components/RelocationExternalShipments.tsx', 'components/TransferUpgrade.tsx'];
const sources = new Map(names.map(name => {
  const text = fs.readFileSync(path.join(web, 'src', name), 'utf8');
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(ast.parseDiagnostics.length, 0, name + ': TSX syntax');
  return [name, {text, ast}];
}));
const source = name => sources.get(name).text;
const count = (name, text, expected = 1) => assert.equal(source(name).split(text).length - 1, expected, name + ': ' + text);
const visit = (node, predicate) => {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => visit(child, predicate));
};

count('views/Requirement4.tsx', '未能读取升级库存，请点击“重试”。');
for (const text of ['暂未确认是否已发起在库升级，请点击“重试确认”。', '暂未确认升级完成登记是否已保存，请点击“重试确认”。', '本次完成数量须为大于 0 的整数。', '所选来源批次已无剩余升级量或不再可用，请刷新后重新选择。']) count('components/DirectUpgrade.tsx', text);
for (const text of ['当前不能从该来源发起移仓升级，请核对操作权限、待处理移仓记录及剩余可移仓数量。', '无法回撤：', '请选择本次移仓中归属明确、未被占用的入库批次。各批次扣回数量须为正整数，且不超过该批次有效入库量；扣回合计须为 ${decrease}。', '升级中数量与累计升级完成数量的合计，不能超过已发货数量（${currentRow.shippedQuantity}）。', '<dt>升级汇总状态</dt>']) count('components/RelocationUpgrade.tsx', text);
count('components/RelocationUpgrade.tsx', '处理后移仓地址', 2);
count('components/RelocationUpdate.tsx', '<th>更新后处理地址</th>');
for (const text of ['下载已发起，待确认导出状态', '已发起文件下载，导出状态尚未确认。', '首次导出时间（北京时间）']) count('components/RelocationWaybills.tsx', text);
for (const text of ['<th>领星数据获取时间</th>', '最近获取领星数据：{displayTime', '<th>已采纳包裹的数据获取时间</th>']) count('components/RelocationExternalShipments.tsx', text);
for (const text of ['上传转仓升级表格', 'title="转仓升级表格预览"', '将新增 {preview.rows.length} 条转仓升级记录</p>', '确认新增转仓升级记录', '请核对扣回批次和数量：只能选择本单可扣回的入库批次，扣回数量不能超过该批次的有效入库数量。', "'请选择扣回批次，扣回总量需等于指定套数'"]) count('components/TransferUpgrade.tsx', text);

// Test the actual JSX expressions for all three update steps, including unchanged busy states.
const transfer = sources.get('components/TransferUpgrade.tsx').ast;
const reversalDeclaration = visit(transfer, node => ts.isVariableDeclaration(node) && node.name.getText(transfer) === 'reversalError');
assert(reversalDeclaration, 'actual transfer reversal validation');
const reversalCode = ts.transpileModule('globalThis.reversalError = ' + reversalDeclaration.initializer.getText(transfer) + ';', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const reversalMessage = '请核对扣回批次和数量：只能选择本单可扣回的入库批次，扣回数量不能超过该批次的有效入库数量。';
const sumMessage = '请选择扣回批次，扣回总量需等于指定套数';
for (const [name, quantityDelta, selected, receipts, expected] of [
  ['no decrease', 0, [{batchKey: 'receipt', quantity: 1.5}], [], ''],
  ['positive integer', -3, [{batchKey: 'receipt', quantity: 1.5}], [{batchKey: 'receipt', quantity: 12, issue: ''}], '扣回数量须为正整数'],
  ['negative quantity', -3, [{batchKey: 'receipt', quantity: -1}], [{batchKey: 'receipt', quantity: 12, issue: ''}], '扣回数量须为正整数'],
  ['over effective receipt', -3, [{batchKey: 'receipt', quantity: 13}], [{batchKey: 'receipt', quantity: 12, issue: ''}], reversalMessage],
  ['not this document', -3, [{batchKey: 'other', quantity: 3}], [{batchKey: 'receipt', quantity: 12, issue: ''}], reversalMessage],
  ['occupied receipt', -3, [{batchKey: 'receipt', quantity: 3}], [{batchKey: 'receipt', quantity: 12, issue: '此入库批次存在预锁定或后续库存变动，当前不能扣回。'}], reversalMessage],
  ['wrong total', -3, [{batchKey: 'receipt', quantity: 2}], [{batchKey: 'receipt', quantity: 12, issue: ''}], sumMessage],
  ['nothing selected', -3, [], [{batchKey: 'receipt', quantity: 12, issue: ''}], sumMessage],
  ['valid deduction', -3, [{batchKey: 'receipt', quantity: 3}], [{batchKey: 'receipt', quantity: 12, issue: ''}], ''],
]) {
  const context = {reversalsFor: () => selected};
  vm.runInNewContext(reversalCode, context);
  assert.equal(context.reversalError({quantityDelta, data: {documentNo: 'SYNTHETIC-A013'}, receiptBatches: receipts}), expected, name);
}
count('components/TransferUpgrade.tsx', 'disabled={action.disabled||!!b.issue}');
const server = fs.readFileSync(path.join(web, '..', 'server.mjs'), 'utf8');
assert(server.includes("if(!rma || /填写项|^XXX$/i.test(rma))throw new Error('请填写实际RMA，不能留空或使用模板说明。');"), 'A012 changes only the original RMA error string');
assert(server.includes("if(rma===(work.rma??'') && address===(work.originalRelocationAddress??'')){unchangedCount++;continue;}"), 'unchanged RMA/address rows still skip validation and writing');
assert(server.includes("message:'工作表“移仓升级”第 '+sourceRow+' 行：'+error.message"), 'A012 keeps sheet and source-row context');
const uploadLabel = visit(transfer, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(transfer) === 'label' && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === 'htmlFor' && attribute.initializer?.text === 'transfer-update-file'));
assert(uploadLabel, 'transfer update upload label');
const uploadExpression = uploadLabel.children.find(node => ts.isJsxExpression(node) && node.expression).expression.getText(transfer);
const confirmButton = visit(transfer, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(transfer) === 'button' && node.children.some(child => ts.isJsxExpression(child) && child.expression?.getText(transfer).includes('"确认更新 RMA"')));
assert(confirmButton, 'transfer update confirmation button');
const confirmExpression = confirmButton.children.find(node => ts.isJsxExpression(node) && node.expression).expression.getText(transfer);
const api = ts.createSourceFile('api.ts', fs.readFileSync(path.join(web, 'src/api.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const labelsDeclaration = visit(api, node => ts.isVariableDeclaration(node) && node.name.getText(api) === 'transferStageLabels');
assert(labelsDeclaration && ts.isObjectLiteralExpression(labelsDeclaration.initializer));
const transferStageLabels = Object.fromEntries(labelsDeclaration.initializer.properties.map(node => [node.name.getText(api), node.initializer.text]));
for (const [stage, upload, confirm] of [['rma', '上传 RMA 更新表格', '确认更新 RMA'], ['count', '上传实际清点数量更新表格', '确认更新实际清点数量'], ['progress', '上传升级进度更新表格', '确认更新升级进度']]) {
  const context = {stage, transferStageLabels, reading: false, action: {busy: false, uncertain: false}};
  assert.equal(vm.runInNewContext('(' + uploadExpression + ')', context), upload, stage + ': upload');
  assert.equal(vm.runInNewContext('(' + confirmExpression + ')', context), confirm, stage + ': confirmation');
  assert.equal(vm.runInNewContext('(' + uploadExpression + ')', {...context, reading: true}), '正在预览…');
  assert.equal(vm.runInNewContext('(' + confirmExpression + ')', {...context, action: {busy: true, uncertain: false}}), '正在保存…');
  assert.equal(vm.runInNewContext('(' + confirmExpression + ')', {...context, action: {busy: false, uncertain: true}}), '重试确认');
}

// The new optional recovery message is supplied only at the approved callers.
const draftCalls = new Map();
for (const {ast} of sources.values()) {
  const collect = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useSessionDraft') draftCalls.set(node.arguments[1].text, node.arguments);
    ts.forEachChild(node, collect);
  };
  collect(ast);
}
for (const [key, message] of [
  ['transfer-first-preview', '无法恢复上次的转仓升级导入预览，请重新核对文件后上传。'],
  ['transfer-update-preview', '无法恢复未保存转仓更新内容，请确认提交结果并重核上传文件'],
  ['relocation-update-preview', '无法恢复上次的移仓 RMA 与地址更新预览，请重新核对文件后上传。'],
]) {
  const args = draftCalls.get(key);
  assert.equal(args?.length, 4, key + ': optional fourth argument');
  assert.equal(args[3].text, message, key + ': recovery error copy');
}
for (const key of ['direct-completion', 'relocation-completion']) assert.equal(draftCalls.get(key)?.length, 3, key + ': original caller remains unchanged');

// Explicit keep decisions, prior approved entries, data bindings, and error details remain intact.
count('components/DirectUpgrade.tsx', '${request.model} · ${request.sourceVersion}：已锁定 ${formatNumber(result.upgrade.initialQuantity)} 件可用库存。');
for (const text of ['查看发起结果', '查看订单保存结果', '查看升级数量保存结果', '<th>移仓地址</th>', "['原始移仓地址',work.originalRelocationAddress]", "['处理后移仓地址',work.relocationAddress]", "['处理后移仓地址',currentWork.relocationAddress]"]) count('components/RelocationUpgrade.tsx', text);
count('components/RelocationUpdate.tsx', '上传 RMA 与地址更新表格');
count('components/RelocationWaybills.tsx', '<th>移仓订单号</th>');
count('components/RelocationWaybills.tsx', "setDownloadError('运单文件未完成下载，未确认导出状态：'+(error as Error).message)");
count('components/RelocationWaybills.tsx', "message:'已导出 '+confirmation.count+' 个移仓运单。'");
count('components/RelocationWaybills.tsx', '已发起文件下载，导出状态尚未确认。{action.error}');
count('components/RelocationExternalShipments.tsx', 'displayTime(item.snapshot.capturedAt, true)');
count('components/RelocationExternalShipments.tsx', 'displayTime(row.capturedAt, true)');
for (const {text} of sources.values()) assert(!text.includes('与FW-'), 'coordination notes must not appear in UI');
console.log('PASS copy-sheet-sj: seven TSX files parse; 32 SJ decisions and five FW recovery decisions checked; A012 guard/sheet/source row and nine actual A013 validation cases preserved; three stage labels, pending states, kept copy, and original data bindings preserved. No services or databases used.');
