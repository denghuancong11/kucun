// All business writes use temporary SQLite databases and an owned random-port server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryDatabase, InventoryDatabase, migrateInventoryDatabaseToCurrent, ROLES} from '../inventory-db.mjs';
import {freePort, createTestInstanceId, waitForOwnedServer} from './test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output/ink-approval-v36/api');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-ink-approval-v36-'));
const databasePath = path.join(state, 'data/aster-inventory.sqlite');
await fs.mkdir(out, {recursive: true});
createInventoryDatabase({databasePath, seedCatalogData: false});
let db = new InventoryDatabase(state), server, failure;
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const checks = [], rejectedRequests = [], quantities = [], downloads = [], migrationEvidence = [];
const downstreamEvidence = [], raceEvidence = [], crossModuleEvidence = [];
const rid = () => crypto.randomUUID(), common = row => ({expectedRevision: row.revision, requestId: rid()});
const check = text => {checks.push(text); console.log('PASS ' + text);};
const snapshot = (connection = db.db) => Object.fromEntries(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, connection.prepare(`SELECT * FROM "${name}"`).all()]));
const inventory = () => JSON.stringify(['stock_batches', 'inventory_ledger', 'upgrade_inventory_ledger'].map(table => db.db.prepare(`SELECT * FROM ${table}`).all()));
async function start() {
  const instanceId = createTestInstanceId('ink-approval-v36');
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_OVERSEAS_WAREHOUSES: 'SyntheticWarehouseA;SyntheticWarehouseB'}});
  await waitForOwnedServer({base, child: server, instanceId});
}
async function stop() {if (server?.exitCode === null) {const ended = once(server, 'exit'); server.kill(); await ended;} server = null;}
async function api(route, role, body, expected = 200) {
  const response = await fetch(base + route, {method: body ? 'POST' : 'GET', headers: {'x-role': role, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json();
  if (expected !== null) assert.equal(response.status, expected, `${role} ${route}: ${JSON.stringify(result)}`);
  return {...result, httpStatus: response.status};
}
async function reject(route, role, body, status, code) {
  const before = snapshot(), result = await api(route, role, body, status);
  if (code) assert.equal(result.code, code, JSON.stringify(result));
  assert.deepEqual(snapshot(), before, `rejection changed database: ${role} ${route}`);
  rejectedRequests.push({route, role, status, code: result.code, allTablesUnchanged: true});
  return result;
}
const route = (kind, row, action) => `/api/${kind}/${row.id}/${action}`;
let batchIndex = 0;
const batches = [];
async function createAllocation(quantity = 100, batch = batches[batchIndex++], model = 'INK-APPROVAL') {
  return (await api('/api/allocations', 'operation-1', {model, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity, department: '一团', store: 'AUS', operator: '隔离墨盒审批', fnsku: '00001-INK', asin: 'BINKAPV036', operatorNote: '原申请备注', requestId: rid()})).record;
}
async function createInquiry(model = 'INK-APPROVAL', quantity = 100) {
  return (await api('/api/inquiries', 'operation-1', {model, quantity, department: '一团', store: 'AUS', operator: '隔离墨盒询库', fnsku: '00002-INK', asin: 'BINKINQ036', operatorNote: '原申请备注', requestId: rid()})).record;
}
async function review(kind, row, quantity = 80, decision = 'approve') {
  return (await api(route(kind, row, 'review'), 'business', {...common(row), decision, approvedQuantity: quantity, businessNote: '商务' + quantity})).record;
}
async function ready(kind, batch) {return review(kind, kind === 'allocations' ? await createAllocation(100, batch) : await createInquiry());}
const alanBody = (row, quantity = 70) => ({...common(row), alanQuantity: quantity, alanNote: 'Alan独立备注\n第二行'});
async function alan(kind, row, quantity = 70) {return (await api(route(kind, row, 'alan-review'), 'alan', alanBody(row, quantity))).record;}
const replyBody = (kind, row, quantity = 60) => ({...common(row), supplierQuantity: quantity, procurementNote: '采购最终备注', ...(kind === 'inquiries' ? {shippingWarehouse: 'CA'} : {})});
async function reply(kind, row, quantity = 60, actor = 'purchasing') {return (await api(route(kind, row, 'reply'), actor, replyBody(kind, row, quantity))).record;}
const archiveBody = (kind, row) => ({...common(row), ...(kind === 'inquiries' ? {plan: 'INK-FINAL-' + row.id, date: '2026-10-14', version: 'V1'} : {})});
async function archive(kind, row, actor = 'purchasing') {return (await api(route(kind, row, 'archive'), actor, archiveBody(kind, row))).record;}
async function recall(kind, row, actor = 'purchasing') {return (await api(route(kind, row, 'recall'), actor, common(row))).record;}
async function complete(kind, {alanQuantity = 70, supplierQuantity = 60, actor = 'purchasing', batch} = {}) {
  let row = await ready(kind, batch); if (alanQuantity !== null) row = await alan(kind, row, alanQuantity);
  return archive(kind, await reply(kind, row, supplierQuantity, actor), actor);
}
const current = (kind, row) => kind === 'allocations' ? db.getDocument(row.id) : db.getInquiry(row.id);
function assertStage(kind, row, stage, text) {assert.equal(kind === 'allocations' ? row.procurementStatus : row.status, stage); assert.equal(row.statusText, text);}
function assertFinal(row, quantity, alanQuantity) {for (const field of ['quantity', 'requestedQuantity', 'approvedQuantity', 'supplierQuantity']) assert.equal(row[field], quantity, field); assert.equal(row.alanQuantity, alanQuantity);}
function assertLock(row, locked, issued = 0) {const found = db.getDocument(row.id); assert.equal(found.lockedQuantity, locked); assert.equal(found.issuedQuantity, issued); quantities.push({id: row.id, stage: found.statusText, locked, issued, batch: db.getBalance(found.batchKey)});}
function source(kind, row) {return db.getRelocationCandidates().find(item => item[kind === 'allocations' ? 'allocationId' : 'inquiryId'] === row.id);}
async function crossCheckAllocation(row, eventType, actor, onHandDelta, lockedDelta) {
  const approvals = await api('/api/approvals', 'purchasing');
  const visible = approvals.allocations.find(item => item.id === row.id);
  assert.equal(visible.revision, row.revision); assert.equal(visible.statusText, row.statusText);
  const catalog = await api('/api/inventory/catalog', 'admin');
  const batch = catalog.stockDetails[row.model].find(item => item.batchKey === row.batchKey);
  const balance = db.getBalance(row.batchKey);
  assert.equal(batch.quantity, balance.onHand); assert.equal(batch.locked, balance.locked); assert.equal(batch.available, balance.available);
  const events = (await api('/api/audit?' + new URLSearchParams({model: row.model, action: eventType, limit: '500'}), 'admin')).records;
  const event = events.find(item => item.documentId === row.id);
  assert(event); assert.equal(event.role, actor); assert.equal(event.onHandDelta, onHandDelta); assert.equal(event.lockedDelta, lockedDelta);
  const detail = await api('/api/audit/' + event.eventId, 'admin'); assert.equal(detail.record.role, actor); assert.equal(detail.record.at, event.at);
  crossModuleEvidence.push({id: row.id, revision: row.revision, stage: row.statusText, actor, eventType, eventId: event.eventId, eventAt: event.at, onHandDelta, lockedDelta, balance, inventoryApi: true, approvalsApi: true, auditApi: true});
}

try {
  await start();
  const csv = 'ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n' + Array.from({length: 64}, (_, index) => `INK-APPROVAL,300,10,STOCK-${index},SyntheticWarehouseA,INK-P${index},2026-10-14,一团,V1`).join('\n');
  const fileName = '隔离审批墨盒.csv';
  const previewResponse = await fetch(base + '/api/transit/preview', {method: 'POST', headers: {'x-role': 'admin', 'x-file-name': encodeURIComponent(fileName)}, body: csv});
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
  const imported = await api('/api/transit/import', 'admin', {previewToken: preview.previewToken, fileName, fileHash: preview.fileSha256, templateHash: preview.templateSha256, rows: preview.rows, requestId: rid()});
  for (const row of imported.rows) await api(`/api/transit/${row.id}/on-shelf`, 'assistant-1', {...common(row), yes: 'YES'});
  batches.push(...(await api('/api/inventory/catalog', 'admin')).stockDetails['INK-APPROVAL']);
  db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)').run('TONER-APPROVAL', '硒鼓', new Date().toISOString());
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 36);
  check('schema36隔离服务及64个独立墨盒来源批次就绪，未使用正式数据');

  let allocation = await createAllocation(); assertLock(allocation, 100);
  await crossCheckAllocation(allocation, 'entry', 'operation-1', 0, 100);
  allocation = await review('allocations', allocation); assertLock(allocation, 80); assertStage('allocations', allocation, 'pending_alan', '待Alan审核');
  await crossCheckAllocation(allocation, 'review', 'business', 0, -20);
  const approvedHistory = allocation.events;
  allocation = await alan('allocations', allocation); assertLock(allocation, 70); assertStage('allocations', allocation, 'pending_purchasing', '待采购回复');
  await crossCheckAllocation(allocation, 'alan_review', 'alan', 0, -10);
  assert.equal(allocation.alanReviewedByRole, 'alan'); assert(allocation.alanReviewedAt); assert.equal(allocation.alanNote, 'Alan独立备注\n第二行');
  const alanHistory = allocation.events;
  allocation = await reply('allocations', allocation); assertLock(allocation, 60); assertFinal(allocation, 60, 70); assertStage('allocations', allocation, 'pending_archive', '待采购归档');
  await crossCheckAllocation(allocation, 'reply', 'purchasing', 0, -10);
  assert.deepEqual(allocation.events.slice(0, approvedHistory.length), approvedHistory); assert.deepEqual(allocation.events.slice(0, alanHistory.length), alanHistory);
  const original = {batchKey: allocation.batchKey, plan: allocation.plan, date: allocation.date, version: allocation.version};
  const beforeArchive = db.getBalance(allocation.batchKey);
  allocation = await archive('allocations', allocation); assertLock(allocation, 0, 60); assert.equal(allocation.statusCode, 'confirmed'); assert.equal(allocation.statusText, '已完成');
  await crossCheckAllocation(allocation, 'archive', 'purchasing', -60, -60);
  assert.equal(db.getBalance(allocation.batchKey).onHand, beforeArchive.onHand - 60);
  for (const [key, value] of Object.entries(original)) assert.equal(allocation[key], value);
  assert.equal(source('allocations', allocation).initialQuantity, 60);
  const completedHistory = allocation.events;
  allocation = await recall('allocations', allocation); assertLock(allocation, 70, 0); assertStage('allocations', allocation, 'pending_purchasing', '待采购回复');
  await crossCheckAllocation(allocation, 'recall', 'purchasing', 60, 70);
  assert.equal(db.getBalance(allocation.batchKey).onHand, beforeArchive.onHand); assert.equal(allocation.requestedQuantity, 100); assert.equal(allocation.approvedQuantity, 80); assert.equal(allocation.supplierQuantity, null); assert.equal(allocation.alanQuantity, 70);
  assert.equal(allocation.alanReviewedByRole, 'alan'); assert.equal(allocation.businessNote, '商务80'); assert.deepEqual(allocation.events.slice(0, completedHistory.length), completedHistory);
  assert.equal(source('allocations', allocation), undefined); for (const [key, value] of Object.entries(original)) assert.equal(allocation[key], value);
  check('调拨100→80→70→60预锁，归档仅扣60；采购回撤退60锁70、历史和来源批次资料完整');

  allocation = await archive('allocations', await reply('allocations', allocation, 50, 'logistics'), 'logistics');
  allocation = await recall('allocations', allocation, 'business'); assertLock(allocation, 100, 0);
  assert.equal(allocation.approvalStatus, 'pending'); assert.equal(allocation.statusText, '待商务审核'); assert.equal(allocation.requestedQuantity, 100);
  for (const key of ['approvedQuantity', 'alanQuantity', 'alanReviewedByRole', 'alanReviewedAt', 'supplierQuantity', 'repliedByRole', 'archivedByRole']) assert.equal(allocation[key], null, key);
  for (const key of ['businessNote', 'alanNote', 'procurementNote', 'shippingWarehouse']) assert(!allocation[key], key);
  allocation = await review('allocations', allocation, 90); allocation = await alan('allocations', allocation, 80);
  allocation = await archive('allocations', await reply('allocations', allocation, 50)); allocation = await recall('allocations', allocation);
  assert.equal(allocation.approvedQuantity, 90); assert.equal(allocation.businessNote, '商务90'); assert.equal(allocation.alanQuantity, 80); assertLock(allocation, 80);
  check('商务回撤重置当前审核链并锁回原申请100；第二轮采购回撤可靠恢复最新商务90/Alan80而非最终50');

  const inquiryInventory = inventory();
  let inquiry = await ready('inquiries'); assertStage('inquiries', inquiry, 'pending_alan', '待Alan审核');
  inquiry = await alan('inquiries', inquiry, 70); assertStage('inquiries', inquiry, 'pending_purchasing', '待采购回复');
  inquiry = await reply('inquiries', inquiry, 600); assertFinal(inquiry, 600, 70); assertStage('inquiries', inquiry, 'pending_assistant', '待采购归档');
  inquiry = await archive('inquiries', inquiry); assert.equal(inquiry.status, 'archived'); assert.equal(source('inquiries', inquiry).initialQuantity, 600);
  inquiry = await recall('inquiries', inquiry, 'logistics'); assertStage('inquiries', inquiry, 'pending_purchasing', '待采购回复');
  assert.equal(inquiry.requestedQuantity, 100); assert.equal(inquiry.approvedQuantity, 80); assert.equal(inquiry.alanQuantity, 70); assert.equal(inquiry.alanReviewedByRole, 'alan');
  for (const key of ['shippingWarehouse', 'procurementNote', 'plan', 'date', 'version']) assert.equal(inquiry[key], '', key);
  assert.equal(inquiry.supplierQuantity, null); assert.equal(source('inquiries', inquiry), undefined);
  inquiry = await archive('inquiries', await reply('inquiries', inquiry, 65)); inquiry = await recall('inquiries', inquiry, 'business');
  assertStage('inquiries', inquiry, 'pending_business', '待商务审核'); assert.equal(inquiry.requestedQuantity, 100);
  for (const key of ['approvedQuantity', 'alanQuantity', 'alanReviewedAt', 'supplierQuantity']) assert.equal(inquiry[key], null, key);
  assert.equal(inventory(), inquiryInventory);
  check('询库数量无套箱和商务/Alan上限，最终600可归档；采购/物流及商务回撤正确恢复，完全不锁扣在库库存');

  for (const kind of ['allocations', 'inquiries']) for (const actor of ['purchasing', 'logistics']) for (const alanQuantity of [null, 0]) {
    let row = await ready(kind); if (alanQuantity === 0) {row = await alan(kind, row, 0); if (kind === 'allocations') assertLock(row, 0);}
    assert.equal(row.alanQuantity, alanQuantity); if (alanQuantity === null) {assert.equal(row.alanNote, null); assert.equal(row.alanReviewedByRole, null);}
    row = await reply(kind, row, 60, actor); assertFinal(row, 60, alanQuantity); assert.equal(row.repliedByRole, actor);
    const replyEvent = row.events.findLast(event => event.type === 'reply'); assert.equal(replyEvent.role, actor); assert.equal(Boolean(replyEvent.payload.skippedAlan), alanQuantity === null);
    row = await archive(kind, row, actor); assert.equal(row.archivedByRole, actor);
    row = await recall(kind, row, actor); assert.equal(row.alanQuantity, alanQuantity); assert.equal(row.requestedQuantity, 100); assert.equal(row.approvedQuantity, 80);
    if (kind === 'allocations') assertLock(row, alanQuantity === null ? 80 : 0);
    assert.equal(row.alanReviewedByRole, alanQuantity === null ? null : 'alan');
  }
  check('两种业务采购及物流均可即时接管；跳过事实与Alan0分别保留，回撤按商务80或Alan0恢复锁定');

  for (const kind of ['allocations', 'inquiries']) for (const actor of ['purchasing', 'logistics']) {
    let row = await alan(kind, await ready(kind), 0); row = await reply(kind, row, 0, actor); assertFinal(row, 0, 0); assert.equal(row.statusText, '已拒绝');
    if (kind === 'allocations') assertLock(row, 0, 0); else assert.equal(row.shippingWarehouse, 'CA');
    assert.equal(source(kind, row), undefined); await reject(route(kind, row, 'archive'), actor, archiveBody(kind, row), 409); await reject(route(kind, row, 'recall'), actor, common(row), 409);
  }
  check('两类最终回复0均释放锁定/直接拒绝，无升级来源，禁止归档或回撤');

  for (const kind of ['allocations', 'inquiries']) {
    const row = await ready(kind);
    for (const invalid of ['', '   ', null, -1, 1.5]) {
      await reject(route(kind, row, 'alan-review'), 'alan', {...alanBody(row), alanQuantity: invalid}, 400);
      await reject(route(kind, row, 'reply'), 'purchasing', {...replyBody(kind, row), supplierQuantity: invalid}, 400);
    }
    if (kind === 'allocations') {
      await reject(route(kind, row, 'alan-review'), 'alan', alanBody(row, 75), 400, 'allocation_quantity_multiple');
      await reject(route(kind, row, 'reply'), 'purchasing', replyBody(kind, row, 65), 400, 'allocation_quantity_multiple');
      await reject(route(kind, row, 'alan-review'), 'alan', alanBody(row, 310), 409, 'insufficient_available');
      await reject(route(kind, row, 'reply'), 'purchasing', replyBody(kind, row, 310), 409, 'insufficient_available');
      const increased = await alan(kind, row, 200); assertLock(increased, 200); const decreased = await reply(kind, increased, 40); assertLock(decreased, 40); assert.equal(decreased.quantity, 40);
      const bad = await ready(kind); db.db.prepare('UPDATE stock_batches SET pack_per_box=NULL WHERE batch_key=?').run(bad.batchKey);
      await reject(route(kind, bad, 'alan-review'), 'alan', alanBody(bad, 70), 400, 'invalid_pack_per_box');
      await reject(route(kind, bad, 'reply'), 'purchasing', replyBody(kind, bad, 60), 400, 'invalid_pack_per_box');
      const zero = await alan(kind, bad, 0); assertLock(zero, 0); await reply(kind, zero, 0);
      db.db.prepare("UPDATE stock_batches SET pack_per_box='10' WHERE batch_key=?").run(bad.batchKey);
    } else {
      for (const quantity of [0, 60]) for (const shippingWarehouse of ['', 'OTHER']) await reject(route(kind, row, 'reply'), 'purchasing', {...replyBody(kind, row, quantity), shippingWarehouse}, 400);
      const any = await alan(kind, row, 73); const final = await reply(kind, any, 137); assert.equal(final.supplierQuantity, 137);
    }
  }
  check('数量必填非负整数；调拨正数按有效套箱并足量整笔调整，0释放不需包装；询库73/137允许且0也必须CA/SC');

  for (const kind of ['allocations', 'inquiries']) {
    const row = await ready(kind);
    for (const role of ROLES.filter(role => role !== 'alan')) await reject(route(kind, row, 'alan-review'), role, alanBody(row), 403);
    for (const action of ['reply', 'archive', 'recall']) await reject(route(kind, row, action), 'alan', action === 'reply' ? replyBody(kind, row) : action === 'archive' ? archiveBody(kind, row) : common(row), 403, 'alan_write_forbidden');
    for (const role of ['admin', 'business', 'operation-1', 'operation-2', 'assistant-1', 'assistant-2']) await reject(route(kind, row, 'reply'), role, replyBody(kind, row), 403);
    const replied = await reply(kind, row); await reject(route(kind, replied, 'alan-review'), 'alan', alanBody(replied), 409);
    await reject(route(kind, row, 'alan-review'), 'alan', alanBody(row), 409, 'stale_revision');
    if (kind === 'allocations') await reject(route(kind, replied, 'confirm'), 'assistant-1', common(replied), 403, 'confirm_forbidden');
    for (const role of ['admin', 'business', 'assistant-1', 'assistant-2']) await reject(route(kind, replied, 'archive'), role, archiveBody(kind, replied), 403);
  }
  const toner = await review('inquiries', await createInquiry('TONER-APPROVAL'));
  assert.equal(toner.status, 'pending_purchasing'); await reject(route('inquiries', toner, 'alan-review'), 'alan', alanBody(toner), 409, 'invalid_inquiry_status');
  await reject(route('inquiries', toner, 'reply'), 'alan', replyBody('inquiries', toner), 403, 'alan_write_forbidden');
  const tonerZero = await reply('inquiries', toner, 0); assert.equal(tonerZero.status, 'pending_assistant');
  await reject(route('inquiries', tonerZero, 'archive'), 'purchasing', archiveBody('inquiries', tonerZero), 403);
  const tonerDone = await archive('inquiries', tonerZero, 'assistant-1'); assert.equal(tonerDone.status, 'archived');
  await reject(route('inquiries', tonerDone, 'recall'), 'business', common(tonerDone), 409);
  check('Alan仅墨盒独立审核可写，旧最终回复接口403；后续阶段与旧版本不得覆写，助理不得完成新墨盒链，硒鼓0回复仍由助理归档');

  for (const kind of ['allocations', 'inquiries']) {
    const row = await ready(kind), pa = alanBody(row), pp = replyBody(kind, row, 60);
    const racing = await Promise.all([api(route(kind, row, 'alan-review'), 'alan', pa, null), api(route(kind, row, 'reply'), 'purchasing', pp, null)]);
    assert.deepEqual(racing.map(result => result.httpStatus).sort(), [200, 409]);
    const winner = racing[0].httpStatus === 200 ? {action: 'alan-review', actor: 'alan', body: pa} : {action: 'reply', actor: 'purchasing', body: pp};
    const after = snapshot(); assert.equal((await api(route(kind, row, winner.action), winner.actor, winner.body)).deduped, true); assert.deepEqual(snapshot(), after);
    let live = current(kind, row); if (live.supplierQuantity === null) live = await reply(kind, live);
    const archiveRequest = archiveBody(kind, live), archivedPair = await Promise.all([api(route(kind, live, 'archive'), 'purchasing', archiveRequest), api(route(kind, live, 'archive'), 'purchasing', archiveRequest)]);
    assert.equal(archivedPair.filter(result => result.deduped).length, 1); live = current(kind, row);
    const recallRequest = common(live), recalledPair = await Promise.all([api(route(kind, live, 'recall'), 'purchasing', recallRequest), api(route(kind, live, 'recall'), 'purchasing', recallRequest)]);
    assert.equal(recalledPair.filter(result => result.deduped).length, 1);
    const recalled = snapshot(); assert.equal((await api(route(kind, live, 'archive'), 'purchasing', archiveRequest)).deduped, true); assert.equal((await api(route(kind, row, winner.action), winner.actor, winner.body)).deduped, true); assert.deepEqual(snapshot(), recalled);
  }
  check('两类Alan/采购同版本竞态仅一方成功；重复归档、回撤及旧丢回执重试不重复扣库/退库或覆盖新阶段');

  const insufficientBatch = batches[batchIndex++];
  let insufficient = await complete('allocations', {batch: insufficientBatch});
  const contender = await createAllocation(240, insufficientBatch); assert.equal(db.getBalance(insufficientBatch.batchKey).available, 0);
  await reject(route('allocations', insufficient, 'recall'), 'purchasing', common(insufficient), 409, 'insufficient_available');
  await reject(route('allocations', insufficient, 'recall'), 'business', common(insufficient), 409, 'insufficient_available');
  assertLock(insufficient, 0, 60); await review('allocations', contender, 240, 'reject');
  insufficient = await recall('allocations', insufficient); assertLock(insufficient, 70, 0);
  check('回撤退60后仍不够重锁70/100时全部数据库无写入；释放他单占用后一次完成退库与重锁');

  for (const kind of ['allocations', 'inquiries']) for (const status of ['awaiting_procurement', 'cancelled', 'withdrawn']) {
    const row = await complete(kind), sourceField = kind === 'allocations' ? 'allocationId' : 'inquiryId';
    const work = (await api('/api/upgrades/relocation-work-items', 'purchasing', {[sourceField]: row.id, sourceRevision: row.revision, requestId: rid()})).workItem;
    db.db.prepare('UPDATE upgrade_relocation_work_items SET status=? WHERE id=?').run(status, work.id);
    for (const role of ['purchasing', 'logistics', 'business']) {
      const error = await reject(route(kind, row, 'recall'), role, common(row), 409);
      assert(error.details.blockers.some(blocker => blocker.number === work.workNo)); assert(error.error.includes(row.model)); assert(!error.error.includes(work.workNo));
    }
    assert(source(kind, row)[kind === 'allocations' ? 'allocationRecall' : 'inquiryRecall'].blockers.length);
  }
  check('待办由API创建；取消/撤回仅历史状态兼容夹具，三角色回撤均阻止（当前已无取消/撤回办理API，不计实际闭环）');

  for (const kind of ['allocations', 'inquiries']) for (const recallFirst of [false, true]) for (let attempt = 0; attempt < 3; attempt++) {
    const row = await complete(kind), sourceField = kind === 'allocations' ? 'allocationId' : 'inquiryId';
    const start = () => api('/api/upgrades/relocation-work-items', 'operation-1', {[sourceField]: row.id, sourceRevision: row.revision, requestId: rid()}, null);
    const undo = () => api(route(kind, row, 'recall'), 'purchasing', common(row), null);
    const results = await Promise.all(recallFirst ? [undo(), start()] : [start(), undo()]);
    const [recalled, initiated] = recallFirst ? results : results.reverse();
    assert.equal(results.filter(result => result.httpStatus === 200).length, 1);
    assert.equal(results.filter(result => result.httpStatus === 409).length, 1);
    const work = db.db.prepare(`SELECT * FROM upgrade_relocation_work_items WHERE ${kind === 'allocations' ? 'allocation_document_id' : 'inquiry_id'}=?`).all(row.id);
    assert.equal(work.length, initiated.httpStatus === 200 ? 1 : 0);
    if (recalled.httpStatus === 200) {assert.equal(source(kind, row), undefined); if (kind === 'allocations') assertLock(row, 70, 0);}
    else {assert.equal(current(kind, row).revision, row.revision); assert.equal(source(kind, row).initialQuantity, 60); if (kind === 'allocations') assertLock(row, 0, 60);}
    raceEvidence.push({kind, recallFirst, attempt, id: row.id, recallStatus: recalled.httpStatus, initiateStatus: initiated.httpStatus, workCount: work.length, oneWinner: true});
  }
  check('12组实际HTTP移仓发起/来源回撤竞争，每次仅一个成功：退库后无移仓关联，已发起时来源未退库');

  // The execution endpoint receives synthetic capture data; no real Lingxing browser/account is used.
  const origin = 'chrome-extension://' + 'a'.repeat(32); let workerId;
  async function worker(action, body = {}) {
    const response = await fetch(base + '/api/lingxing-worker/' + action, {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({workerId, ...body})});
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  workerId = (await worker('connect', {version: 'isolated-approval-downstream'})).workerId;
  for (const kind of ['allocations', 'inquiries']) {
    const row = await complete(kind), sourceField = kind === 'allocations' ? 'allocationId' : 'inquiryId';
    let work = (await api('/api/upgrades/relocation-work-items', 'operation-1', {[sourceField]: row.id, sourceRevision: row.revision, requestId: rid()})).workItem;
    work = (await api(`/api/upgrades/relocation-work-items/${work.id}/procurement`, 'logistics', {...common(work), rma: 'R616738', relocationAddress: 'RMA#R616738\nMirella RW\n12000 Magnolia Ave, Suite#101\nRiverside , CA 92503 US\nTEL:562-404-9315'})).workItem;
    const ordered = await api(`/api/upgrades/relocation-work-items/${work.id}/operation`, 'operation-1', {...common(work), removalOrderNo: 'INK-CHAIN-' + kind + '-' + work.id}); work = ordered.workItem;
    const job = (await worker('claim')).job; assert.equal(job.id, ordered.automaticSync.id);
    const capture = {shipments: [{externalId: 'INK-CHAIN-PACKAGE-' + work.id, storeId: 'synthetic', storeName: 'A-US 美国', countryCode: 'US', orderNo: work.removalOrderNo, fnsku: work.fnsku, quantity: 60, carrier: 'UPS', trackingNo: 'INK-CHAIN-TRACK-' + work.id, shipDate: '2026-10-14'}], capturedAt: new Date().toISOString()};
    assert.equal((await worker('finish', {id: job.id, capture})).job.state, 'succeeded');
    const captured = snapshot(); assert.equal((await worker('finish', {id: job.id, capture})).deduped, true); assert.deepEqual(snapshot(), captured);
    work = db.getRelocationWorkItem(work.id); const relocation = db.getUpgrade(work.upgradeId).relocations[0];
    const version = 'CHAIN-' + kind;
    await api(`/api/upgrades/relocations/${relocation.id}/complete`, 'logistics', {...common(relocation), completedQuantity: 60, inProgressQuantity: 0, newVersion: version, targetWarehouse: 'SyntheticWarehouseA'});
    const upgraded = (await api('/api/upgrades/direct', 'purchasing', {model: row.model, sourceVersion: version, requestId: rid()})).upgrade;
    assert.equal(upgraded.initialQuantity, 60);
    const blockers = kind === 'allocations' ? db.allocationDownstream(row.id) : db.inquiryDownstream(row.id);
    assert(blockers.some(blocker => blocker.type === '升级' && blocker.number === upgraded.upgradeNo), JSON.stringify({upgraded, blockers}));
    for (const actor of ['business', 'purchasing', 'logistics']) {
      const rejected = await reject(route(kind, row, 'recall'), actor, common(row), 409);
      assert(rejected.details.blockers.some(blocker => blocker.type === '升级' && blocker.number === upgraded.upgradeNo));
    }
    downstreamEvidence.push({kind, sourceId: row.id, workId: work.id, captureJobId: job.id, captureMode: 'synthetic worker protocol', relocationId: relocation.id, indirectUpgradeId: upgraded.id, allStagesViaHttp: true, recallBlockedWithAllTablesUnchanged: true});
  }
  await worker('disconnect');
  check('两类来源API移仓→RMA地址→订单→模拟执行端包裹采纳→实际HTTP入库→在库升级，递归关联阻止三角色回撤；采集回执重试不重复入账');

  const exportRows = [await ready('inquiries'), await alan('inquiries', await ready('inquiries'), 0), await reply('inquiries', await alan('inquiries', await ready('inquiries'), 70), 60)];
  const headers = ['型号', '商务部审核数量', 'Alan审核数量', 'Alan备注', '供应商库存回复', '发货仓库', '采购备注', '调拨部门', '调拨店铺', '调拨运营', '已贴FNSKU', '提交时间', '状况'];
  for (const [label, filters] of [['all', {category: '墨盒', type: 'inquiry', scope: 'all', progress: 'all'}], ['empty', {type: 'inquiry', search: 'NO-MATCH-INK-APPROVAL'}]]) {
    const before = snapshot(), response = await fetch(base + '/api/approvals/inquiries/export?' + new URLSearchParams(filters), {headers: {'x-role': 'purchasing'}}); assert.equal(response.status, 200);
    const file = path.join(out, `inquiry-${label}.xlsx`); await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    const read = JSON.parse(execFileSync(process.env.ASTER_TEST_PYTHON || 'python', [path.join(root, 'scripts/fixtures/read-inquiry-export.py'), file], {encoding: 'utf8', windowsHide: true}));
    assert.deepEqual(read.rows[0], headers); assert.equal(read.maxColumn, 13); if (label === 'empty') assert.equal(read.maxRow, 1);
    else {assert(read.rows.some(row => row[2] === null && row[3] === null)); assert(read.rows.some(row => row[2] === 0 && row[3] === 'Alan独立备注\n第二行')); assert(read.rows.some(row => row[1] === 60 && row[2] === 70 && row[4] === 60)); assert(read.rows.some(row => row[10] === '00002-INK'));}
    assert.deepEqual(snapshot(), before); downloads.push({file, columns: read.maxColumn, rows: read.maxRow - 1, reader: 'openpyxl', databaseUnchanged: true});
  }
  for (const role of ROLES.filter(role => !['admin', 'purchasing', 'logistics'].includes(role))) assert.equal((await fetch(base + '/api/approvals/inquiries/export', {headers: {'x-role': role}})).status, 403);
  assert.equal(exportRows.length, 3);
  check('询库实际xlsx含13列正确顺序，Alan空值与0独立、原FNSKU前导0完整、无匹配仍13表头，导出只读及权限不变');

  const pending = await alan('inquiries', await ready('inquiries'), 0);
  db.db.prepare('UPDATE inquiry_documents SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', pending.id);
  await api('/api/approvals/inquiries/clear', 'purchasing', {requestId: rid()});
  assert((await api('/api/approvals', 'purchasing')).inquiries.some(row => row.id === pending.id));
  const beforeRestart = snapshot(); await stop(); db.close(); db = new InventoryDatabase(state); await start(); assert.deepEqual(snapshot(), beforeRestart);
  db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  check('Alan0待采购跨清理仍可见，重启不改变流程/数量/历史，库存恒等式与外键通过');

  await stop();
  // Load the actual pre-change implementation to create genuine v35 histories, not new-schema imitations.
  const legacyModuleRoot = path.join(out, 'schema35-baseline'); await fs.mkdir(legacyModuleRoot, {recursive: true});
  for (const file of ['inventory-db.mjs', 'relocation-address.mjs']) await fs.writeFile(path.join(legacyModuleRoot, file), execFileSync('git', ['show', `df83fa9:${file}`], {cwd: root}));
  const legacy = await import(pathToFileURL(path.join(legacyModuleRoot, 'inventory-db.mjs')));
  const legacyState = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-ink-v35-migration-')), legacyPath = path.join(legacyState, 'data/aster-inventory.sqlite');
  legacy.createInventoryDatabase({databasePath: legacyPath}); const old = new legacy.InventoryDatabase(legacyState);
  const oldBatch = old.db.prepare("SELECT * FROM stock_batches WHERE model='SYNTH-INK-001' LIMIT 1").get(); old.db.prepare("UPDATE stock_batches SET pack_per_box='10',base_quantity=1000,source_team='一团' WHERE batch_key=?").run(oldBatch.batch_key);
  const oldCreate = quantity => old.createAllocation({role: 'admin', model: oldBatch.model, sourceBatchKey: oldBatch.batch_key, plan: oldBatch.plan, date: oldBatch.ship_date, version: oldBatch.version, quantity, department: '一团', store: 'AUS', operator: 'v35真实旧流程', fnsku: '000OLD', asin: 'BOLDINK036', requestId: rid()}).record;
  const oldReview = row => old.reviewAllocation({id: row.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '迁移商务事实', ...common(row)}).record;
  const oldPending = oldReview(oldCreate(100)), oldBusiness = oldCreate(100), oldDone = old.confirmAllocation({id: oldReview(oldCreate(100)).id, role: 'assistant-1', expectedRevision: 2, requestId: rid()}).record;
  const oldRejectedBase = oldCreate(100), oldRejected = old.reviewAllocation({id: oldRejectedBase.id, role: 'business', decision: 'reject', businessNote: '旧拒绝', ...common(oldRejectedBase)}).record;
  const oldInquiry = () => {const row = old.createInquiry({role: 'operation-1', model: 'SYNTH-INK-001', quantity: 100, department: '一团', store: 'AUS', operator: '旧询库', fnsku: '000OLDINQ', asin: 'BOLDINQ036', requestId: rid()}).record; return old.reviewInquiry({id: row.id, role: 'business', decision: 'approve', approvedQuantity: 80, businessNote: '旧商务80', ...common(row)}).record;};
  const oldInquiryPending = oldInquiry(), oldInquiryReplyBase = oldInquiry(), oldInquiryReply = old.replyInquiry({id: oldInquiryReplyBase.id, role: 'alan', supplierQuantity: 60, shippingWarehouse: 'CA', procurementNote: '旧Alan最终回复事实', ...common(oldInquiryReplyBase)}).record;
  const beforeMigration = snapshot(old.db), beforeLock = old.getBalance(oldBatch.batch_key), oldPendingEvents = old.history(oldPending.id).events; assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 35); old.close();
  const migration = migrateInventoryDatabaseToCurrent({databasePath: legacyPath}); assert.equal(migration.fromVersion, 35); assert.equal(migration.toVersion, 36);
  const migrated = new InventoryDatabase(legacyState), pendingMigrated = migrated.getDocument(oldPending.id);
  assertStage('allocations', pendingMigrated, 'pending_alan', '待Alan审核'); assert.equal(pendingMigrated.alanQuantity, null); assert.equal(pendingMigrated.supplierQuantity, null); assert.equal(pendingMigrated.approvedQuantity, 80); assert.equal(pendingMigrated.businessNote, '迁移商务事实');
  assert.deepEqual(pendingMigrated.events, oldPendingEvents); assert.deepEqual(migrated.db.prepare('SELECT * FROM inventory_ledger').all(), beforeMigration.inventory_ledger); assert.deepEqual(migrated.getBalance(oldBatch.batch_key), beforeLock);
  assert.equal(migrated.getDocument(oldBusiness.id).statusText, '待商务审核'); assert.equal(migrated.getDocument(oldDone.id).statusCode, 'confirmed'); assert.equal(migrated.getDocument(oldRejected.id).approvalStatus, 'rejected');
  for (const row of [pendingMigrated, migrated.getDocument(oldBusiness.id), migrated.getDocument(oldDone.id), migrated.getDocument(oldRejected.id)]) {assert.equal(row.alanQuantity, null); assert.equal(row.supplierQuantity, null);}
  const migratedInquiryPending = migrated.getInquiry(oldInquiryPending.id), migratedInquiryReply = migrated.getInquiry(oldInquiryReply.id);
  assertStage('inquiries', migratedInquiryPending, 'pending_alan', '待Alan审核'); assert.equal(migratedInquiryPending.alanQuantity, null); assert.equal(migratedInquiryReply.status, 'pending_assistant'); assert.equal(migratedInquiryReply.supplierQuantity, 60); assert.equal(migratedInquiryReply.repliedByRole, 'alan'); assert.equal(migratedInquiryReply.alanQuantity, null); assert.deepEqual(migratedInquiryReply.events, oldInquiryReply.events);
  const migratedSnapshot = snapshot(migrated.db); assert.equal(migrateInventoryDatabaseToCurrent({databasePath: legacyPath}).changed, false); assert.deepEqual(snapshot(migrated.db), migratedSnapshot);
  migrated.assertInventoryInvariants(); assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []); migrationEvidence.push({legacyState, migration, allocationId: oldPending.id, priorLock: beforeLock, afterLock: migrated.getBalance(oldBatch.batch_key), oldInquiryPendingId: oldInquiryPending.id, oldAlanReplyId: oldInquiryReply.id, ledgerUnchanged: true, repeatMigrationUnchanged: true}); migrated.close();
  check('真实df83fa9 schema35迁移：待助理墨盒调拨转Alan但不重复预锁/改历史；旧询库未回复转Alan、旧已回复保留，终态不重办、新字段空，重复迁移无变');
} catch (error) {failure = error.stack; throw error;}
finally {
  await stop(); db?.close();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({version: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), schemaVersion: 36, state, base, checks, rejectedRequests, quantities, downloads, migrationEvidence, downstreamEvidence, raceEvidence, crossModuleEvidence, failure: failure ?? null, productionWrites: 0, realLingxingRequests: 0}, null, 2));
}
console.log(`INK_APPROVAL_V36_PASS ${checks.length} groups; ${rejectedRequests.length} rejected requests unchanged`);
