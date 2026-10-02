// 独立 HTTP 回归：运营提交与商务批准调拨按所选在库批次套/箱校验，询库保持原规则。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInventoryDatabase, InventoryDatabase } from '../inventory-db.mjs';
import { createTestInstanceId, freePort, waitForOwnedServer } from './test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.ASTER_ALLOCATION_PACK_OUTPUT || path.join(root, '.test-output/allocation-pack-multiples');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-allocation-pack-'));
await fs.mkdir(output, { recursive: true });
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite'), seedCatalogData: false });
const db = new InventoryDatabase(state);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const instanceId = createTestInstanceId('allocation-pack');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId },
});
const checks = [];
const failures = [];
const requestId = () => crypto.randomUUID();
const check = name => { checks.push(name); console.log(`PASS ${name}`); };

async function api(route, role = 'admin', body, expectedStatus = 200) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-role': role, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (expectedStatus !== null) assert.equal(response.status, expectedStatus, JSON.stringify(result));
  return { status: response.status, ...result };
}

function snapshot() {
  return JSON.stringify(Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()])));
}

async function receive({ model, plan, date = '2026-09-24', version = 'V1', quantity, pack, team = '一团' }) {
  const csv = `ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},${quantity},${pack},XPACK00001,SyntheticWarehouseA,${plan},${date},${team},${version}`;
  const previewResponse = await fetch(`${base}/api/transit/preview`, {
    method: 'POST', headers: { 'x-role': 'admin', 'x-file-name': encodeURIComponent(`allocation-pack-硒鼓-${plan}.csv`) }, body: csv,
  });
  const previewText = await previewResponse.text();
  assert.equal(previewResponse.status, 200, previewText);
  const preview = JSON.parse(previewText);
  const imported = await api('/api/transit/import', 'admin', {
    previewToken: preview.previewToken, fileName: preview.fileName, fileHash: preview.fileSha256,
    templateHash: preview.templateSha256, rows: preview.rows, requestId: requestId(),
  });
  const shelved = await api(`/api/transit/${imported.rows[0].id}/on-shelf`, 'admin', {
    yes: 'YES', expectedRevision: imported.rows[0].revision, requestId: requestId(),
  });
  return { ...shelved, model, plan, date, version, team };
}

function allocationBody(batch, role, quantity, suffix) {
  return {
    model: batch.model, plan: batch.plan, date: batch.date, version: batch.version, sourceBatchKey: batch.batchKey,
    quantity, department: role === 'operation-2' || batch.team === '二团' ? '二团' : '一团', store: 'AUS', operator: `pack-${suffix}`,
    fnsku: 'XPACK00001', asin: 'BPACK00001', requestId: requestId(),
  };
}

async function test(name, operation) {
  try { await operation(); check(name); }
  catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.log(`FAIL ${name}: ${error.message}`); }
}

