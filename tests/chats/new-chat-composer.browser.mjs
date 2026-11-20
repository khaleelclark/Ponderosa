// Run with --import ./tests/shared/workspace-resolution.mjs against built web and server.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture, until } from '../shared/fixture.mjs';

const { chromium } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('playwright-core');
const webDist = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
const f = await fixture({ webDist });
const chatUrl = /\/projects\/[^/]+\/chats\/[^/]+/u;
let browser;
try {
  const origin = await f.listen();
  browser = await chromium.launch({
    executablePath: process.env.PONDEROSA_BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
    headless: true,
  });
  const desktop = await browser.newPage({ viewport: { width: 1328, height: 900 }, serviceWorkers: 'block' });
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
  });
  const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
  const folderButton = page => page.getByRole('button', { name: 'Choose working folder', exact: true });
  const send = page => page.getByRole('button', { name: 'Send Message', exact: true });
  const enter = async page => {
    await page.goto(origin + '/create/chat?surface=workspace&attempt=' + randomUUID());
    await editor(page).waitFor();
    assert.equal(await folderButton(page).textContent(), 'Automatic working folder');
    const [bar, composer] = await Promise.all([folderButton(page).boundingBox(), editor(page).boundingBox()]);
    assert.ok(bar.y + bar.height < composer.y, 'Folder control is above the editor');
    assert.ok(composer.y > page.viewportSize().height * 0.6, 'Composer is docked at the bottom');
  };
  const resultingChat = async page => {
    await page.waitForURL(chatUrl);
    return new URL(page.url()).pathname.split('/').at(-1);
  };
  const postOpening = url => /\/api\/projects\/[^/]+\/agents$/u.test(url.pathname);
  const openingBodies = [];
  const chatBodies = [];
  let loseResponse = true;
  await desktop.route(url => url.pathname === '/api/chats', async route => {
    if (route.request().method() === 'POST') chatBodies.push(route.request().postDataJSON());
    await route.continue();
  });
  await desktop.route(postOpening, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    openingBodies.push(body);
    const response = await route.fetch({ maxRetries: 0 });
    assert.ok(response.ok());
    if (loseResponse) {
      loseResponse = false;
      return route.abort('connectionreset');
    }
    await route.fulfill({ response });
  });

  const opening = 'Start typing before choosing a folder';
  await enter(desktop);
  await editor(desktop).fill(opening);
  assert.equal(chatBodies.length, 0, 'Typing leaves the Chat unsaved');
  await send(desktop).click();
  await desktop.getByText(/Retry the same opening message/u).waitFor();
  await desktop.reload();
  const defaultChat = await resultingChat(desktop);
  const defaultMessages = f.ok(await f.api('GET', '/api/conversations/' + defaultChat)).messages;
  assert.equal(defaultMessages.filter(message => message.authoredText === opening).length, 1);
  assert.equal(chatBodies.length, 2);
  assert.deepEqual(chatBodies[0], chatBodies[1]);
  assert.equal(chatBodies[0].hostPath, undefined);
  assert.equal(openingBodies.length, 2);
  assert.deepEqual(openingBodies[0], openingBodies[1]);
  await until(() => f.turns.length === 1, 'single default provider turn');

  const folder = path.join(f.root, 'chosen');
  await mkdir(folder);
  await enter(phone);
  const customOpening = 'Keep this draft when selecting a folder';
  await editor(phone).fill(customOpening);
  await folderButton(phone).tap();
  await phone.getByRole('button', { name: 'chosen', exact: true }).tap();
  await phone.getByText(folder, { exact: true }).waitFor();
  await phone.getByRole('button', { name: 'Use this folder' }).tap();
  assert.equal(await folderButton(phone).textContent(), folder);
  assert.equal(await editor(phone).textContent(), customOpening);
  await folderButton(phone).tap();
  await phone.getByRole('button', { name: 'Use automatic folder' }).tap();
  assert.equal(await folderButton(phone).textContent(), 'Automatic working folder');
  await folderButton(phone).tap();
  await phone.getByRole('button', { name: 'Use this folder' }).tap();
  await send(phone).tap();
  const custom = f.ok(await f.api('GET', '/api/conversations/' + await resultingChat(phone)));
  assert.equal(custom.conversation.workingDirectory, folder);
  assert.equal(custom.messages.filter(message => message.authoredText === customOpening).length, 1);

  const defaultConversation = f.ok(await f.api('GET', '/api/conversations/' + defaultChat)).conversation;
  const root = f.turns[0].agentId;
  await f.createIdleAgent(defaultConversation, 'Imported helper', root);
  const pkg = f.ok(await f.api('GET', `/api/agents/${root}/export?mode=template&organization=true`));
  await enter(desktop);
  const unsent = 'Keep my draft after import';
  await editor(desktop).fill(unsent);
  await desktop.getByRole('button', { name: 'Import Agent or organization' }).click();
  const dialog = desktop.getByRole('dialog', { name: 'Import Agent Package' });
  await dialog.getByText('Choose or paste Agent / organization package').waitFor();
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'organization.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await dialog.getByRole('combobox', { name: 'Default Engine' }).click();
  await desktop.getByRole('option', { name: 'Controlled regression adapter', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review Access Settings', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Restrictions For Imported Agents' }).click();
  await desktop.getByRole('option', { name: 'Keep Destination Restrictions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const importDestination = await resultingChat(desktop);
  const imported = f.ok(await f.api('GET', `/api/conversations/${importDestination}/members`));
  assert.equal(imported.length, 2);
  const helper = imported.find(agent => agent.title === 'Imported helper');
  assert.ok(helper?.managerAgentId && imported.some(agent => agent.id === helper.managerAgentId));
  await editor(desktop).waitFor();
  assert.equal(await editor(desktop).textContent(), unsent);
  assert.equal(openingBodies.length, 2, 'Import never submits the draft');
  console.log('Passed bottom composer, automatic and selected folders, exact first-send recovery, and direct package import entry.');
} finally {
  await browser?.close();
  await f.dispose();
}
