// Run against the built web and server with --import ./tests/shared/workspace-resolution.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { fixture, until } from '../shared/fixture.mjs';
import { seedQualificationHistory } from '../shared/ui-load-fixture.mjs';

const { chromium } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('playwright-core');
const webDist = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
const chatPath = chat => '/projects/' + chat.projectId + '/chats/' + chat.id;
const endpoint = chat => '/api/conversations/' + chat.id;
const longTitle = 'A long project and Chat title that leaves limited space between mobile actions';
let store, browser;
const f = await fixture({ webDist, storeFactory: dir => (store = new AgentStore(dir)) });
try {
  const origin = await f.listen();
  const live = await f.createChat('Working Agents fixture');
  const lead = await f.createIdleAgent(live, 'Lead');
  const worker = await f.createIdleAgent(live, 'Reviewer');
  const history = await f.createChat(longTitle);
  const seed = seedQualificationHistory(store, history, 225);
  browser = await chromium.launch({
    executablePath: process.env.PONDEROSA_BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
    headless: true,
  });
  const desktop = await browser.newPage({ viewport: { width: 1328, height: 900 }, serviceWorkers: 'block' });
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
  });
  const errors = [];
  for (const page of [desktop, phone]) {
    page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
  }
  const go = (page, path) => page.goto(origin + path, { waitUntil: 'domcontentloaded' });
  const submit = async (text, mode) => f.ok(await f.api('POST', endpoint(live) + '/messages', {
    text: '#' + lead.handle + ' ' + text,
    idempotencyKey: randomUUID(),
    ...(mode ? { activeRunDelivery: mode } : {}),
    recipientAgentMentions: [{
      agentId: lead.id, projectId: live.projectId, handle: lead.handle,
      currentHandle: lead.handle, currentTitle: lead.title,
    }],
  }));
  const detail = async () => f.ok(await f.api('GET', endpoint(live)));

  await go(desktop, chatPath(live));
  f.plans.set(lead.id, [{ hold: true }]);
  await submit('Hold a direct turn');
  await until(async () => (await detail()).messages.some(message =>
    message.deliveryReceipts?.some(receipt => receipt.providerAcknowledged)), 'direct turn acknowledgement');
  const working = desktop.getByRole('button', { name: 'Lead is working', exact: true });
  await working.waitFor();
  await submit('Hold this follow-up in the queue', 'queue');
  await desktop.getByText(/Hold this follow-up in the queue/).first().waitFor();
  await working.waitFor();

  f.plans.set(worker.id, [{ hold: true }]);
  await f.tool(f.sessions.get(lead.id), 'ponderosa_coordinate', { recipientAgentId: worker.id, text: 'Review the fixture' });
  await desktop.getByRole('button', { name: '2 agents are working', exact: true }).waitFor();

  const sample = (await detail()).messages.find(message => message.deliveryReceipts?.length);
  await phone.route(url => url.pathname === endpoint(live), async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const json = await response.json();
    json.providerFailureMessages = [{
      ...sample,
      deliveryReceipts: [{
        ...sample.deliveryReceipts[0], activationId: 'fixture-warning', state: 'failed',
        providerFailure: { category: 'unavailable', providerId: 'codex', runId: 'earlier-run', recovery: 'action_required' },
      }],
    }];
    await route.fulfill({ response, json });
  });
  await go(phone, chatPath(live));
  await phone.getByRole('button', { name: 'Codex is temporarily unavailable. Details' }).waitFor();
  const phoneWorking = phone.getByRole('button', { name: '2 agents are working', exact: true });
  await phoneWorking.tap();
  const tooltip = phone.getByRole('tooltip');
  await tooltip.getByText(/Reviewer — Working/).waitFor();
  await tooltip.getByText(/Lead — Working/).waitFor();

  const old = seed.messageIds[44];
  const oldLink = chatPath(history) + '?message=' + encodeURIComponent(old);
  await go(desktop, oldLink);
  const latest = desktop.locator('#master-message-' + seed.lastId);
  const historyWindowButton = desktop.getByRole('button', { name: 'Return to Latest', exact: true });
  await historyWindowButton.waitFor();
  assert.equal(await desktop.getByRole('button', { name: '2 agents are working', exact: true }).count(), 0);
  assert.equal(await latest.count(), 0);
  assert.equal(await desktop.getByRole('button', { name: 'Jump To Latest Message', exact: true }).count(), 0);
  await historyWindowButton.click();
  await latest.waitFor();
  assert.equal(new URL(desktop.url()).searchParams.has('message'), false);
  await desktop.reload();
  await latest.waitFor();
  assert.equal(await historyWindowButton.count(), 0);

  await go(phone, '/manage/chats');
  const title = phone.getByRole('link', { name: longTitle, exact: true });
  await title.waitFor();
  const subtitle = title.locator('xpath=following-sibling::*[1]');
  assert.equal(await subtitle.evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
  const archive = title.locator('xpath=../..').getByRole('button', { name: 'Archive', exact: true });
  const subtitleRect = await subtitle.boundingBox(), archiveRect = await archive.boundingBox();
  assert.ok(subtitleRect.x + subtitleRect.width <= archiveRect.x, 'Project subtitle stays outside the Archive button');
  await title.click();
  await phone.waitForURL(origin + chatPath(history));

  f.ok(await f.api('POST', endpoint(history) + '/archive', { stopRunIds: [] }));
  await go(desktop, oldLink);
  const archivedNotice = 'Archived Chat · read-only. Restore it from Manage Chats to send messages.';
  await desktop.getByText(archivedNotice, { exact: true }).waitFor();
  await desktop.locator('#master-message-' + old).waitFor();
  assert.equal(await desktop.getByRole('textbox', { name: 'Message', exact: true }).count(), 0);
  assert.equal(await desktop.getByRole('tab', { name: 'Agents', exact: true }).count(), 0);

  await go(phone, '/manage/chats');
  await phone.getByRole('button', { name: 'Archived Chats', exact: true }).click();
  await phone.getByRole('dialog', { name: 'Archived Chats' }).getByRole('button', { name: 'Open read-only' }).click();
  await phone.waitForURL(origin + chatPath(history));
  await phone.getByText(archivedNotice, { exact: true }).waitFor();
  await phone.locator('#master-message-' + seed.lastId).waitFor();
  assert.ok(f.ok(await f.api('GET', endpoint(history))).conversation.archivedAt, 'Opening preserves archive state');
  assert.deepEqual(errors, []);
  console.log('Passed working Agents, historical jump, read-only archive links, and mobile Manage Chats checks.');
} finally {
  await browser?.close();
  await f.dispose();
}
