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
const temporary = await mkdtemp(path.join(tmpdir(), 'agent-import-paste-'));
const output = path.join(temporary, 'web');
let browser;
let server;

try {
  const build = await createRsbuild({
    cwd: web,
    rsbuildConfig: {
      plugins: [pluginReact()],
      source: { entry: {
        index: path.join(web, 'test/import-agent-paste-entry.tsx'),
        add: path.join(web, 'test/add-agents-flow-entry.tsx'),
      } },
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
      const mime = file.endsWith('.js') ? 'text/javascript'
        : file.endsWith('.css') ? 'text/css'
        : 'text/html';
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PONDEROSA_CHROMIUM_PATH,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/projects/paste-fixture/agents*', route => route.fulfill({
    json: [{ id: 'existing-agent', title: 'Shared Name', conversationId: 'chat-a' }],
  }));
  await page.goto(origin);
  const field = page.getByRole('textbox', { name: 'Or paste Agent JSON' });
  await field.waitFor();

  await page.getByRole('button', { name: 'Copy conversion prompt' }).click();
  await page.getByRole('status').getByText('Prompt copied').waitFor();
  const conversionPrompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(conversionPrompt, /ponderosa\.agent-package\.v1/);
  assert.match(conversionPrompt, /complete original conversation/);
  assert.match(conversionPrompt, /Do not include hidden system\/developer prompts/);
  const exampleText = conversionPrompt.split('BEGIN EXAMPLE\n')[1]?.split('\nEND EXAMPLE')[0];
  assert.ok(exampleText, 'copied prompt contains an example package');
  const example = JSON.parse(exampleText);
  assert.equal(example.schema, 'ponderosa.agent-package.v1');
  assert.equal(example.mode, 'full');
  assert.equal(example.kind, 'agent');
  assert.equal(example.rootRef, example.agents[0].ref);
  assert.equal(example.agents[0].history.length, 2);
  assert.equal(new Date(example.exportedAt).toISOString(), example.exportedAt);
  await field.fill(JSON.stringify(example));
  await page.getByText('1 Agent · full · 0 artifacts · 2 history messages').waitFor();
  await field.fill('');

  const sample = {
    schema: 'ponderosa.agent-package.v1',
    mode: 'full',
    kind: 'organization',
    sourceLabel: 'Synthetic paste test',
    agents: [{
      ref: 'synthetic-agent',
      title: 'Shared Name',
      engine: 'codex',
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
    }],
  };
  const small = JSON.stringify(sample);
  await page.evaluate(value => navigator.clipboard.writeText(value), small);
  await field.focus();
  await page.keyboard.press('Control+V');
  assert.equal(await field.inputValue(), small, 'small paste remains editable');
  await page.getByText('1 Agent · full · 0 artifacts · 0 history messages').waitFor();
  await page.getByText('Already in this chat: Shared Name.').waitFor();
  await page.getByText('Import creates separate Agents; it will not overwrite existing ones.').waitFor();

  await field.fill('');
  const large = JSON.stringify({ ...sample, padding: 'x'.repeat(18_000_000) });
  await page.evaluate(() => {
    window.__pasteTicks = [performance.now()];
    window.__pasteTimer = setInterval(() => window.__pasteTicks.push(performance.now()), 50);
  });
  await page.evaluate(value => navigator.clipboard.writeText(value), large);
  await field.focus();
  const started = Date.now();
  await page.keyboard.press('Control+V');
  const pasteMs = Date.now() - started;
  assert.ok(pasteMs < 3000, `large paste stalled the browser for ${pasteMs}ms`);
  assert.equal(await field.inputValue(), '', 'large paste never enters the rendered textarea');
  const attachment = page.getByRole('group', { name: 'Selected JSON package' });
  await attachment.getByText('pasted-agent-package.json').waitFor();
  await page.getByText('1 Agent · full · 0 artifacts · 0 history messages').waitFor({ timeout: 15000 });
  await attachment.getByText('18.0 MB · Ready to import').waitFor();
  if (process.env.PONDEROSA_PASTE_SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.PONDEROSA_PASTE_SCREENSHOT_DIR, 'attachment-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(process.env.PONDEROSA_PASTE_SCREENSHOT_DIR, 'attachment-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  const largestGap = await page.evaluate(() => {
    clearInterval(window.__pasteTimer);
    return Math.max(...window.__pasteTicks.slice(1).map((time, index) =>
      time - window.__pasteTicks[index]));
  });
  assert.ok(largestGap < 3000, `main thread froze for ${Math.round(largestGap)}ms`);
  await attachment.getByRole('button', { name: 'Remove' }).click();
  await attachment.waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('1 Agent · full · 0 artifacts · 0 history messages').count(), 0);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'selected-package.json',
    mimeType: 'application/json',
    buffer: Buffer.from(small),
  });
  await attachment.getByText('selected-package.json').waitFor();
  await attachment.getByText('1 KB · Ready to import').waitFor();
  await attachment.getByRole('button', { name: 'Remove' }).click();
  await attachment.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);

  const flowPage = await context.newPage();
  const flowErrors = [];
  flowPage.on('pageerror', error => flowErrors.push(error.message));
  await flowPage.route('**/api/projects/flow-fixture/agents*', route => route.fulfill({
    json: [{
      id: 'source-agent', projectId: 'flow-fixture', conversationId: 'chat-a', title: 'Original',
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
    }],
  }));
  await flowPage.route('**/api/projects/flow-fixture/conversations*', route => route.fulfill({
    json: [{ id: 'chat-a', projectId: 'flow-fixture', title: 'Destination chat' }],
  }));
  await flowPage.goto(`${origin}/add.html`);
  await flowPage.getByRole('button', { name: 'Duplicate existing Agent' }).click();
  await flowPage.getByRole('combobox', { name: 'Source Agent' }).fill('Original');
  await flowPage.getByRole('option', { name: 'Original · Destination chat' }).click();
  await flowPage.getByRole('button', { name: 'Continue' }).click();
  assert.equal(await flowPage.getByRole('textbox', { name: 'New root Agent name' }).inputValue(), 'Original copy');
  assert.deepEqual(flowErrors, []);

  const globalPage = await context.newPage();
  await globalPage.route('**/api/projects/flow-fixture/agents*', route => route.fulfill({
    json: [{
      id: 'source-agent', projectId: 'flow-fixture', conversationId: 'chat-a', title: 'Original',
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
    }],
  }));
  await globalPage.route('**/api/projects/flow-fixture/conversations*', route => route.fulfill({
    json: [{ id: 'chat-a', projectId: 'flow-fixture', title: 'Destination chat' }],
  }));
  await globalPage.goto(`${origin}/add.html?global`);
  await globalPage.getByRole('button', { name: 'Duplicate existing Agent' }).click();
  await globalPage.getByRole('combobox', { name: 'Source workspace' }).click();
  await globalPage.getByRole('option', { name: 'Flow project' }).click();
  await globalPage.getByRole('combobox', { name: 'Source Agent' }).fill('Original');
  await globalPage.getByRole('option', { name: 'Original · Destination chat' }).click();
  await globalPage.getByRole('button', { name: 'Continue' }).click();
  assert.equal(await globalPage.getByRole('textbox', { name: 'New root Agent name' }).inputValue(), 'Original copy');
  console.log(`PASS: import collision preview and duplicate picker; editable small paste; 18 MB paste; ${pasteMs}ms paste, ${Math.round(largestGap)}ms longest tick gap`);
} finally {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  await rm(temporary, { recursive: true, force: true });
}
