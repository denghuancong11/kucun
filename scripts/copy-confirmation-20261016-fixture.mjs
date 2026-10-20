// Isolated synthetic schema38 acceptance. No deployed database, account or browser access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { freePort, assertPortAvailable, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, '.test-output');
const rid = () => crypto.randomUUID();
const common = row => ({ expectedRevision: row.revision, requestId: rid() });

function isolatedPath(value) {
  const relative = path.relative(outputRoot, path.resolve(value));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && relative.split(path.sep)[0].startsWith('copy-confirmation-20261016-'), 'acceptance path must be in its owned output directory');
}

export async function prepareCopyFixture(purpose = 'browser') {
  assert(['browser', 'api'].includes(purpose));
  await fs.mkdir(outputRoot, { recursive: true });
  const out = await fs.mkdtemp(path.join(outputRoot, `copy-confirmation-20261016-${purpose}-`));
  const state = path.join(out, 'state');
  await fs.mkdir(path.join(state, 'data'), { recursive: true });
  const runtimeConfig = path.join(state, 'synthetic-runtime.json');
  const accountsFile = path.join(state, 'synthetic-accounts.json');
  await fs.writeFile(runtimeConfig, JSON.stringify({ schemaVersion: 1, overseasWarehouses: ['SyntheticWarehouseA', 'SyntheticWarehouseB'] }, null, 2));
  await fs.writeFile(accountsFile, JSON.stringify({ accounts: [{ account: 'COPYUS', shortName: 'SYNTH', room: 'COPY101', sourceCell: 'synthetic-only' }] }, null, 2));
  const env = {
    ASTER_STATE_ROOT: state,
    ASTER_RUNTIME_CONFIG: runtimeConfig,
    ASTER_WAREHOUSE_ACCOUNTS: accountsFile,
    ASTER_OVERSEAS_WAREHOUSES: 'SyntheticWarehouseA;SyntheticWarehouseB',
    ASTER_WEB_DIST: path.join(root, 'web', 'dist'),
    HOST: '127.0.0.1', PROD: '1',
  };
  // The database module reads runtime config on import, so point at synthetic config first.
  Object.assign(process.env, env);
  const { createInventoryDatabase, InventoryDatabase, INVENTORY_SCHEMA_VERSION } = await import('../inventory-db.mjs');
  assert.equal(INVENTORY_SCHEMA_VERSION, 38);
  const databasePath = path.join(state, 'data', 'aster-inventory.sqlite');
  createInventoryDatabase({ databasePath, seedCatalogData: false });
  const db = new InventoryDatabase(state);
  let fixture;
  try {
    const toner = 'COPY-TONER-20261016', ink = 'COPY-INK-20261016';
    const today = '2026-10-16', at = new Date().toISOString();
    const catalogInsert = db.db.prepare('INSERT INTO catalog_models(model,category,base_in_stock,in_transit,updated_at) VALUES(?,?,0,0,?)');
    catalogInsert.run(toner, '硒鼓', at); catalogInsert.run(ink, '墨盒', at);
    function inbound(model, category, quantity, shippingMethod, plan, version) {
      const rows = [{ sourceRow: 2, data: { model, quantity, packPerBox: '10', fnsku: 'COPY-SOURCE-' + model, shippingMethod, plan, date: today, team: '一团', version } }];
      const proof = { kind: 'import', role: 'purchasing', fileName: `copy-${category}-${plan}.csv`, fileHash: 'synthetic-file-' + plan, templateHash: 'synthetic-template', payload: { rows } };
      const imported = db.transitImport({ ...proof, rows, previewToken: db.createTransitPreviewToken(proof).token, requestId: rid() }).rows[0];
      return db.markTransitOnShelf({ id: imported.id, role: 'assistant-1', yes: 'YES', ...common(imported) });
    }
    const warehouseReceipt = inbound(toner, '硒鼓', 4000, 'SyntheticWarehouseA', 'COPY-STOCK-PLAN', 'COPY-V1');
    const fbaArchive = inbound(toner, '硒鼓', 20, '直发FBA', 'COPY-FBA-PLAN', 'COPY-FBA-V1');
    inbound(ink, '墨盒', 200, 'SyntheticWarehouseB', 'COPY-INK-PLAN', 'COPY-INK-V1');
    const batch = db.getCatalog().stockDetails[toner].find(row => row.batchKey === warehouseReceipt.batchKey);
    assert(batch);
    function allocation(operator, quantity) {
      return db.createAllocation({ role: 'operation-1', model: toner, sourceBatchKey: batch.batchKey, plan: batch.plan, date: batch.date, version: batch.version,
        quantity, department: '一团', store: 'COPYUS', operator, fnsku: 'COPY-DESTINATION', asin: 'BCOPY00001', operatorNote: '合成验收备注', requestId: rid() }).record;
    }
    const pendingAllocation = allocation('合成调拨-保留查看入口', 30);
    let sourceAllocation = allocation('合成调拨-移仓来源', 100);
    sourceAllocation = db.reviewAllocation({ id: sourceAllocation.id, role: 'business', decision: 'approve', approvedQuantity: 100, businessNote: '合成商务备注', ...common(sourceAllocation) }).record;
    sourceAllocation = db.confirmAllocation({ id: sourceAllocation.id, role: 'assistant-1', ...common(sourceAllocation) }).record;
    function inquiry(model, operator, quantity) {
      return db.createInquiry({ role: 'operation-1', model, quantity, department: '一团', store: 'COPYUS', operator, fnsku: 'COPY-INQUIRY-FNSKU', asin: model === toner ? 'BCOPY00002' : 'BCOPY00003', operatorNote: '合成询库原始备注', requestId: rid() }).record;
    }
    const tonerInquiry = inquiry(toner, '合成硒鼓询库-点击行查看', 30);
    let inkInquiry = inquiry(ink, '合成墨盒询库-回复零', 50);
    inkInquiry = db.reviewInquiry({ id: inkInquiry.id, role: 'business', decision: 'approve', approvedQuantity: 40, businessNote: '合成商务审核40', ...common(inkInquiry) }).record;
    inkInquiry = db.reviewAlanInquiry({ id: inkInquiry.id, role: 'alan', alanQuantity: 40, alanNote: '合成Alan审核40', ...common(inkInquiry) }).record;
    assert.equal(inkInquiry.status, 'pending_purchasing');
    let relocation = db.initiateRelocationUpgrade({ role: 'operation-1', allocationId: sourceAllocation.id, requestId: rid() }).workItem;
    relocation = db.recordRelocationProcurement({ id: relocation.id, role: 'logistics', rma: 'COPY-RMA-001',
      relocationAddress: 'Synthetic Supplier (RMA#: COPY-RMA-001)\n12000 Magnolia Ave, Suite#101\nRiverside, CA 92503 US\nTEL:0000000000', ...common(relocation) }).workItem;
    relocation = db.recordRelocationOperation({ id: relocation.id, role: 'operation-1', removalOrderNo: 'COPY-ORDER-20261016-001', ...common(relocation) }).workItem;
    relocation = db.syncRelocationLogistics({ id: relocation.id, role: 'logistics', capturedAt: new Date().toISOString(), requestId: rid(), shipments: [{
      externalId: 'COPY-PACKAGE-ITEM-001', storeId: 'COPY-STORE-ID', storeName: 'COPY-US 美国', countryCode: 'US', orderNo: relocation.removalOrderNo,
      fnsku: relocation.fnsku, quantity: 20, carrier: 'SYNTHETIC-CARRIER', trackingNo: 'COPY-TRACKING-001', shipDate: today,
    }] }).workItem;
    const shelfEvents = db.audit({ action: 'transit_on_shelf', limit: 100 }).filter(row => row.model === toner);
    assert.equal(shelfEvents.length, 2);
    assert.deepEqual(shelfEvents.map(row => row.onHandDelta).sort((a, b) => a - b), [0, 4000]);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM inquiry_documents WHERE status IN ('archived','rejected','cancelled')").get().n, 0);
    db.assertInventoryInvariants();
    assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
    fixture = { toner, ink, pendingAllocation, sourceAllocation, tonerInquiry, inkInquiry, relocation, warehouseReceipt, fbaArchive,
      shelfEvents: shelfEvents.map(({ eventId, operation, model, onHandDelta, result }) => ({ eventId, operation, model, onHandDelta, result })) };
  } finally { db.close(); }
  const port = await freePort();
  const info = { purpose, schemaVersion: 38, root, out, state, databasePath, env, port, base: `http://127.0.0.1:${port}`,
    instanceId: createTestInstanceId('copy-confirmation-20261016'), fixture, productionReads: 0, productionWrites: 0 };
  const manifest = path.join(out, 'fixture.json');
  info.manifest = manifest;
  await fs.writeFile(manifest, JSON.stringify(info, null, 2));
  return info;
}

