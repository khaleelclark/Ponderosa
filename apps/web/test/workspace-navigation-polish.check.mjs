import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginReact } from '@rsbuild/plugin-react';
import { createRsbuild } from '@rsbuild/core';

const { chromium } = await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'sidebar-polish-'));
const output = path.join(temporary, 'web');
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, 'test/workspace-navigation-polish-entry.tsx') } },
      output: { distPath: { root: output } },
      logLevel: 'error',
    },
  });
  await build.build();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(output + '/')) { response.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PONDEROSA_CHROMIUM_PATH, args: ['--no-sandbox'] });
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const scroller = page.locator('.ponderosa-scroll');
    const last = page.locator('[data-resource-id="fixture-agent-39"]');
    await last.waitFor();
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const metrics = await page.evaluate(() => {
      const scroll = document.querySelector('.ponderosa-scroll');
      const lastRow = document.querySelector('[data-resource-id="fixture-agent-39"]');
      return {
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        reachedEnd: scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2,
        rowBottom: lastRow.getBoundingClientRect().bottom,
        scrollBottom: scroll.getBoundingClientRect().bottom,
        footerCount: document.querySelectorAll('[data-sidebar-footer]').length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(metrics.scrollable, true, 'the resource list scrolls within the sidebar');
    assert.equal(metrics.reachedEnd, true, 'the final resource is reachable');
    assert.ok(metrics.rowBottom <= metrics.scrollBottom, 'the final row remains visible at the bottom of the list');
    assert.equal(metrics.footerCount, 0, 'sorting no longer creates a pinned footer');
    assert.equal(metrics.overflow, false, 'sidebar fits the viewport width');
    assert.equal(await page.getByRole('button', { name: 'View All Agents' }).count(), 0, 'the View All footer action is removed');
    if (process.env.PONDEROSA_SIDEBAR_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.PONDEROSA_SIDEBAR_SCREENSHOT_DIR, `sidebar-${width}.png`) });
    }
    const sort = page.locator('button[aria-label^="Sort Agents:"]');
    await sort.click();
    await page.getByRole('menuitem', { name: 'A–Z' }).click();
    assert.match(await sort.textContent(), /A–Z/u, 'the sidebar exposes and updates its sort choice');
    await sort.click();
    await page.getByRole('menuitem', { name: 'Custom' }).click();
    assert.match(await sort.textContent(), /Custom/u, 'custom drag order is a visible sort choice');
    await last.getByText('Chat: Owner 39').waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}×720: compact heading sort, owner label visible, final row reachable without a footer`);
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/?folders`);
  const folders = page.locator('[aria-label^="Folder "]');
  const folderNames = () => folders.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  const memberIds = () => page.locator('[aria-label="Folder Zulu folder"]').locator('xpath=../..').locator('[data-chat-row]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-chat-row')));
  assert.deepEqual(await folderNames(), ['Folder Zulu folder', 'Folder Alpha folder'], 'Recent sorts folders by their latest Chat');
  assert.deepEqual(await memberIds(), ['a', 'b'], 'Recent sorts Chats within a folder');
  const sort = page.locator('button[aria-label^="Sort Chats:"]');
  await sort.click();
  await page.getByRole('menuitem', { name: 'A–Z' }).click();
  assert.deepEqual(await folderNames(), ['Folder Alpha folder', 'Folder Zulu folder'], 'A–Z sorts folder names');
  assert.deepEqual(await memberIds(), ['b', 'a'], 'A–Z sorts Chats within a folder');
  await page.locator('[aria-label="Folder Zulu folder"]').dragTo(page.locator('[aria-label="Folder Alpha folder"]'), { targetPosition: { x: 10, y: 3 } });
  assert.deepEqual(await folderNames(), ['Folder Zulu folder', 'Folder Alpha folder'], 'dragging a folder saves its custom order');
  assert.match(await sort.textContent(), /Custom/u, 'dragging switches the sidebar to Custom');
  await page.close();
  console.log('PASS Chat folders: Recent, A–Z, and drag-to-Custom order');
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
