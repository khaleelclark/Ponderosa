import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

const web = fileURLToPath(new URL('..', import.meta.url));
const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const output = await mkdtemp(path.join(tmpdir(), 'qualification-followups-'));
const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH ?? 'playwright');
function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 40 >>\nstream\nBT /F1 24 Tf 30 150 Td (Page one) Tj ET\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '<< /Length 40 >>\nstream\nBT /F1 24 Tf 30 150 Td (Page two) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let text = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text;
}
let browser, server;
try {
  const build = await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()], source: { entry: { index: path.join(web, 'test/qualification-followups-entry.tsx') } }, output: { distPath: { root: output }, copy: [
    { from: path.join(pdfjsRoot, 'standard_fonts'), to: 'static/pdfjs/6.3.289/standard_fonts' },
    { from: path.join(pdfjsRoot, 'cmaps'), to: 'static/pdfjs/6.3.289/cmaps' },
  ] }, logLevel: 'error' } });
  await build.build();
  server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/pdf/')) { res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(url.pathname.endsWith('/bad') ? 'not a PDF' : pdfFixture()); return; }
    try { const file = path.join(output, url.pathname === '/' ? 'index.html' : url.pathname);
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const checkSidebarDividers = async page => {
    const sections = page.locator('[data-workspace-sidebar-sections]');
    await sections.waitFor();
    const borders = await sections.evaluate(el => {
      const style = getComputedStyle(el);
      return { top: style.borderTopWidth, bottom: style.borderBottomWidth, color: style.borderBottomColor };
    });
    assert.equal(borders.top, '1px', 'sidebar header and navigation have a thin divider');
    assert.equal(borders.bottom, '1px', 'navigation and Chat/Agent/Automation list have a thin divider');
    assert.notEqual(borders.color, 'rgba(0, 0, 0, 0)');
    const header = await page.locator('[data-workspace-sidebar-header]').boundingBox();
    const menu = await sections.boundingBox();
    const search = await page.getByRole('textbox', { name: 'Search chats', exact: true }).boundingBox();
    assert.ok(header.y + header.height <= menu.y + 1 && menu.y + menu.height <= search.y, 'divided regions remain separate');
  };
  for (const width of [320, 390, 430, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?case=receipt`);
    await page.getByRole('button', { name: 'Try Work Again', exact: true }).waitFor();
    for (const zoom of [1, 2]) {
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      for (const button of await page.locator('article button').all()) {
        const bounds = await button.boundingBox(), article = await page.locator('article').boundingBox();
        assert.ok(bounds.x >= article.x - 1 && bounds.x + bounds.width <= article.x + article.width + 1, `delivery control exceeds message at ${width}px / ${zoom * 100}% zoom`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no page overflow at ${width}px / ${zoom * 100}% zoom`);
    }
    await page.close();
  }
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByText('Page 1 of 2', { exact: true }).waitFor();
    await page.locator('canvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator('iframe').count(), 0);
    assert.ok(await page.locator('canvas').evaluate(node => {
      const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
      return data.some((value, index) => index % 4 !== 3 && value < 200);
    }), 'PDF content actually painted');
    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByText('Page 2 of 2', { exact: true }).waitFor();
    await page.locator('canvas').waitFor({ state: 'visible' });
    await page.goto(`${origin}/?bad=1`);
    await page.getByText('PDF preview could not be loaded.', { exact: false }).waitFor();
    await page.getByRole('link', { name: 'Open', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Download', exact: true }).waitFor();
    await page.goto(`${origin}/?case=review-route`);
    await page.getByRole('button', { name: 'Review All', exact: true }).click();
    assert.equal(await page.evaluate(() => document.body.dataset.review), 'agent:response-run');
    await page.goto(`${origin}/?case=review-route&missing-run=1`);
    await page.getByText('Response review is unavailable because this message has no recorded Run ID.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review All', exact: true }).count(), 0, 'missing response Run never falls back to aggregate review');
    await page.goto(`${origin}/?case=review`);
    if (width === 390) await page.getByRole('button', { name: 'Files', exact: true }).click();
    const rows = page.getByRole('button', { name: /^Review src\// });
    await rows.first().waitFor();
    assert.equal(await rows.count(), 75);
    const bounds = await rows.evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; }));
    assert.ok(bounds.every((row, i) => row.height >= 44 && (!i || row.top >= bounds[i - 1].bottom - 1)), 'long review rows do not overlap');
    await page.goto(`${origin}/?case=import`);
    await page.getByRole('button', { name: 'Import Agent package', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'agent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schema: 'ponderosa.agent-package.v1', sourceLabel: 'Disposable test', mode: 'full', kind: 'agent', rootRef: 'one', agents: [{ ref: 'one', title: 'Imported', engine: 'codex', managementPermissions: { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false } }] })) });
    await page.getByText('1 Agent · full · 0 artifacts · 0 history messages').waitFor({ timeout: 5000 }).catch(async error => { throw new Error(`${error.message}\n${await page.locator('body').innerText()}`); });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.closed === 'yes');
    assert.equal(await page.getByText(/Discard this unfinished/).count(), 0);
    await page.getByRole('button', { name: 'Reopen creation' }).click();
    await page.getByRole('button', { name: 'Close Create Agent' }).click();
    assert.equal(await page.getByText(/Discard this unfinished/).count(), 0, 'accepted import clears dirty state');
    await page.goto(`${origin}/?case=import&fail=1`);
    await page.getByRole('button', { name: 'Import Agent package', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({ name: 'agent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schema: 'ponderosa.agent-package.v1', sourceLabel: 'Disposable test', mode: 'full', kind: 'agent', agents: [{ ref: 'one', title: 'Imported', engine: 'codex', managementPermissions: { allowAutomaticDescendantDeletion: false, allowAutomaticDescendantReorganization: false } }] })) });
    await page.getByText('1 Agent · full · 0 artifacts · 0 history messages').waitFor();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('Fixture import failed.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Close Create Agent' }).click();
    await page.getByText('Discard this unfinished Agent?', { exact: true }).waitFor();
    await page.goto(`${origin}/?case=automation`);
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Destination Chat', exact: true }).count(), 1);
    assert.equal(await page.getByRole('combobox', { name: 'Runs As', exact: true }).count(), 1);
    await page.goto(`${origin}/?case=browser-picker`);
    await page.getByRole('button', { name: 'Browser workspaces', exact: true }).click();
    const names = await page.getByRole('menuitem').allTextContents();
    assert.equal(names.length, 11);
    assert.equal(new Set(names).size, 11, 'eleven New Chats have unique folder-qualified names');
    assert.equal(await page.evaluate(() => Number(document.body.dataset.chatQueries)), 1, 'naming does not collect unopened Project Chats');
    await page.goto(`${origin}/?case=sidebar`);
    await checkSidebarDividers(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: /Open agent Agent, #unique-agent, in Chat/ }).waitFor();
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.getByRole('button', { name: 'Open Daily Automation', exact: true }).click();
    assert.equal(JSON.parse(await page.evaluate(() => document.body.dataset.route)).returnTo, '/manage/automations', 'Automation opened from Home returns to its directory');
    await page.goto(`${origin}/?case=sidebar&drawer=1`);
    await checkSidebarDividers(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: /Open agent Agent, #unique-agent, in Chat/ }).waitFor();
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'pass', widths: [320, 390, 430, 1440], cases: ['delivery containment', 'PDF painting and paging', 'PDF error', 'response review identity', '75 long review rows', 'full-dialog import success and failure', 'single Automation ownership selectors', 'eleven distinguishable browser workspaces without fanout', 'desktop/drawer sidebar dividers', 'Agent accessible handle and Automation return route'] }));
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
