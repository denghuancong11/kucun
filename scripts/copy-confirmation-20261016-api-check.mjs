// Acceptance behavior behind the approved UI copy. Uses its own synthetic schema38 fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareCopyFixture, startCopyServer } from './copy-confirmation-20261016-fixture.mjs';

const info = await prepareCopyFixture('api');
const server = await startCopyServer(info);
const db = new DatabaseSync(info.databasePath, { readOnly: true });
const checks = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
const requestId = () => crypto.randomUUID();
const historySnapshot = () => Object.fromEntries(['inquiry_documents', 'inquiry_events', 'allocation_documents', 'document_events', 'inventory_ledger', 'upgrade_inventory_ledger'].map(table => [table, db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()]));
async function api(route, role = 'admin', payload, expected = 200) {
  const response = await fetch(info.base + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'x-role': role, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  assert.equal(response.headers.get('x-aster-test-instance-id'), info.instanceId);
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}
let failure;
try {
  const f = info.fixture;
  const approvals = await api('/api/approvals');
  assert(approvals.inquiries.some(row => row.id === f.tonerInquiry.id && row.category === '硒鼓'));
  assert(approvals.inquiries.some(row => row.id === f.inkInquiry.id && row.status === 'pending_purchasing'));
  assert(approvals.allocations.some(row => row.id === f.pendingAllocation.id));
  check('审批列表有硒鼓询库、墨盒待采购询库与独立调拨');
  const beforeHistory = historySnapshot();
  const inquiryHistory = await api(`/api/inquiries/${f.tonerInquiry.id}/history`);
  const allocationHistory = await api(`/api/allocations/${f.pendingAllocation.id}/history`);
  assert.equal(inquiryHistory.document.documentNo, f.tonerInquiry.documentNo);
  assert.equal(inquiryHistory.document.originalRequestedQuantity, 30);
  assert(inquiryHistory.events.some(event => event.type === 'entry'));
  assert.equal(allocationHistory.document.documentNo, f.pendingAllocation.documentNo);
  assert.deepEqual(historySnapshot(), beforeHistory);
  await api(`/api/inquiries/${f.tonerInquiry.id}/history`, 'operation-2', undefined, 403);
  check('行内询库详情所用GET及其他调拨详情入口仍只读，跨团拒绝');
  const empty = await api('/api/approvals/inquiries/clear', 'purchasing', { requestId: requestId() });
  assert.equal(empty.hiddenCount, 0);
  check('初始没有终态询库，可触发没有可清空的询库');
  const reply = { supplierQuantity: 0, shippingWarehouse: 'CA', procurementNote: '合成回复0', expectedRevision: f.inkInquiry.revision, requestId: requestId() };
  const beforeInventory = db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all();
  const zero = await api(`/api/inquiries/${f.inkInquiry.id}/reply`, 'purchasing', reply);
  assert.equal(zero.record.status, 'rejected'); assert.equal(zero.record.supplierQuantity, 0);
  assert.deepEqual(db.prepare('SELECT * FROM stock_balances ORDER BY batch_key').all(), beforeInventory);
  const afterReply = historySnapshot();
  assert.equal((await api(`/api/inquiries/${f.inkInquiry.id}/reply`, 'purchasing', reply)).deduped, true);
  assert.deepEqual(historySnapshot(), afterReply);
  assert.equal((await api('/api/approvals/inquiries/clear', 'purchasing', { requestId: requestId() })).hiddenCount, 1);
  assert.equal((await api('/api/approvals/inquiries/clear', 'purchasing', { requestId: requestId() })).hiddenCount, 0);
  check('墨盒询库回复0仍拒绝且不改库存，原提交幂等；清空1条后再次为0');
  const audit = await api('/api/audit?' + new URLSearchParams({ action: 'transit_on_shelf', model: f.toner, limit: '100' }));
  assert.equal(audit.records.length, 2);
  assert.deepEqual(audit.records.map(row => row.onHandDelta).sort((a, b) => a - b), [0, 4000]);
  assert(audit.records.some(row => row.result === '直发FBA已归档，未增加本地在库'));
  assert(audit.records.some(row => row.result === '已转为在库'));
  check('同一在途入库动作保留海外仓入库与FBA归档各自数量影响');
  const waybills = await api('/api/upgrades/relocation-waybills?' + new URLSearchParams({ model: '', version: '', source: '', status: 'all' }), 'logistics');
  assert.equal(waybills.rows.length, 1);
  assert.equal(waybills.rows[0].orderNo, 'COPY-ORDER-20261016-001');
  assert.equal(waybills.rows[0].trackingNo, 'COPY-TRACKING-001'); assert.equal(waybills.rows[0].quantity, 20);
  const template = await fetch(info.base + '/api/upgrades/relocation-update/template', { headers: { 'x-role': 'logistics' } });
  // Binary downloads use their own response headers; server ownership was checked before requests.
  assert.equal(template.status, 200); assert((await template.arrayBuffer()).byteLength > 1000);
  check('物流范围有非空运单及原订单号，RMA地址模板入口可读取');
  await api('/api/transit/imports', 'alan');
  const denied = await fetch(info.base + '/api/transit/preview', { method: 'POST', headers: { 'x-role': 'alan', 'x-file-name': encodeURIComponent('合成-硒鼓.csv') }, body: 'ITEM,数量\nSYNTHETIC,1' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'alan_write_forbidden');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  check('Alan仍可读导入批次且不可导入，外键一致');
} catch (error) { failure = error.stack; throw error; }
finally {
  db.close(); await server.stop();
  await fs.writeFile(path.join(info.out, 'result.json'), JSON.stringify({ base: info.base, manifest: info.manifest, checks, failure, productionReads: 0, productionWrites: 0, browserChecked: false }, null, 2));
}
console.log('COPY_CONFIRMATION_API_PASS ' + checks.length + ' groups; ' + path.join(info.out, 'result.json'));
