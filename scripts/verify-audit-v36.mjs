// Reuse only an explicitly supplied synthetic ink-approval fixture; all new writes use its temporary backup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {DatabaseSync, backup} from 'node:sqlite';
import {InventoryDatabase} from '../inventory-db.mjs';
import {freePort, createTestInstanceId, waitForOwnedServer} from './test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = process.env.ASTER_AUDIT_FIXTURE;
assert(fixturePath, 'Explicit ASTER_AUDIT_FIXTURE from this run is required');
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
assert.equal(fixture.productionWrites, 0); assert.equal(fixture.realLingxingRequests, 0); assert.equal(fixture.failure, null);
assert.equal(fixture.schemaVersion, 36); assert.equal(fixture.downstreamEvidence.length, 2);
const fixtureRoot = await fs.realpath(fixture.state), tempRoot = await fs.realpath(os.tmpdir());
assert(path.dirname(fixtureRoot).toLowerCase() === tempRoot.toLowerCase() && path.basename(fixtureRoot).startsWith('aster-ink-approval-v36-'), 'Only an isolated generated fixture may be copied');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-audit-v36-'));
await fs.mkdir(path.join(state, 'data'));
const original = new DatabaseSync(path.join(fixtureRoot, 'data/aster-inventory.sqlite'), {readOnly: true});
await backup(original, path.join(state, 'data/aster-inventory.sqlite')); original.close();
const out = process.env.ASTER_ACCEPTANCE_OUTPUT || path.join(root, '.test-output/audit-v36'); await fs.mkdir(out, {recursive: true});
const clockFile = path.join(state, 'clock.txt'), preload = path.join(state, 'clock.mjs');
await fs.writeFile(clockFile, '2026-10-14T12:00:00.000Z');
await fs.writeFile(preload, `import fs from 'node:fs';const RealDate=Date;const now=()=>RealDate.parse(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};`);
const db = new InventoryDatabase(state), port = await freePort(), base = `http://127.0.0.1:${port}`;
const checks = [], events = [], queries = [], errors = [], defects = [], rid = () => crypto.randomUUID();
let child, failure;
const common = row => ({expectedRevision: row.revision, requestId: rid()});
const check = text => {checks.push(text); console.log('PASS ' + text);};
const snapshot = () => Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()]));
async function api(route, role = 'admin', body, status = 200) {
  const response = await fetch(base + route, {method: body ? 'POST' : 'GET', headers: {'x-role': role, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json();
  if (status !== null) assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
  return {...result, httpStatus: response.status};
}
async function query(filters, role = 'admin') {
  const result = await api('/api/audit?' + new URLSearchParams(filters), role);
  queries.push({filters, role, ids: result.records.map(row => row.eventId)}); return result.records;
}
async function verifyEvent(id, expected, role = 'admin') {
  const detail = await api('/api/audit/' + id, role), record = detail.record;
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `event ${id} ${key}`);
  assert.equal(record.effectKnown, true); assert.equal(record.availableDelta, expected.onHandDelta - expected.lockedDelta);
  const raw = db.db.prepare('SELECT role,occurred_at,event_type FROM document_events WHERE id=?').get(id);
  assert.equal(record.at, raw.occurred_at); assert.equal(record.role, raw.role); assert.equal(record.operation, raw.event_type);
  assert(detail.events.some(item => item.id === id && item.role === record.role && item.at === record.at));
  const list = await query({action: record.operation, model: record.model, limit: '500'}, role);
  assert.deepEqual(list.find(item => item.eventId === id), record);
  events.push({id, expected, actual: record, viewer: role}); return detail;
}
async function unchangedRequest(route, role, body, status, code) {
  const before = snapshot(), result = await api(route, role, body, status); if (code) assert.equal(result.code, code);
  assert.deepEqual(snapshot(), before); errors.push({route, role, status, code: result.code, allTablesUnchanged: true}); return result;
}
try {
  const instanceId = createTestInstanceId('audit-v36');
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'server.mjs')], {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env, ASTER_STATE_ROOT: state, ASTER_TEST_INSTANCE_ID: instanceId, PORT: String(port), HOST: '127.0.0.1', PROD: '1', TZ: 'Asia/Shanghai', ASTER_OVERSEAS_WAREHOUSES: 'SyntheticWarehouseA;SyntheticWarehouseB'}});
  await waitForOwnedServer({base, child, instanceId});
  const beforeRead = snapshot();
  for (const event of fixture.crossModuleEvidence) await verifyEvent(event.eventId, {role: event.actor, operation: event.eventType, onHandDelta: event.onHandDelta, lockedDelta: event.lockedDelta});
  assert.deepEqual(snapshot(), beforeRead);
  check('复用本轮HTTP创建的100→80→70→60→归档→回撤6个历史事件，最终状态变化后原角色/时间/库存差额仍准确；列表与详情一致只读');

  for (const chain of fixture.downstreamEvidence) {
    const work = db.getRelocationWorkItem(chain.workId);
    const workflowEvents = db.db.prepare('SELECT id,event_type FROM document_events WHERE json_extract(payload_json,\'$.workId\')=?').all(work.id);
    for (const [type, actor] of [['upgrade_relocation_started', 'operation-1'], ['upgrade_relocation_procurement', 'logistics'], ['upgrade_relocation_operation', 'operation-1'], ['upgrade_relocation_created', 'operation-1']]) {
      const found = workflowEvents.find(row => row.event_type === type); assert(found, type);
      await verifyEvent(found.id, {operation: type, role: actor, onHandDelta: 0, lockedDelta: 0});
    }
    const receipt = db.db.prepare("SELECT source_event_id AS event_id FROM upgrade_operations WHERE upgrade_id=? AND operation_type='relocation_complete'").get(work.upgradeId);
    await verifyEvent(receipt.event_id, {operation: 'upgrade_relocation_complete', role: 'logistics', quantity: 60, onHandDelta: 60, lockedDelta: 0});
    const start = db.db.prepare("SELECT source_event_id AS event_id FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_start'").get(chain.indirectUpgradeId);
    await verifyEvent(start.event_id, {operation: 'upgrade_direct_start', role: 'purchasing', quantity: 60, onHandDelta: 0, lockedDelta: 60});
    const job = db.getUpgrade(chain.indirectUpgradeId);
    const before = snapshot();
    await unchangedRequest('/api/upgrades/direct/' + job.id + '/complete', 'logistics', {...common(job), completedQuantity: 61, newVersion: 'V-FINAL', targetWarehouse: 'SyntheticWarehouseB'}, 409, 'upgrade_quantity_exceeded');
    assert.deepEqual(snapshot(), before);
    const completed = await api('/api/upgrades/direct/' + job.id + '/complete', 'logistics', {...common(job), completedQuantity: 20, newVersion: 'V-FINAL', targetWarehouse: 'SyntheticWarehouseB'});
    const completion = db.db.prepare("SELECT source_event_id AS event_id FROM upgrade_operations WHERE upgrade_id=? AND operation_type='direct_complete' ORDER BY id DESC").get(job.id);
    await verifyEvent(completion.event_id, {operation: 'upgrade_direct_complete', role: 'logistics', quantity: 20, onHandDelta: 0, lockedDelta: -20});
    const later = completed.upgrade; assert.equal(later.completedQuantity, 20); assert.equal(later.inProgressQuantity, 40);
    const detail = await api('/api/audit/' + completion.event_id, 'admin');
    assert.equal(detail.ledger.reduce((sum, item) => sum + item.onHandDelta, 0), 0); assert.equal(detail.ledger.reduce((sum, item) => sum + item.lockedDelta, 0), -20);
    await unchangedRequest('/api/audit/' + completion.event_id, 'operation-2', undefined, 403, 'group_forbidden');
    assert(!(await query({action: 'upgrade_direct_complete', model: work.model, limit: '500'}, 'operation-2')).some(row => row.eventId === completion.event_id));
    await verifyEvent(completion.event_id, {operation: 'upgrade_direct_complete', role: 'logistics', quantity: 20, onHandDelta: 0, lockedDelta: -20}, 'operation-1');
  }
  check('两业务移仓/包裹/入库/在库升级事件实际角色、时间和差额逐一核对；分次完成20在库净0/锁定-20/可用+20；超量拒绝无写入，跨团队列表及详情隔离');

  // New evidence for literal special characters and local date boundaries is created through business APIs.
  const specialModel = "AuD%_#O'Brien[中]\\X", otherModel = 'AuD-any-other';
  const fileName = '流水边界墨盒.csv';
  const csv = 'ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n' + [
    `${specialModel},200,10,AUD-SPECIAL,SyntheticWarehouseA,AUD-PLAN,2026-10-14,一团,V1`,
    `${otherModel},200,10,AUD-OTHER,SyntheticWarehouseB,AUD-PLAN-2,2026-10-14,二团,V1`,
  ].join('\n');
  const previewResponse = await fetch(base + '/api/transit/preview', {method: 'POST', headers: {'x-role': 'admin', 'x-file-name': encodeURIComponent(fileName)}, body: csv}); assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const imported = await api('/api/transit/import', 'admin', {previewToken: preview.previewToken, fileName, fileHash: preview.fileSha256, templateHash: preview.templateSha256, rows: preview.rows, requestId: rid()});
  for (const row of imported.rows) {
    const actor = row.team === '一团' ? 'assistant-1' : 'assistant-2';
    await api(`/api/transit/${row.id}/on-shelf`, actor, {...common(row), yes: 'YES'});
    const found = (await query({action: 'transit_on_shelf', model: row.model}))[0];
    await verifyEvent(found.eventId, {operation: 'transit_on_shelf', role: actor, quantity: 200, onHandDelta: 200, lockedDelta: 0, inTransitDelta: -200});
  }
  const batch = (await api('/api/inventory/catalog')).stockDetails[specialModel][0];
  const timeRows = [];
  for (const at of ['2026-10-13T15:59:59.999Z', '2026-10-13T16:00:00.000Z', '2026-10-14T15:59:59.999Z', '2026-10-14T16:00:00.000Z']) {
    await fs.writeFile(clockFile, at);
    const row = (await api('/api/allocations', 'operation-1', {model: specialModel, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version, quantity: 10, department: '一团', store: 'AUS', operator: '日期边界', fnsku: batch.fnsku, asin: 'BAUDV36001', requestId: rid()})).record;
    timeRows.push({id: row.id, at, eventId: row.events[0].id});
    await verifyEvent(row.events[0].id, {operation: 'entry', role: 'operation-1', quantity: 10, onHandDelta: 0, lockedDelta: 10});
  }
  const allIds = timeRows.map(row => row.eventId).sort((a,b)=>a-b);
  for (const model of [specialModel.toLowerCase(), '%', '_', "O'Brien", '#', '\\', '[中]']) {
    const rows = await query({action: 'entry', model, limit: '500'}); assert.deepEqual(rows.map(row=>row.eventId).sort((a,b)=>a-b), allIds);
  }
  assert.deepEqual(await query({action: 'entry', model: 'NO-RESULT-AUDIT'}), []);
  const within = await query({action: 'entry', model: specialModel, from: '2026-10-14', to: '2026-10-14'});
  assert.deepEqual(within.map(row => row.eventId).sort((a,b)=>a-b), timeRows.slice(1,3).map(row=>row.eventId));
  const exact = await query({action: 'entry', model: specialModel, from: timeRows[1].at, to: timeRows[1].at}); assert.deepEqual(exact.map(row=>row.eventId), [timeRows[1].eventId]);
  assert.deepEqual(await query({action: 'entry', model: specialModel, from: '2026-10-16', to: '2026-10-16'}), []);
  assert.deepEqual(await query({action: 'entry', model: specialModel, from: '2024-02-29', to: '2024-02-29'}), []);
  assert.deepEqual(await query({action: 'entry', model: specialModel}, 'operation-2'), []);
  check('真实导入/上架/调拨产生特殊型号，%、_、反斜杠、单引号、#、中文按字面查询且大小写不敏感；Shanghai当日00:00至23:59:59.999双边包含，前后1毫秒排除，空结果及跨团不泄漏');

  for (const [filters, expectedCode] of [[{action:'unknown-action'}, 'invalid_audit_action'], [{from:'garbage'}, 'invalid_audit_time'], [{from:'2026-10-15',to:'2026-10-14'}, 'invalid_audit_time_range']]) await unchangedRequest('/api/audit?' + new URLSearchParams(filters), 'admin', undefined, 400, expectedCode);
  for (const date of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '2026-02-29', '2026-02-30T01:00:00Z']) {
    const before = snapshot(), route = '/api/audit?' + new URLSearchParams({from: date});
    const result = await api(route, 'admin', undefined, null); assert.deepEqual(snapshot(), before);
    if (result.httpStatus !== 400 || result.code !== 'invalid_audit_time') {
      const proof = {route, expected: {status: 400, code: 'invalid_audit_time'}, actual: result, allTablesUnchanged: true};
      defects.push(proof); await fs.writeFile(path.join(out, 'date-validation-repro.json'), JSON.stringify(defects, null, 2));
    } else errors.push({route, status: result.httpStatus, code: result.code, allTablesUnchanged: true});
  }
  assert.equal(defects.length, 0, 'Invalid calendar dates must be rejected as 400; see date-validation-repro.json');
  check('未知分类、错误时间、反向日期和不存在日历日期均400，未产生任何业务或流水写入');
  db.assertInventoryInvariants(); assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
} catch (error) {failure = error.stack; throw error;}
finally {
  if (child?.exitCode === null) {const ended = once(child, 'exit'); child.kill(); await ended;}
  db.close();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({version: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), fixturePath, fixtureState: fixtureRoot, state, base, timezone: 'Asia/Shanghai', checks, events, queries, errors, defects, failure: failure ?? null, productionWrites: 0, realLingxingRequests: 0}, null, 2));
}
console.log('AUDIT_V36_PASS ' + checks.length + ' groups; ' + events.length + ' events');
