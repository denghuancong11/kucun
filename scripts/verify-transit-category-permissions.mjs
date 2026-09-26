import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInventoryDatabase, InventoryDatabase, ROLES } from '../inventory-db.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '..');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-transit-permissions-'));
createInventoryDatabase({ databasePath: path.join(state, 'data/aster-inventory.sqlite') });
const db = new InventoryDatabase(state);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const instanceId = createTestInstanceId('transit-category-permissions');
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, ASTER_STATE_ROOT: state, PORT: String(port), HOST: '127.0.0.1', PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId },
});
let serverErrors = '';
child.stderr.on('data', chunk => { serverErrors += chunk; });
const failures = [];
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function permissions(inkActions) {
  const matrix = { '墨盒': Object.fromEntries(ROLES.map(role => [role, { summary: true, detail: true, expand: true, actions: role === 'assistant-1' ? inkActions : true }])) };
  await fs.writeFile(path.join(state, 'data/permissions.json'), JSON.stringify(matrix));
}
async function preview(model = 'SYNTH-INK-001', fileName = '硒鼓.csv') {
  const csv = `ITEM,订单数量,套/箱,FNSKU,发货方式,计划号,出货时间,团队,版本号\n${model},6,3,TEST-FNSKU,SyntheticWarehouseA,P-${crypto.randomUUID()},2026-09-25,一团,V1`;
  const response = await fetch(`${base}/api/transit/preview`, { method: 'POST', headers: { 'x-role': 'assistant-1', 'x-file-name': encodeURIComponent(fileName) }, body: csv });
  return { httpStatus: response.status, ...(await response.json()) };
}
async function commit(proof) {
  const response = await fetch(`${base}/api/transit/import`, {
    method: 'POST', headers: { 'x-role': 'assistant-1', 'content-type': 'application/json' },
    body: JSON.stringify({ previewToken: proof.previewToken, fileName: proof.fileName, fileHash: proof.fileSha256, templateHash: proof.templateSha256, rows: proof.rows, requestId: crypto.randomUUID() }),
  });
  return { httpStatus: response.status, ...(await response.json()) };
}
function snapshot() {
  return JSON.stringify(Object.fromEntries(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM "${name}"`).all()])));
}
try {
  await waitForOwnedServer({ base, child, instanceId });
  await check('关闭墨盒操作后，不能通过硒鼓文件名预览已有墨盒型号', async () => {
    await permissions(false);
    const before = snapshot();
    const result = await preview();
    assert.equal(result.httpStatus, 403, JSON.stringify(result));
    assert.equal(snapshot(), before, '拒绝预览不得留下预览凭据或业务变化');
  });
  await check('预览后关闭墨盒操作，提交重新校验实际型号类目且不写库', async () => {
    await permissions(true);
    const proof = await preview();
    assert.equal(proof.httpStatus, 200); assert.ok(proof.previewToken);
    await permissions(false);
    const before = snapshot();
    const result = await commit(proof);
    assert.equal(result.httpStatus, 403, JSON.stringify(result));
    assert.equal(snapshot(), before, '拒绝导入不得消费凭据、写入业务或提升数据版本');
  });
  await check('已有墨盒型号仍可由有权限的助理通过文件导入', async () => {
    await permissions(true);
    const proof = await preview();
    assert.equal(proof.httpStatus, 200);
    const result = await commit(proof);
    assert.equal(result.httpStatus, 200, JSON.stringify(result));
    assert.equal(result.rows[0].model, 'SYNTH-INK-001');
    assert.equal(db.getModel('SYNTH-INK-001').category, '墨盒');
  });
  await check('关闭墨盒操作不会阻断已有硒鼓型号导入', async () => {
    await permissions(false);
    const proof = await preview('SYNTH-TONER-001');
    assert.equal(proof.httpStatus, 200);
    const result = await commit(proof);
    assert.equal(result.httpStatus, 200, JSON.stringify(result));
  });
  await check('未知型号继续按文件名分类，硒鼓允许而墨盒拒绝', async () => {
    const proof = await preview('NEW-AUDIT-TONER');
    assert.equal(proof.httpStatus, 200);
    const result = await commit(proof);
    assert.equal(result.httpStatus, 200, JSON.stringify(result));
    assert.equal(db.getModel('NEW-AUDIT-TONER').category, '硒鼓');
    const before = snapshot();
    const denied = await preview('NEW-AUDIT-INK', '墨盒.csv');
    assert.equal(denied.httpStatus, 403);
    assert.equal(snapshot(), before);
  });
  db.assertInventoryInvariants();
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  db.close();
}
console.log(JSON.stringify({ passed, failed: failures.length, failures, state }));
if (failures.length) console.error(serverErrors);
process.exitCode = failures.length ? 1 : 0;
