import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { seedVisualFixtures, displayTime, previewCsv } from './revamp-fixtures.mjs';
import { freePort, createTestInstanceId, waitForOwnedServer } from './test-server-ownership.mjs';
const root = path.resolve(import.meta.dirname, '..'), out = path.resolve(root, '../_shots/revamp-comparison/v52-compact');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'aster-contrast-'));
await fs.mkdir(path.join(state, 'data')); seedVisualFixtures(state);
const port = await freePort(), base = `http://127.0.0.1:${port}`, instanceId = createTestInstanceId('contrast');
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ASTER_STATE_ROOT: state, HOST: '127.0.0.1', PORT: String(port), PROD: '1', ASTER_TEST_INSTANCE_ID: instanceId } });
let browser;
const result = { controls: [], primary: [], violations: [] };
async function controls(page) {
  return page.evaluate(() => {
    const rgba = s => { const v = s.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return [v[0], v[1], v[2], v[3] ?? 1]; };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = c => c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const background = e => { const chain = []; for (let p = e; p; p = p.parentElement) chain.unshift(p); return chain.reduce((bg, p) => over(rgba(getComputedStyle(p).backgroundColor), bg), [255, 255, 255]); };
    const seen = new Set(), samples = [];
    for (const e of document.querySelectorAll('button,button span,a,label.btn,input:not([type=file]):not([type=checkbox]),select,textarea,summary')) {
      if (!e.getClientRects().length || e.closest('[disabled],[aria-disabled=true]') || getComputedStyle(e).visibility === 'hidden') continue;
      if (!e.textContent.trim() && !e.matches('input,select,textarea') && !e.classList.contains('btn')) continue;
      const style = getComputedStyle(e), bg = background(e), fg = over(rgba(style.color), bg), x = lum(bg), y = lum(fg), ratio = (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
      const key = [e.tagName, e.className, style.color, bg.join(','), style.fontSize].join('|'); if (seen.has(key)) continue; seen.add(key);
      samples.push({ key, text: e.textContent.trim().slice(0, 30) || e.getAttribute('aria-label') || e.placeholder, foreground: style.color, background: bg, ratio, size: style.fontSize });
    }
    return samples;
  });
}
try {
  await waitForOwnedServer({ base, child: server, instanceId });
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  for (const [title, role] of [['库存汇总', 'operation-1'], ['在途库存', 'assistant'], ['审批中心', 'business'], ['升级库存', 'purchasing'], ['库存流水', 'admin']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai' });
    const p = await context.newPage(); await p.clock.setFixedTime(new Date(displayTime)); await p.goto(base); await p.locator('.inventory-summary-row').last().waitFor();
    await p.getByLabel('切换当前操作角色', { exact: true }).selectOption(role); await p.locator('.inventory-summary-row').last().waitFor();
    await p.locator('.sidebar .nav-item').filter({ hasText: title }).click();
    if (title === '库存汇总') { await p.locator('.inventory-summary-row').filter({ hasText: 'SYNTH-TONER-001' }).click(); await p.locator('.alloc-toggle').first().click(); }
    if (title === '在途库存') { await p.locator('#transit-import-file').setInputFiles({ name: '待导入硒鼓.csv', mimeType: 'text/csv', buffer: Buffer.from(previewCsv) }); await p.locator('.transit-preview-table').waitFor(); }
    if (title === '审批中心') { await p.getByLabel('搜索运营姓名、型号或 ASIN', { exact: true }).fill('APP-18'); await p.locator('.approval-model-toggle').filter({ hasText: 'APP-18' }).click(); await p.locator('.approval-review-form').first().waitFor(); }
    if (title === '升级库存') { await p.getByRole('tab', { name: '在库升级', exact: true }).click(); await p.locator('.upgrade-inline-complete').waitFor(); }
    if (title === '库存流水') await p.locator('.audit-table').waitFor();
    const samples = await controls(p); result.controls.push({ title, samples }); result.violations.push(...samples.filter(s => s.ratio < 4.5).map(s => ({ title, ...s })));
    if (title === '审批中心') {
      const session = await context.newCDPSession(p); await session.send('DOM.enable'); await session.send('CSS.enable');
      const { root: documentNode } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.approval-review-form .btn-primary' });
      for (const [stateName, forcedPseudoClasses, expected] of [['normal', [], 'rgb(255, 115, 21)'], ['hover', ['hover'], 'rgb(255, 140, 62)'], ['active', ['hover', 'active'], 'rgb(223, 90, 0)']]) {
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses });
        await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const button = p.locator('.approval-review-form .btn-primary').first();
        const style = await button.evaluate(e => ({ foreground: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor }));
        const sample = (await controls(p)).find(s => s.key.startsWith('BUTTON|btn btn-primary') && s.background.join(',') === expected.match(/[\d.]+/g).join(','));
        assert.equal(style.background, expected); assert.equal(style.foreground, 'rgb(17, 24, 39)'); assert.ok(sample && sample.ratio >= 4.5);
        result.primary.push({ state: stateName, ...style, ratio: sample.ratio });
      }
      await session.detach();
    }
    await context.close();
  }
  await fs.writeFile(path.join(out, 'contrast.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(result.violations, [], 'Enabled text contrast must be at least 4.5:1');
  console.log(`CONTRAST_PASS ${result.controls.reduce((n, p) => n + p.samples.length, 0)} control samples; 3 primary states`);
} finally {
  if (browser) { for (const context of browser.contexts()) await context.close(); await browser.close(); }
  if (server.exitCode === null && server.signalCode === null) { const closed = new Promise(resolve => server.once('close', resolve)); server.kill(); await closed; }
  assert.ok(path.relative(os.tmpdir(), state).startsWith('aster-contrast-') && !path.relative(os.tmpdir(), state).includes('..'));
  await fs.rm(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