export async function startCopyServer(info) {
  isolatedPath(info.state); isolatedPath(info.manifest);
  assert.equal(path.resolve(info.root), root, 'fixture must use current worktree source');
  assert.equal(info.env.ASTER_STATE_ROOT, info.state);
  assert.equal(info.env.ASTER_RUNTIME_CONFIG, path.join(info.state, 'synthetic-runtime.json'));
  assert.equal(info.env.ASTER_WAREHOUSE_ACCOUNTS, path.join(info.state, 'synthetic-accounts.json'));
  await assertPortAvailable(info.port);
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...info.env, PORT: String(info.port), ASTER_TEST_INSTANCE_ID: info.instanceId } });
  const diagnostics = [];
  child.stdout.on('data', value => diagnostics.push(String(value)));
  child.stderr.on('data', value => diagnostics.push(String(value)));
  try { await waitForOwnedServer({ base: info.base, child, instanceId: info.instanceId }); }
  catch (error) { if (child.exitCode === null) child.kill(); throw new Error(error.message + '\n' + diagnostics.join('')); }
  info.serverPid = child.pid;
  await fs.writeFile(info.manifest, JSON.stringify(info, null, 2));
  return { child, diagnostics, stop: async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } await fs.writeFile(path.join(info.out, 'server.log'), diagnostics.join('')); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode = 'prepare', argument] = process.argv.slice(2);
  if (mode === 'prepare') {
    const info = await prepareCopyFixture();
    console.log('COPY_CONFIRMATION_PREPARED ' + JSON.stringify({ manifest: info.manifest, base: info.base, state: info.state, instanceId: info.instanceId,
      tonerInquiry: info.fixture.tonerInquiry.documentNo, inkInquiry: info.fixture.inkInquiry.documentNo, pendingAllocation: info.fixture.pendingAllocation.documentNo }));
  } else if (mode === 'serve') {
    assert(argument, 'serve requires the prepared fixture manifest'); isolatedPath(argument);
    const info = JSON.parse(await fs.readFile(argument, 'utf8'));
    const server = await startCopyServer(info);
    console.log('COPY_CONFIRMATION_READY ' + JSON.stringify({ base: info.base, manifest: info.manifest, serverPid: info.serverPid, instanceId: info.instanceId }));
    process.once('SIGINT', () => { void server.stop(); });
    process.once('SIGTERM', () => { void server.stop(); });
    await once(server.child, 'exit');
    await fs.writeFile(path.join(info.out, 'server.log'), server.diagnostics.join(''));
  } else throw new Error('Use prepare or serve <fixture.json>');
}
