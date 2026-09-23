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
const temporary = await mkdtemp(path.join(tmpdir(), 'chat-delete-warning-'));
const output = path.join(temporary, 'web');
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: { index: path.join(web, 'test/chat-delete-warning-entry.tsx') } },
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/conversations/chat-a/members*', route => route.fulfill({
    json: [
      { id: 'agent-a', title: 'Zebra', conversationId: 'chat-a' },
      { id: 'agent-b', title: 'Alpha', conversationId: 'chat-a' },
    ],
  }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Agents that will be deleted (2)').waitFor();
  assert.equal(await dialog.getByText('Alpha').count(), 1);
  assert.equal(await dialog.getByText('Zebra').count(), 1);
  assert.equal(await dialog.getByText(/Files saved in the Project working folder and Project-level artifacts are not deleted/).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await dialog.getByRole('button', { name: 'Delete Chat' }).click();
  assert.deepEqual(await page.evaluate(() => window.confirmedAgentIds), ['agent-b', 'agent-a']);
  assert.deepEqual(errors, []);
  console.log('PASS: Chat deletion warning lists assigned Agents and protects Project files in its copy');
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