try {
  await waitForOwnedServer({ base, child: server, instanceId });
  const model = 'PACK-MULTIPLE-TEST';
  const batch4Probe = await receive({ model, plan: 'PACK4-PROBE', quantity: 20, pack: '4' });
  const batch4 = await receive({ model, plan: 'PACK4', quantity: 40, pack: '4' });
  await test('运营提交非4倍数时以明确400拒绝且全库无写入', async () => {
    const before = snapshot();
    const rejected = await api('/api/allocations', 'operation-1', allocationBody(batch4Probe, 'operation-1', 5, 'bad-four'), null);
    assert.equal(rejected.status, 400, JSON.stringify(rejected));
    assert.equal(rejected.code, 'allocation_pack_multiple');
    assert.equal(rejected.error, '套/箱为 4，调拨数量须为 4 的整数倍。');
    assert.equal(snapshot(), before);
  });

  let expectedLocked4 = 0;
  for (const quantity of [4, 8, 12]) {
    await test(`套/箱4允许调拨${quantity}件并保持幂等`, async () => {
      const body = allocationBody(batch4, 'operation-1', quantity, `four-${quantity}`);
      const submitted = await api('/api/allocations', 'operation-1', body);
      assert.equal(submitted.record.quantity, quantity);
      if (quantity === 4) {
        const replay = await api('/api/allocations', 'operation-1', body);
        assert.equal(replay.deduped, true);
      }
      expectedLocked4 += quantity;
      assert.equal(db.getBalance(batch4.batchKey).locked, expectedLocked4);
    });
  }
  await test('倍数合法但超出所选批次可用库存仍拒绝且无写入', async () => {
    const before = snapshot();
    const rejected = await api('/api/allocations', 'operation-1', allocationBody(batch4, 'operation-1', 20, 'over-available'), null);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, 'insufficient_available');
    assert.equal(snapshot(), before);
  });

  const batch6Probe = await receive({ model, plan: 'PACK6-PROBE', quantity: 20, pack: '6', team: '二团' });
  await test('同型号批次按自身套/箱6拒绝8件', async () => {
    const before = snapshot();
    const rejected = await api('/api/allocations', 'operation-2', allocationBody(batch6Probe, 'operation-2', 8, 'bad-six'), null);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.code, 'allocation_pack_multiple');
    assert.equal(rejected.error, '套/箱为 6，调拨数量须为 6 的整数倍。');
    assert.equal(snapshot(), before);
  });
  const batch6 = await receive({ model, plan: 'PACK6', quantity: 30, pack: '6', team: '二团' });
  await test('同型号另一批次套/箱6接受合法数量6', async () => {
    const accepted = await api('/api/allocations', 'operation-2', allocationBody(batch6, 'operation-2', 6, 'valid-six'));
    assert.equal(accepted.record.quantity, 6);
    assert.equal(db.getBalance(batch6.batchKey).locked, 6);
  });

  await test('缺失或无效套/箱拒绝运营调拨且不写业务数据', async () => {
    const missing = await receive({ model, plan: 'PACK-MISSING', quantity: 20, pack: '4' });
    db.db.prepare('UPDATE stock_batches SET pack_per_box = NULL WHERE batch_key = ?').run(missing.batchKey);
    const beforeMissing = snapshot();
    const missingResult = await api('/api/allocations', 'operation-1', allocationBody(missing, 'operation-1', 4, 'missing-pack'), null);
    assert.equal(missingResult.status, 400);
    assert.equal(missingResult.code, 'invalid_pack_per_box');
    assert.equal(missingResult.error, '本批次的‘套/箱’须为正整数，补全后才能调拨。');
    assert.equal(snapshot(), beforeMissing);

    db.db.prepare("UPDATE stock_batches SET pack_per_box = '0' WHERE batch_key = ?").run(missing.batchKey);
    const beforeInvalid = snapshot();
    const invalidResult = await api('/api/allocations', 'operation-1', allocationBody(missing, 'operation-1', 4, 'invalid-pack'), null);
    assert.equal(invalidResult.status, 400);
    assert.equal(invalidResult.code, 'invalid_pack_per_box');
    assert.equal(snapshot(), beforeInvalid);
  });

  await test('商务按来源batchKey显示套/箱；拒绝0件和非4倍数，仍可把申请5增至16并只新增锁定11', async () => {
    const submitted = await api('/api/allocations', 'admin', allocationBody(batch4, 'admin', 5, 'admin-increase'));
    assert.equal(submitted.record.quantity, 5);
    const approvals = await api('/api/approvals', 'business');
    assert.equal(approvals.allocations.find(record => record.id === submitted.record.id)?.packPerBox, '4');
    assert.equal(db.getBalance(batch4.batchKey).available, 11);

    let before = snapshot();
    const zero = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 0, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    }, null);
    assert.equal(zero.status, 400);
    assert.equal(snapshot(), before);

    const fractional = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 5.5, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    }, null);
    assert.equal(fractional.status, 400);
    assert.equal(fractional.code, 'invalid_quantity');
    assert.equal(snapshot(), before);

    before = snapshot();
    const nonMultiple = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 7, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    }, null);
    assert.equal(nonMultiple.status, 400, JSON.stringify(nonMultiple));
    assert.equal(nonMultiple.code, 'allocation_pack_multiple');
    assert.equal(nonMultiple.error, '套/箱为 4，审核数量须为 4 的整数倍。');
    assert.equal(snapshot(), before);

    const approvalBody = {
      decision: 'approve', approvedQuantity: 16, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    };
    const approved = await api(`/api/allocations/${submitted.record.id}/review`, 'business', approvalBody);
    assert.equal(approved.record.approvedQuantity, 16);
    assert.equal(approved.record.quantity, 16);
    assert.equal(db.getBalance(batch4.batchKey).locked, 40);
    assert.equal(db.getBalance(batch4.batchKey).available, 0);
    assert.equal(db.db.prepare("SELECT locked_delta FROM inventory_ledger WHERE document_id=? AND entry_type='review_adjustment'").get(submitted.record.id).locked_delta, 11);
    const afterApproval = snapshot();
    const replay = await api(`/api/allocations/${submitted.record.id}/review`, 'business', approvalBody);
    assert.equal(replay.deduped, true);
    assert.equal(snapshot(), afterApproval);
  });

  await test('商务按所选套/箱6批次校验，忽略客户端伪造的套/箱4并接受12', async () => {
    const submitted = await api('/api/allocations', 'admin', allocationBody(batch6Probe, 'admin', 5, 'admin-pack-six'));
    const approvals = await api('/api/approvals', 'business');
    assert.equal(approvals.allocations.find(record => record.id === submitted.record.id)?.packPerBox, '6');
    const before = snapshot();
    const rejected = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 8, packPerBox: '4', businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    }, null);
    assert.equal(rejected.status, 400, JSON.stringify(rejected));
    assert.equal(rejected.code, 'allocation_pack_multiple');
    assert.equal(rejected.error, '套/箱为 6，审核数量须为 6 的整数倍。');
    assert.equal(snapshot(), before);
    const overAvailable = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 24, packPerBox: '4', businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    }, null);
    assert.equal(overAvailable.status, 409, JSON.stringify(overAvailable));
    assert.equal(overAvailable.code, 'insufficient_available');
    assert.equal(snapshot(), before);
    const approved = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 12, packPerBox: '4', businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    });
    assert.equal(approved.record.approvedQuantity, 12);
    assert.equal(db.getBalance(batch6Probe.batchKey).locked, 12);
  });

  await test('商务减少审核数量仍释放多余锁定', async () => {
    const submitted = await api('/api/allocations', 'admin', allocationBody(batch4Probe, 'admin', 12, 'admin-decrease'));
    assert.equal(db.getBalance(batch4Probe.batchKey).available, 8);
    const approved = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 4, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    });
    assert.equal(approved.record.approvedQuantity, 4);
    assert.equal(db.getBalance(batch4Probe.batchKey).locked, 4);
    assert.equal(db.getBalance(batch4Probe.batchKey).available, 16);
    assert.equal(db.db.prepare("SELECT locked_delta FROM inventory_ledger WHERE document_id=? AND entry_type='review_adjustment'").get(submitted.record.id).locked_delta, -8);
  });

  for (const [plan, pack] of [['APPROVAL-PACK-MISSING', null], ['APPROVAL-PACK-INVALID', '0']]) {
    await test(`来源套/箱${pack == null ? '缺失' : '无效'}时商务批准无写入`, async () => {
      const source = await receive({ model, plan, quantity: 20, pack: '4' });
      db.db.prepare('UPDATE stock_batches SET pack_per_box=? WHERE batch_key=?').run(pack, source.batchKey);
      const submitted = await api('/api/allocations', 'admin', allocationBody(source, 'admin', 5, plan));
      const before = snapshot();
      const rejected = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
        decision: 'approve', approvedQuantity: 4, businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
      }, null);
      assert.equal(rejected.status, 400, JSON.stringify(rejected));
      assert.equal(rejected.code, 'invalid_pack_per_box');
      assert.equal(rejected.error, '来源批次的‘套/箱’须为正整数，补全后才能批准。');
      assert.equal(snapshot(), before);
    });
  }

  await test('来源套/箱缺失时仍可拒绝并释放预锁', async () => {
    const source = await receive({ model, plan: 'APPROVAL-PACK-REJECT', quantity: 20, pack: '4' });
    db.db.prepare('UPDATE stock_batches SET pack_per_box=NULL WHERE batch_key=?').run(source.batchKey);
    const submitted = await api('/api/allocations', 'admin', allocationBody(source, 'admin', 5, 'missing-pack-reject'));
    const rejected = await api(`/api/allocations/${submitted.record.id}/review`, 'business', {
      decision: 'reject', businessNote: '', expectedRevision: submitted.record.revision, requestId: requestId(),
    });
    assert.equal(rejected.record.approvalStatus, 'rejected');
    assert.equal(db.getBalance(source.batchKey).locked, 0);
  });

  await test('询库仍允许5件，不受库存批次套/箱倍数限制', async () => {
    const inquiry = await api('/api/inquiries', 'operation-1', {
      model, quantity: 5, department: '一团', store: 'AUS', operator: 'inquiry-pack-unrestricted',
      fnsku: 'XPACK00001', asin: 'BPACK00002', requestId: requestId(),
    });
    assert.equal(inquiry.record.quantity, 5);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM inquiry_documents WHERE operator_name='inquiry-pack-unrestricted'").get().n, 1);
    const reviewed = await api(`/api/inquiries/${inquiry.record.id}/review`, 'business', {
      decision: 'approve', approvedQuantity: 5, businessNote: '', expectedRevision: inquiry.record.revision, requestId: requestId(),
    });
    assert.equal(reviewed.record.approvedQuantity, 5);
  });

  db.assertInventoryInvariants();
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
} catch (error) {
  failures.push({ name: 'test setup', message: error.message, stack: error.stack });
  console.error(error.stack);
} finally {
  db.close();
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ state, base, checks, failures }, null, 2));
}

if (failures.length) process.exitCode = 1;
else console.log(`ALLOCATION_PACK_MULTIPLES_PASS ${checks.length}`);
