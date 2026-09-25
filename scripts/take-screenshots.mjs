// Before/after evidence using real components and an isolated, deterministic database.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';
import { seedVisualFixtures, displayTime, previewCsv, statusCsv, longNote } from './revamp-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv.includes('--after') ? 'after' : 'before';
const rightOnly = process.argv.includes('--right-only');
const out = path.resolve(root, '../_shots/revamp-comparison/v52-compact');
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-revamp-'));
const results = [], errors = [], posts = [];
let browser, server;
await fs.mkdir(out, { recursive: true });
await fs.mkdir(path.join(stateRoot, 'data'), { recursive: true });
const fixture = seedVisualFixtures(stateRoot);
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('revamp');
server = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: stateRoot, PORT: String(port), HOST: '127.0.0.1', PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
await fs.writeFile(path.join(out, `${phase}-instance.json`), JSON.stringify({ pid: process.pid, serverPid: server.pid, port, instanceId, stateRoot }));

async function ready(p) { await p.evaluate(async () => { await document.fonts.ready; document.activeElement?.blur(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
async function nav(p, title) { await p.locator('.sidebar .nav-item').filter({ hasText: title }).click(); }
async function upload(p, id, text, name) { await p.locator(id).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) }); }
async function approval(p, model) {
  await nav(p, '审批中心');
  await p.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill(model);
  const button = p.locator('.approval-model-toggle').filter({ hasText: model });
  await button.waitFor(); if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await p.locator('.approval-record').last().waitFor();
  assert.equal(await p.locator('.approval-record').count(), 32);
  assert.equal(await p.locator('.approval-record .badge').count(), 0);
}
const scenarios = [
  { id: '1-inventory-summary', title: '库存汇总', role: 'admin', rows: '.inventory-summary-row', density: true, setup: async p => { await p.locator('.inventory-summary-row').last().waitFor(); } },
  { id: '1-allocation-form', title: '调拨表单', role: 'operation-1', setup: async p => { await p.locator('.inventory-summary-row').filter({ hasText: 'SYNTH-TONER-001' }).click(); await p.locator('.alloc-toggle').first().click(); await p.getByLabel('运营备注（选填）', { exact: true }).fill('调拨草稿保留'); await p.locator('.allocation-panel').scrollIntoViewIfNeeded(); } },
  { id: '1-inquiry-form', title: '询库表单', role: 'operation-1', setup: async p => { await p.locator('.inventory-summary-row').filter({ hasText: 'SYNTH-TONER-001' }).click(); await p.getByRole('button', { name: '询库', exact: true }).click(); await p.getByRole('dialog').waitFor(); } },
  { id: '2-in-transit', title: '在途导入预览', role: 'assistant', rows: '.transit-preview-table tbody tr', density: true, setup: async p => { await nav(p, '在途库存'); await upload(p, '#transit-import-file', previewCsv, '待导入硒鼓.csv'); await p.locator('.transit-preview-table tbody tr').last().waitFor(); assert.equal(await p.locator('.transit-preview-table th').count(), 8); } },
  { id: '2-logistics-preview', title: '物流预览', role: 'assistant', rows: '.transit-status-table tbody tr', setup: async p => { await nav(p, '在途库存'); await upload(p, '#transit-status-file', statusCsv, '物流状态.csv'); await p.locator('.transit-status-table tbody tr').last().waitFor(); } },
  { id: '3-approval-center', title: '审批混合阶段 25 列', role: 'admin', rows: '.approval-record', density: true, columns: 25, setup: p => approval(p, 'APP-25') },
  { id: '3-business-18', title: '商务审核 18 列', role: 'business', rows: '.approval-record', density: true, columns: 18, setup: p => approval(p, 'APP-18') },
  { id: '3-purchase-20', title: '采购回复 20 列', role: 'purchasing', rows: '.approval-record', columns: 20, setup: async p => { await approval(p, 'APP-20'); await p.getByLabel('供应商库存回复', { exact: true }).first().fill('60'); await p.getByLabel('发货仓库', { exact: true }).first().fill('采购草稿仓库'); } },
  { id: '3-assistant-22', title: '助理归档与确认调拨 22 列', role: 'assistant', rows: '.approval-record', columns: 22, setup: async p => { await approval(p, 'APP-22'); await p.getByLabel('发货计划号', { exact: true }).first().fill('ASSISTANT-DRAFT'); await p.getByRole('button', { name: '确认调拨完成', exact: true }).first().waitFor(); } },
  { id: '3-long-notes', title: '长备注完整阅读', role: 'admin', rows: '.approval-record', columns: 25, setup: async p => { await p.route('**/api/approvals', async route => { const response = await route.fetch(), data = await response.json(); for (const rows of [data.allocations, data.inquiries]) for (const row of rows) if (row.model === 'APP-25') { row.operatorNote = longNote; if (row.reviewedAt) row.businessNote = longNote; } await route.fulfill({ response, json: data }); }); await approval(p, 'APP-25'); } },
  { id: '4-upgrade-inventory', title: '升级来源', role: 'purchasing', rows: '.upgrade-candidate-table tbody tr', density: true, setup: async p => { await nav(p, '升级库存'); await p.locator('.upgrade-candidate-table tbody tr').last().waitFor(); } },
  { id: '4-relocation-complete', title: '移仓完成入库', role: 'purchasing', focus: '.upgrade-history-table', setup: async p => { await nav(p, '升级库存'); await p.getByRole('button', { name: '完成入库', exact: true }).waitFor(); await p.locator('.upgrade-history-table').scrollIntoViewIfNeeded(); await p.locator('.upgrade-history-table').evaluate(e => e.scrollLeft = e.scrollWidth); } },
  { id: '4-direct-complete', title: '在库完成入库', role: 'purchasing', focus: '.upgrade-job', setup: async p => { await nav(p, '升级库存'); await p.getByRole('tab', { name: '在库升级', exact: true }).click(); await p.getByRole('button', { name: '登记完成并转入新版本', exact: true }).waitFor(); await p.locator('.upgrade-job').scrollIntoViewIfNeeded(); } },
  { id: '5-audit-log', title: '库存流水', role: 'admin', rows: '.audit-table tbody tr', density: true, setup: async p => { await nav(p, '库存流水'); await p.locator('.audit-table tbody tr').last().waitFor(); } },
];
async function measure(p, scenario) {
  return p.evaluate(({ rows }) => {
    const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const topbarBottom = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const records = rows ? [...document.querySelectorAll(rows)] : [];
    const bounds = records.map(el => { const r = el.getBoundingClientRect(); let top = Math.max(0, topbarBottom), bottom = innerHeight; for (let parent = el.parentElement; parent; parent = parent.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) { const b = parent.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); } return { top: r.top, bottom: r.bottom, height: r.height, complete: visible(el) && r.top >= top - .5 && r.bottom <= bottom + .5 }; });
    const seen = new Map();
    const fonts = [...document.querySelectorAll('body *')].filter(el => visible(el) && (el.matches('input,select,textarea') || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))).map(el => { const label = [el.tagName, el.getAttribute('class') || '', el.getAttribute('aria-label') || '', el.matches('select') ? 'select' : el.textContent.trim().replace(/\s+/g, ' ').slice(0, 90)].join('|'); const n = (seen.get(label) || 0) + 1; seen.set(label, n); return { key: `${label}|${n}`, size: getComputedStyle(el).fontSize }; });
    const clipped = [...document.querySelectorAll('.btn,.field,.approval-action-form,.approval-row-actions,.upgrade-inline-complete')].filter(visible).filter(el => getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2).map(el => ({ class: el.className, text: el.textContent.trim().slice(0, 35), client: el.clientWidth, scroll: el.scrollWidth }));
    const notes = [...document.querySelectorAll('.approval-long-text')].filter(el => el.textContent.includes('END-LONG-NOTE')).map(el => { const s = getComputedStyle(el); return { completeText: el.textContent.endsWith('END-LONG-NOTE-1234567890'), scrollable: el.scrollHeight <= el.clientHeight || ['auto', 'scroll'].includes(s.overflowY), wraps: ['pre-wrap', 'normal', 'break-spaces'].includes(s.whiteSpace) }; });
    return { viewport: { width: innerWidth, height: innerHeight, scale: visualViewport.scale }, pageWidth: document.documentElement.scrollWidth, rows: records.length, completeRows: bounds.filter(r => r.complete).length, bounds, fonts, clipped, notes, navCount: document.querySelectorAll('.sidebar .nav-item').length };
  }, { rows: scenario.rows });
}
async function scrollEvidence(p, id, width) {
  const tables = p.locator('.approval-table-scroll,.transit-preview-scroll,.upgrade-candidate-table,.upgrade-history-table,.upgrade-job > .table-wrap'), checks = [];
  for (let i = 0; i < await tables.count(); i++) {
    const container = tables.nth(i); if (!(await container.isVisible())) continue;
    const check = await container.evaluate(el => { const table = el.querySelector('table'); if (!table) return null; const old = el.scrollLeft; el.scrollLeft = el.scrollWidth; const last = table.querySelector('thead th:last-child').getBoundingClientRect(), data = table.querySelector('tbody tr td:last-child')?.getBoundingClientRect(), box = el.getBoundingClientRect(); return { class: el.className, tableWidth: table.getBoundingClientRect().width, containerWidth: el.clientWidth, scrollWidth: el.scrollWidth, scrollLeft: el.scrollLeft, lastHeader: table.querySelector('thead th:last-child').textContent.trim(), lastVisible: last.right <= box.right + 2 && last.left >= box.left - 2, lastAligned: !data || Math.abs(data.right - last.right) < 2, old }; });
    if (!check) continue;
    // Record defects in the untouched v52 baseline; the redesigned version must pass.
    if (phase === 'after') {
      assert.ok(check.lastVisible && check.lastAligned, JSON.stringify(check));
      if (check.scrollWidth > check.containerWidth + 2) assert.ok(check.scrollLeft > 0);
    }
    await container.evaluate(el => { const top = el.getBoundingClientRect().top + window.scrollY; const bar = document.querySelector('.topbar').getBoundingClientRect().height; window.scrollTo(0, Math.max(0, top - bar - 8)); }); await ready(p);
    assert.ok(await container.locator('thead th').last().evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= document.querySelector('.topbar').getBoundingClientRect().bottom - 1 && r.bottom <= innerHeight; }), 'Right-edge evidence must show the actual header');
    await p.screenshot({ path: path.join(out, `${phase}-${id}-${width}-right-${i}.png`), fullPage: false, animations: 'disabled' });
    await container.evaluate((el, old) => el.scrollLeft = old, check.old); checks.push(check);
  }
  return checks;
}
try {
  await waitForOwnedServer({ base, child: server, instanceId });
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  for (const scenario of scenarios) for (const width of [1440, 768, 390]) {
    if (rightOnly && !/^[234]-/.test(scenario.id)) continue;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    const p = await context.newPage(); p.setDefaultTimeout(15000); await p.clock.setFixedTime(new Date(displayTime));
    p.on('pageerror', e => errors.push({ scenario: scenario.id, width, message: e.message }));
    p.on('request', r => { if (r.method() === 'POST') posts.push({ scenario: scenario.id, path: new URL(r.url()).pathname }); });
    await p.goto(base); await p.locator('.inventory-summary-row').last().waitFor();
    await p.getByLabel('切换当前操作角色', { exact: true }).selectOption(scenario.role);
    await p.locator('.inventory-summary-row').last().waitFor(); await scenario.setup(p); await ready(p);
    if (!scenario.focus && !scenario.id.endsWith('-form')) await p.evaluate(() => window.scrollTo(0, 0));
    if (scenario.columns) assert.equal(await p.locator('.approval-line-table thead th').count(), scenario.columns);
    const metrics = await measure(p, scenario);
    assert.equal(metrics.navCount, 5); assert.equal(metrics.viewport.scale, 1);
    if (phase === 'after') { assert.ok(metrics.pageWidth <= width, `${scenario.id} ${width}: page overflow ${metrics.pageWidth}`); assert.deepEqual(metrics.clipped, [], `${scenario.id} ${width}: clipped controls`); }
    assert.ok(metrics.notes.every(n => n.completeText && n.scrollable && n.wraps));
    if (!rightOnly) {
      await p.screenshot({ path: path.join(out, `${phase}-${scenario.id}-${width}.png`), fullPage: false, animations: 'disabled' });
      if (width === 1440) await p.screenshot({ path: path.join(out, `${phase}-${scenario.id}-full.png`), fullPage: true, animations: 'disabled' });
    }
    const scrolling = await scrollEvidence(p, scenario.id, width);
    if (['3-purchase-20', '3-assistant-22'].includes(scenario.id)) {
      const form = p.locator('.inquiry-fulfillment .approval-action-form').first();
      await form.scrollIntoViewIfNeeded(); await ready(p);
      await p.screenshot({ path: path.join(out, `${phase}-${scenario.id}-${width}-form.png`), fullPage: false, animations: 'disabled' });
    }
    for (const item of await p.locator('.sidebar .nav-item').all()) { await item.scrollIntoViewIfNeeded(); assert.ok(await item.isVisible()); }
    results.push({ id: scenario.id, title: scenario.title, role: scenario.role, width, density: !!scenario.density && width === 1440, columns: scenario.columns, ...metrics, scrolling });
    await fs.writeFile(path.join(out, `${phase}${rightOnly ? '-right' : ''}-metrics.json`), JSON.stringify({ phase, fixture, results, errors, posts }, null, 2));
    console.log(`CAPTURE ${phase} ${scenario.id} ${width}: ${metrics.completeRows}/${metrics.rows} records; ${metrics.fonts.length} fonts; ${metrics.clipped.length} clipped controls`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.ok(posts.every(p => ['/api/transit/preview', '/api/transit/status/preview'].includes(p.path)), 'Capture must not submit business actions');
  if (phase === 'after' && !rightOnly) {
    const baseline = JSON.parse(await fs.readFile(path.join(out, 'before-metrics.json'), 'utf8'));
    const comparison = results.map(after => { const before = baseline.results.find(b => b.id === after.id && b.width === after.width); assert.ok(before); assert.equal(before.role, after.role); assert.equal(before.rows, after.rows); const previous = new Map(before.fonts.map(f => [f.key, f.size])); return { id: after.id, title: after.title, width: after.width, density: after.density, beforeRows: before.completeRows, afterRows: after.completeRows, increase: after.completeRows - before.completeRows, fontsCompared: after.fonts.length, fontDifferences: after.fonts.filter(f => previous.get(f.key) !== f.size), missingFonts: before.fonts.filter(f => !after.fonts.some(a => a.key === f.key)), scrollingChecks: after.scrolling.length }; });
    await fs.writeFile(path.join(out, 'comparison.json'), JSON.stringify(comparison, null, 2));
    assert.ok(comparison.every(c => !c.fontDifferences.length && !c.missingFonts.length), 'Actual fonts must remain identical; see comparison.json');
    assert.ok(comparison.filter(c => c.density).every(c => c.increase >= 1), 'Each principal list must show one more complete record; see comparison.json');
    console.log(`VISUAL_COMPARISON_PASS ${comparison.length} states; ${comparison.filter(c => c.density).length} capacity checks; ${comparison.reduce((sum, c) => sum + c.fontsCompared, 0)} font comparisons`);
  }
  console.log(`VISUAL_${phase.toUpperCase()}${rightOnly ? '_RIGHT' : ''}_PASS ${results.length} states; no unexpected business submissions`);
} catch (error) { await fs.writeFile(path.join(out, `${phase}-failure.txt`), error.stack); console.error(error.stack); throw error; }
finally {
  if (browser) { for (const context of browser.contexts()) await context.close(); await browser.close(); }
  if (server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once('close', resolve)); server.kill(); await exited; }
  const relative = path.relative(os.tmpdir(), stateRoot); assert.ok(relative.startsWith('aster-revamp-') && !relative.includes('..'));
  await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
