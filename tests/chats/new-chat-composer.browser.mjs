// Run with --import ./tests/shared/workspace-resolution.mjs against built web and server.
import assert from 'node:assert/strict';
import { mkdir, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture, until } from '../shared/fixture.mjs';

const { chromium } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('playwright-core');
const webDist = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
const f = await fixture({
  webDist,
  modelCatalog: async () => ({
    models: ["fixture", "alternative"].map(id => ({
      id, label: id === "fixture" ? "Fixture model" : "Alternative model",
      kind: "alias", source: "provider-probe",
      efforts: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }],
      defaultEffort: "medium",
    })),
    cliVersion: "controlled", configurationKey: "controlled",
  }),
});
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
  desktop.setDefaultTimeout(10000);
  phone.setDefaultTimeout(10000);
  const editor = page => page.getByRole('textbox', { name: 'Message', exact: true });
  const folderButton = page => page.getByRole("button", { name: /^Choose working folder:/u });
  const send = page => page.getByRole('button', { name: 'Send Message', exact: true });
  const runtimeButton = page => page.getByRole("button", { name: /choose engine, model, reasoning, and speed/iu });
  const plus = page => page.getByRole("button", { name: "Add Attachment Or Capability", exact: true });
  const activate = (page, element) => page === phone ? element.tap() : element.click();
  const enter = async page => {
    await page.goto(origin + '/create/chat?surface=workspace&attempt=' + randomUUID());
    await editor(page).waitFor();
    assert.equal(await folderButton(page).textContent(), 'Automatic working folder');
    await page.getByRole("heading", { name: "New Chat", exact: true }).waitFor();
    await page.getByText("No messages yet. Send a message or mention an Agent to start this Chat.").waitFor();
    const tabs = page.getByRole("tablist", { name: "Chat Views" }).getByRole("tab");
    assert.deepEqual(await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") || node.textContent.trim())),
      ["Chat", "Team Chat", "Files & Results", "Agents"]);
    await page.getByRole("button", { name: /Chat Settings And Actions/u }).waitFor();
    await page.getByRole("button", { name: /New Agent.+Send This Message To Create One/iu }).waitFor();
    await runtimeButton(page).waitFor();
    const voice = page.getByRole("button", { name: "Voice Options", exact: true });
    await activate(page, voice);
    await page.getByRole("menuitem", { name: "Record Voice Message", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: /Dictation/u }).waitFor();
    await page.keyboard.press("Escape");
    const [bar, composer] = await Promise.all([folderButton(page).boundingBox(), page.locator(".ponderosa-composer").boundingBox()]);
    assert.ok(bar.y + bar.height <= composer.y, "Folder control is directly above the composer");
    assert.ok(Math.abs(bar.x + bar.width / 2 - composer.x - composer.width / 2) < 2, "Folder and composer share a center");
    assert.equal(composer.width, page === phone ? 374 : 890, "Composer width matches the PROD reference");
    assert.ok(Math.abs(composer.y + composer.height - (page.viewportSize().height - (page === phone ? 8 : 12))) < 2,
      "Composer bottom edge matches the PROD reference");
    };
  const resultingChat = async page => {
    await page.waitForURL(chatUrl);
    return new URL(page.url()).pathname.split('/').at(-1);
  };
  const postOpening = url => /\/api\/projects\/[^/]+\/agents$/u.test(url.pathname);
  const openingBodies = [];
  const chatBodies = [];
  let loseCreation = true;
  let loseOpening = true;
  await desktop.route(url => url.pathname === '/api/chats', async route => {
    if (route.request().method() !== "POST") return route.continue();
    chatBodies.push({ payload: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    if (!loseCreation) return route.continue();
    const response = await route.fetch({ maxRetries: 0 });
    assert.ok(response.ok());
    loseCreation = false;
    await route.abort("connectionreset");
  });
  await desktop.route(postOpening, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    openingBodies.push(body);
    const response = await route.fetch({ maxRetries: 0 });
    assert.ok(response.ok());
    if (loseOpening) {
      loseOpening = false;
      return route.abort('connectionreset');
    }
    await route.fulfill({ response });
  });

  const folderName = "chosen-folder-" + "long-".repeat(32);
  const folder = path.join(f.root, folderName);
  await mkdir(folder);
  const useChosenFolder = async page => {
    await activate(page, folderButton(page));
    await activate(page, page.getByRole("button", { name: folderName, exact: true }));
    await page.getByText(folder, { exact: true }).waitFor();
    await activate(page, page.getByRole("button", { name: "Use this folder" }));
    await page.getByRole("dialog", { name: "Choose working folder" }).waitFor({ state: "hidden" });
    assert.equal(await folderButton(page).getAttribute("title"), folder);
    assert.equal(await folderButton(page).textContent(), folder);
    assert.ok((await folderButton(page).boundingBox()).width <= (await page.locator(".ponderosa-composer").boundingBox()).width);
  };
  const attach = async (page, name) => {
    await plus(page).click();
    await page.getByRole("menuitem", { name: /^Photos/u }).waitFor();
    await page.getByRole("menuitem", { name: /^Folder/u }).waitFor();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /^Files/u }).click();
    await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from("Fixture attachment") });
    await page.getByRole("button", { name: "Remove " + name, exact: true }).waitFor();
  };
  const opening = "Start typing before choosing a folder";
  await enter(desktop);
  await desktop.getByRole("button", { name: "Open Browser", exact: true }).waitFor();
  await folderButton(desktop).press("Enter");
  const picker = desktop.getByRole("dialog", { name: "Choose working folder" });
  await picker.waitFor();
  await desktop.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  await desktop.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Choose working folder: Automatic working folder");
  const newAgent = desktop.getByRole("button", { name: /New Agent.+Send This Message To Create One/iu });
  await newAgent.click();
  assert.equal(await newAgent.getAttribute("aria-pressed"), "true");
  await desktop.keyboard.insertText(opening);
  await attach(desktop, "opening.txt");
  await runtimeButton(desktop).click();
  await desktop.getByRole("button", { name: /^Model:/u }).click();
  await desktop.getByRole("menuitem", { name: /Alternative model/u }).click();
  await desktop.getByRole("slider", { name: "Reasoning Effort" }).press("End");
  await desktop.getByRole("button", { name: /Alternative model.+High.*Choose engine/iu }).waitFor();
  await desktop.keyboard.press("Escape");
  await useChosenFolder(desktop);
  assert.ok((await editor(desktop).textContent()).includes(opening));
  await desktop.getByRole("button", { name: "Remove opening.txt", exact: true }).waitFor();
  await desktop.getByRole("button", { name: /Alternative model.+High.*Choose engine/iu }).waitFor();
  assert.equal(chatBodies.length, 0, "Drafting and selecting a folder leave the Chat unsaved");
  const projectsBefore = f.ok(await f.api("GET", "/api/projects")).length;
  await send(desktop).click();
  await desktop.getByText(/Creation is unconfirmed/u).waitFor();
  await desktop.reload();
  await desktop.getByText(/Retry the same opening message/u).waitFor();
  await desktop.reload();
  const defaultChat = await resultingChat(desktop);
  const first = f.ok(await f.api("GET", "/api/conversations/" + defaultChat));
  const messages = first.messages.filter(message => message.authoredText === opening);
  assert.equal(messages.length, 1);
  assert.ok(JSON.stringify(messages[0]).includes("opening.txt"));
  assert.equal(first.conversation.workingDirectory, folder);
  assert.equal(first.conversation.defaultModel, "alternative");
  assert.equal(first.conversation.defaultEffort, "high");
  assert.equal(f.ok(await f.api("GET", "/api/projects")).length, projectsBefore + 1);
  assert.equal(chatBodies.length, 3);
  assert.deepEqual(chatBodies, Array(3).fill(chatBodies[0]));
  assert.equal(chatBodies[0].payload.hostPath, folder);
  assert.equal(openingBodies.length, 2);
  assert.deepEqual(openingBodies[0], openingBodies[1]);
  assert.equal(openingBodies[0].model, "alternative");
  assert.equal(openingBodies[0].effort, "high");
  assert.equal(openingBodies[0].draftAttachmentIds.length, 1);
  await until(() => f.turns.length === 1, "single opening provider turn");

  await enter(phone);
  const customOpening = "Keep this draft when selecting a folder";
  await editor(phone).fill(customOpening);
  await useChosenFolder(phone);
  assert.equal(await editor(phone).textContent(), customOpening);
  await folderButton(phone).tap();
  await phone.getByRole("button", { name: "Use automatic folder" }).tap();
  assert.equal(await folderButton(phone).textContent(), "Automatic working folder");
  await send(phone).tap();
  const custom = f.ok(await f.api("GET", "/api/conversations/" + await resultingChat(phone)));
  assert.notEqual(custom.conversation.workingDirectory, folder);
  assert.equal(custom.messages.filter(message => message.authoredText === customOpening).length, 1);

  await enter(phone);
  await useChosenFolder(phone);
  await phone.getByRole("tab", { name: "Files & Results", exact: true }).tap();
  const filesChat = await resultingChat(phone);
  assert.equal(new URL(phone.url()).searchParams.get("view"), "files");
  assert.equal(f.ok(await f.api("GET", "/api/conversations/" + filesChat)).conversation.workingDirectory, folder);
  await phone.getByRole("tabpanel", { name: "Files & Results", exact: true }).waitFor();

  const disappearing = path.join(f.root, "disappearing-folder");
  await mkdir(disappearing);
  await enter(phone);
  await editor(phone).fill("Retain this draft after folder validation");
  await folderButton(phone).tap();
  await phone.getByRole("button", { name: "disappearing-folder", exact: true }).tap();
  await phone.getByRole("button", { name: "Use this folder" }).tap();
  await rmdir(disappearing);
  const countBeforeRejection = f.ok(await f.api("GET", "/api/projects")).length;
  await send(phone).tap();
  await phone.getByText(/hostPath does not exist.+Correct the settings/u).waitFor();
  assert.equal(await editor(phone).textContent(), "Retain this draft after folder validation");
  assert.equal(f.ok(await f.api("GET", "/api/projects")).length, countBeforeRejection);
  await folderButton(phone).tap();
  await phone.getByRole("button", { name: "Use automatic folder" }).tap();
  await send(phone).tap();
  await resultingChat(phone);

  const defaultConversation = f.ok(await f.api('GET', '/api/conversations/' + defaultChat)).conversation;
  const root = f.turns[0].agentId;
  await f.createIdleAgent(defaultConversation, 'Imported helper', root);
  const pkg = f.ok(await f.api('GET', `/api/agents/${root}/export?mode=template&organization=true`));
  await enter(desktop);
  const unsent = 'Keep my draft after import';
  await editor(desktop).fill(unsent);
  await attach(desktop, "unsent.txt");
  await useChosenFolder(desktop);
  let loseDraft = true;
  await desktop.route(url => /^\/api\/conversations\/[^/]+\/draft$/u.test(url.pathname), async route => {
    if (route.request().method() !== "PUT" || !loseDraft) return route.continue();
    const response = await route.fetch({ maxRetries: 0 });
    assert.ok(response.ok());
    loseDraft = false;
    await route.abort("connectionreset");
  });
  await desktop.getByRole("button", { name: /Chat Settings And Actions/u }).click();
  await desktop.getByRole("menuitem", { name: "Add Agents…", exact: true }).click();
  await desktop.getByText(/Retry to continue the same action/u).waitFor();
  await desktop.reload();
  await desktop.getByRole("button", { name: "Import Agent Package", exact: true }).click();
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
  assert.equal(f.ok(await f.api("GET", "/api/conversations/" + importDestination)).conversation.workingDirectory, folder);
  const imported = f.ok(await f.api('GET', `/api/conversations/${importDestination}/members`));
  assert.equal(imported.length, 2);
  const helper = imported.find(agent => agent.title === 'Imported helper');
  assert.ok(helper?.managerAgentId && imported.some(agent => agent.id === helper.managerAgentId));
  await editor(desktop).waitFor();
  assert.equal(await editor(desktop).textContent(), unsent);
  assert.equal(openingBodies.length, 2, 'Import never submits the draft');
  await desktop.getByRole("button", { name: "Remove unsent.txt", exact: true }).waitFor();
  console.log("Passed PROD-width composer and standard controls on desktop and phone, working-folder selection and reset, exact creation/opening replay with attachment and runtime, Files & Results, and standard Agent Package import with draft handoff.");
} finally {
  await browser?.close();
  await f.dispose();
}
