import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveAgentMentionBindings, recipientMentionIdentities } from '../../apps/server/src/mention-bindings.ts';
import { communicationMentionBindings } from '../../packages/agents/src/store-mention-bindings.ts';
import { resolveMessageMentionText } from '../../apps/web/src/components/chat/messageMentionPresentation.ts';
const { ChatMessageBody, communicationVisibleText, authoredAgentMentionForHandle } = await import('../../apps/web/src/components/chat/ChatMessages.tsx');
const { MutationNotificationProvider } = await import('../../apps/web/src/components/MutationNotifications.tsx');

const projectId = 'fbe0e9a6-8af1-55c3-9805-9d3daa984a1b';
const agentId = 'a6cc0309-455b-4e2f-88f3-d630ca060b1c';
const agent = { id: agentId, title: 'Build Coordinator', handle: 'Build-Coordinator', projectId };
const fragment = 'CY083Ht8uv2B1Ww4YmGJ9QdGfc6SS70+PX3+SY-ptcJHhZHa1';
const url = `https://wynnbuilder.github.io/builder/#${fragment}`;
const binding = handle => ({ projectId, agentId, handle, currentHandle: agent.handle, currentTitle: agent.title });
const visible = (text, mentions) => communicationVisibleText({ text, intent: 'user_dm', fromAgent: false, agentMentions: mentions });
const render = (text, mentions) => renderToStaticMarkup(React.createElement(MutationNotificationProvider, null, React.createElement(ChatMessageBody, {
  text, agentMentions: mentions, agentMentionForHandle: handle => authoredAgentMentionForHandle(handle, mentions),
  collapseLongMessage: false, onOpenAgent() {},
})));
const hrefs = html => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/gu)].map(match => match[1].replaceAll('&amp;', '&'));

test('one unmatched nonnumeric token is never inferred from the DM recipient', () => {
  for (const text of [url, `${url}\n${url}`, '#unknown Please review', '#123 Please review']) {
    const mentions = resolveAgentMentionBindings(projectId, text, [agentId], [agent]);
    assert.deepEqual(mentions.map(mention => mention.handle), [agent.handle]);
    assert.ok(visible(text, mentions).endsWith(text));
  }
});

test('delivered single/multiple WynnBuilder hrefs survive even an already guessed binding', () => {
  const stale = [binding(fragment.split('+')[0])];
  for (const text of [url, `[Build](${url})`, `[First](${url})\n\n[Second](${url}&mode=2)`, `<${url}>`]) {
    const resolved = visible(text, stale);
    assert.ok(resolved.includes(url));
    const links = hrefs(render(resolved, stale));
    assert.deepEqual(links, text.includes('[Second]') ? [url, `${url}&mode=2`] : [url]);
    assert.ok(!links.some(link => link.includes('#Build-Coordinator')));
  }
});

test('known current/historical handles inside URL destinations remain literal', () => {
  const mentions = [binding('Original-Builder')];
  const text = '#Original-Builder review [site](https://example.com/#Original-Builder) and https://example.org/#Original-Builder';
  const resolved = visible(text, mentions);
  assert.match(resolved, /^#Build-Coordinator review/);
  assert.deepEqual(hrefs(render(resolved, mentions)), ['https://example.com/#Original-Builder', 'https://example.org/#Original-Builder']);
});

test('copy/source presentation preserves code, images, references, escaped tags and JSON data', () => {
  const mentions = [binding('Original-Builder')];
  const literals = [
    '`#Original-Builder`', '```json\n{"agent":"#Original-Builder"}\n```',
    '    #Original-Builder\n', '![#Original-Builder](https://example.com/#Original-Builder)',
    '[label][ref]\n\n[ref]: https://example.com/#Original-Builder "#Original-Builder"',
    '\\#Original-Builder', '{"agent":"#Original-Builder","nested":["#Original-Builder"]}',
    'Payload: {"agent":"#Original-Builder","nested":{"tag":"#Original-Builder"}}',
    '"#Original-Builder"', '<span data-agent="#Original-Builder"></span>',
  ];
  for (const literal of literals) assert.equal(resolveMessageMentionText(literal, mentions), literal, literal);
  const json = '{"agent":"#Original-Builder","nested":["#Original-Builder"]}';
  assert.ok(!render(json, mentions).includes('Build-Coordinator'));
  assert.match(render(literals[3], mentions), /src="https:\/\/example.com\/#Original-Builder"/u);
});

test('durable historical aliases and current mentions still resolve to the real stable recipient', () => {
  const identities = recipientMentionIdentities([agentId], [agent], { [agentId]: 'Original Builder' }, { [agentId]: 'Original-Builder' });
  const mentions = resolveAgentMentionBindings(projectId, '#Original-Builder and #Build-Coordinator', [agentId], identities);
  assert.ok(mentions.some(mention => mention.handle === 'Original-Builder' && mention.agentId === agentId));
  assert.equal(resolveMessageMentionText('#Original-Builder and #Build-Coordinator', mentions), '#Build-Coordinator and #Build-Coordinator');
  const durable = communicationMentionBindings('#Original-Builder', {
    eventId: 'renamed-message', projectId, intent: 'user_dm', audience: { kind: 'user_agent', agentId },
    identity: { senderLabel: 'User', recipientHandles: { [agentId]: 'Original-Builder' }, recipientLabels: { [agentId]: 'Original Builder' } },
  }, () => agent);
  assert.equal(resolveMessageMentionText('Hello #original-builder!', durable), 'Hello #Build-Coordinator!');
  const html = render('Hello #Original-Builder!', durable);
  assert.match(html, /#Build-Coordinator/u);
  assert.match(html, /Originally authored as #Original-Builder/u);
});

test('prose mentions stay clickable beside decoded entities and escapes without activating literal hashes', () => {
  const mentions = [binding('Original-Builder')];
  for (const text of [
    'Hi #Original-Builder, use A &amp; B',
    'Hi #Original-Builder, use \\*literal\\*',
    'A &amp; B: #Original-Builder',
    '\\#Original-Builder then #Original-Builder',
    '&#35;Original-Builder then #Original-Builder',
    '> A &amp; B\n> #Original-Builder',
  ]) {
    const html = render(resolveMessageMentionText(text, mentions), mentions);
    assert.equal([...html.matchAll(/aria-label="Open agent Build-Coordinator/gu)].length, 1, text);
  }
  const numeric = [binding('35')];
  assert.equal(resolveMessageMentionText('A &#35; B', numeric), 'A &#35; B');
  assert.ok(!render('A &#35; B', numeric).includes('Open agent Build-Coordinator'));
});

test('opaque Markdown cannot leak JSON scanner state into a later literal payload', () => {
  const mentions = [binding('Original-Builder')];
  const payload = 'Payload: {"agent":"#Original-Builder","url":"https://example.com/#Original-Builder","code":"`#Original-Builder`"}';
  for (const prefix of ['`{"`', '```json\n{"\n```', '<span data-prefix="{\'"></span>', '[example](https://example.com/ "{\\\"")']) {
    const text = `${prefix}\n\n${payload}\n\nNext: #Original-Builder`;
    const resolved = resolveMessageMentionText(text, mentions);
    assert.equal(resolved, `${prefix}\n\n${payload}\n\nNext: #Build-Coordinator`, prefix);
    const html = render(resolved, mentions);
    assert.equal([...html.matchAll(/aria-label="Open agent Build-Coordinator/gu)].length, 1, prefix);
  }
});

test('native browser: rendered href, Open-link actions and whole-message/code copy retain exact URLs', {
  skip: process.env.PONDEROSA_REGRESSION_MENTION_BROWSER !== '1', timeout: 120000,
}, async t => {
  const { createRequire } = await import('node:module');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const webRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url));
  const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const { createRsbuild } = webRequire('@rsbuild/core');
  const { pluginReact } = webRequire('@rsbuild/plugin-react');
  const { chromium } = serverRequire('playwright-core');
  await mkdir(path.join(webRoot, 'node_modules/.cache'), { recursive: true });
  const root = await mkdtemp(path.join(webRoot, 'node_modules/.cache/mention-browser-'));
  let browser, preview;
  t.after(async () => { await browser?.close(); await preview?.server.close(); await rm(root, { recursive: true, force: true }); });
  const payload = 'Payload: {"agent":"#Original-Builder"}';
  const text = `#Original-Builder review &amp; use \\*literal\\* [Build](${url})\n\n${url}&second=2\n\n\`\`\`text\n${url}\n\`\`\`\n\n\`{"\`\n\n${payload}`;
  const mentions = [binding('Original-Builder'), binding(fragment.split('+')[0])];
  await writeFile(path.join(root, 'entry.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChatMessageBody, communicationVisibleText, authoredAgentMentionForHandle } from ${JSON.stringify(path.join(webRoot, 'src/components/chat/ChatMessages.tsx'))};
    import { CopyMessageButton } from ${JSON.stringify(path.join(webRoot, 'src/components/CopyMessageButton.tsx'))};
    import { MutationNotificationProvider } from ${JSON.stringify(path.join(webRoot, 'src/components/MutationNotifications.tsx'))};
    import { ProjectBrowserContext } from ${JSON.stringify(path.join(webRoot, 'src/components/ProjectBrowserContext.tsx'))};
    const mentions = ${JSON.stringify(mentions)};
    const text = communicationVisibleText({ text: ${JSON.stringify(text)}, intent: 'user_dm', fromAgent: false, agentMentions: mentions });
    const root = createRoot(document.getElementById('root')!);
    window.rerender = () => root.render(<MutationNotificationProvider><ProjectBrowserContext.Provider value={{ projectId: 'test', open(url) { window.openedInside = url; } }}>
      <ChatMessageBody text={text} agentMentions={mentions} agentMentionForHandle={handle => authoredAgentMentionForHandle(handle, mentions)} onOpenAgent={id => { window.openedAgent = id; }} collapseLongMessage={false} />
      <CopyMessageButton text={text} />
    </ProjectBrowserContext.Provider></MutationNotificationProvider>);
    window.rerender();
  `);
  const rsbuild = await createRsbuild({ cwd: webRoot, rsbuildConfig: {
    plugins: [pluginReact()], source: { entry: { index: path.join(root, 'entry.tsx') } },
    output: { distPath: { root: path.join(root, 'dist') } },
    html: { templateContent: '<!doctype html><html><body><div id="root"></div></body></html>' },
    server: { host: '127.0.0.1', port: 38419, open: false },
  } });
  await rsbuild.build();
  preview = await rsbuild.preview();
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${preview.port}`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  // External navigation is intercepted locally: tests do not visit WynnBuilder.
  await page.route('https://wynnbuilder.github.io/**', route => route.fulfill({ body: '<title>Captured destination</title>' }));
  await page.goto(origin);
  await page.getByRole('button', { name: /^Open agent Build-Coordinator/u }).click();
  assert.equal(await page.evaluate(() => window.openedAgent), agentId);
  const links = page.locator('a[aria-label^="Open link to"]');
  assert.equal(await links.count(), 2);
  assert.equal(await links.nth(0).getAttribute('href'), url);
  assert.equal(await links.nth(1).getAttribute('href'), `${url}&second=2`);
  await links.nth(0).click();
  assert.equal(await page.evaluate(() => window.openedInside), url);
  await links.nth(0).click({ button: 'right' });
  const dialog = page.getByRole('dialog', { name: 'Open link' });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('link', { name: 'Open Externally' }).getAttribute('href'), url);
  await dialog.getByRole('button', { name: 'Open in Ponderosa' }).click();
  assert.equal(await page.evaluate(() => window.openedInside), url);
  await links.nth(1).click({ button: 'right' });
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: 'Open Externally' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${url}&second=2`);
  await popup.close();
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  const expectedCopy = visible(text, mentions);
  assert.ok(expectedCopy.includes(payload), 'copy preserves the later literal JSON payload');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopy);
  const feedback = page.getByRole('alert').filter({ hasText: /^Copied$/u });
  await feedback.waitFor();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  await page.waitForTimeout(1500);
  assert.equal(await feedback.isVisible(), true, 'a repeated copy receives a fresh shared dismissal timer');
  await feedback.waitFor({ state: 'hidden', timeout: 2200 });
  await page.evaluate(() => window.rerender());
  assert.equal(await feedback.isVisible(), false, 'rerendering does not recreate settled feedback');
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
  await feedback.waitFor();
  await feedback.waitFor({ state: 'hidden', timeout: 4000 });
  // Exercise the existing selection/execCommand clipboard fallback as well.
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('test fallback'); } }));
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopy);
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Copy whole message' }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Copy failed; select the message text instead' });
  await error.waitFor();
  await page.waitForTimeout(3300);
  assert.equal(await error.isVisible(), true, 'clipboard failures stay visible beyond the ordinary success timeout');
  await error.getByRole('button', { name: 'Close' }).click();
  await error.waitFor({ state: 'hidden' });
});


test('All Messages keeps provider command output visible and uses shared feedback only for an acknowledgment', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/AllChatView.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let command;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'invokeCommand') command = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(command, 'the command callback exists');
  const output = [], notices = [], requests = [];
  let result = { message: 'Model: GPT-6.1\nContext: 20%\nUsage resets at 8 PM' };
  const scope = { selectedAgentId: 'agent-1', setCommandResult: value => output.push(value), notify: value => notices.push(value),
    api: { invokeProviderCommand: async (...args) => { requests.push(args); return result; } } };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(`globalThis.command = (${command.slice(command.indexOf('=') + 1)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, scope);
  await scope.command({ name: 'status' });
  assert.equal(output.at(-1), result.message, 'provider output remains owned by the durable inline result');
  assert.equal(notices.length, 0, 'status details are not expired as a success acknowledgment');
  result = {};
  await scope.command({ name: 'compact' });
  assert.equal(output.at(-1), undefined);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, '/compact Completed');
  assert.equal(notices[0].persistent, undefined, 'ordinary completion uses the shared default timeout');
  assert.deepEqual(requests.map(([agentId, input]) => [agentId, { ...input }]), [
    ['agent-1', { name: 'status' }], ['agent-1', { name: 'compact' }],
  ]);
  scope.api.invokeProviderCommand = async () => { throw new Error('Provider unavailable'); };
  await assert.rejects(scope.command({ name: 'compact' }), /Provider unavailable/);
  assert.equal(notices.length, 1, 'failures propagate to the existing command error owner');
});

// Exercise the real remaining copy owners with a controlled clipboard/notifier.
// Their shared provider's timer and durable-error behavior is covered above.
test('Agent header transcript and import conversion prompt copy preserve bytes without changing message notices', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  for (const [file, variable] of [['AgentDetail.header.tsx', undefined], ['ImportAgentDialog.tsx', 'copyExternalPrompt']]) {
    const source = await readFile(new URL(`../../apps/web/src/components/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback;
    const visit = node => {
      if (variable && ts.isVariableDeclaration(node) && node.name.getText(ast) === variable) callback = node.initializer.getText(ast);
      if (!variable && ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onSelect' && node.initializer.getText(ast).includes('copyText(transcriptMarkdown)')) callback = node.initializer.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(callback, `${file} retains its existing copy action`);
    const exact = '# Canonical transcript\n\n#Agent `literal` café 🌲\n\n{"text":"do not rewrite"}\n';
    const copied = [], notices = [];
    const scope = { transcriptMarkdown: exact, externalAgentImportPrompt: () => exact, Error,
      copyText: async text => { copied.push(text); }, notify: notice => notices.push(notice) };
    const copy = vm.runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), scope);
    await copy();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(copied, [exact], file);
    assert.equal(notices.length, 1); assert.equal(notices[0].message, 'Copied');
    assert.equal(notices[0].persistent, undefined, 'success inherits the shared three-second timeout');
    scope.copyText = async () => { throw new Error('Clipboard denied'); };
    await copy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notices.length, 2); assert.equal(notices[1].severity, 'error', 'failure uses the shared durable error path');
  }
});

test('Agent package copy retains deferred clipboard transfer and downloads have one shared acknowledgment', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/useAgentPackageActions.ts', import.meta.url), 'utf8');
  const module = { exports: {} }, notices = [], requests = [], copied = [], links = [];
  const exact = '{"agent":"Original","content":"café 🌲\\nunchanged"}';
  let exportText = Promise.withResolvers();
  const anchor = { dataset: {}, style: {}, click() { links.push({ href: this.href, download: this.download, feedback: this.dataset.ponderosaDownloadFeedback }); }, remove() {} };
  const imports = { '../api': { api: {
    exportAgentText: (...args) => { requests.push(args); return exportText.promise; },
    agentExportDownloadUrl: (...args) => { requests.push(args); return '/api/agents/agent-a/export?mode=full&organization=true'; },
  } }, '../clipboard': { copyDeferredText: async pending => { assert.equal(pending, exportText.promise, 'Safari deferred clipboard receives the original export Promise'); copied.push(await pending); } },
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) },
    './AgentDetail.helpers': { portablePackageFileName: (title, organization, mode) => `${title}-${organization}-${mode}.json` } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Error, document: { createElement: () => anchor, body: { appendChild() {} } }, require: name => imports[name] });
  const actions = module.exports.useAgentPackageActions({ agentId: 'agent-a', title: 'Original' });
  const copying = actions.copyAgentPackage('full', true);
  assert.equal(notices.length, 0, 'an unconfirmed export is not acknowledged');
  exportText.resolve(exact); await copying;
  assert.deepEqual(copied, [exact]); assert.equal(notices[0].message, 'Copied'); assert.equal(notices[0].persistent, undefined);
  exportText = Promise.withResolvers(); const failure = actions.copyAgentPackage('template'); exportText.reject(Error('Export failed')); await failure;
  assert.equal(notices[1].severity, 'error'); assert.match(notices[1].message, /Export failed/);
  await actions.downloadAgentPackage('full', true);
  assert.deepEqual(links, [{ href: '/api/agents/agent-a/export?mode=full&organization=true', download: 'Original-true-full.json', feedback: 'handled' }]);
  assert.equal(notices[2].message, 'Download started'); assert.equal(notices[2].persistent, undefined);
  assert.deepEqual(requests.map(args => [...args]), [['agent-a', 'full', true], ['agent-a', 'template', false], ['agent-a', 'full', true]]);
});

test('Agent provider commands keep meaningful output and errors in their existing owner', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/useAgentProviderCommands.ts', import.meta.url), 'utf8');
  const module = { exports: {} }, output = [], notices = [], requests = [];
  let result = { message: 'Model: GPT-6.1\nUsage: 25%\nReset: tomorrow' };
  const api = { invokeProviderCommand: async (...args) => { requests.push(args); return result; } };
  const imports = { react: { useState: () => [undefined, () => {}] }, '@tanstack/react-query': { useQueryClient: () => ({}) },
    '../api': { api }, '../providerUsageQuery': {}, '../queryKeys': {},
    './MutationNotifications': { useMutationNotification: () => notice => notices.push(notice) } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: name => imports[name] });
  const commands = module.exports.useAgentProviderCommands({ agentId: 'agent-a', engine: {}, onNotice: value => output.push(value) });
  await commands.invokeAgentCommand({ name: 'status' }, '');
  assert.equal(output.at(-1), result.message); assert.equal(notices.length, 0, 'status output remains visible rather than timed feedback');
  result = {}; await commands.invokeAgentCommand({ name: 'compact' }, '');
  assert.equal(output.length, 1, 'completion does not overwrite an existing meaningful result');
  assert.equal(notices[0].message, '/compact Completed'); assert.equal(notices[0].persistent, undefined);
  api.invokeProviderCommand = async () => { throw Error('Provider command failed'); };
  await assert.rejects(commands.invokeAgentCommand({ name: 'compact' }, ''), /Provider command failed/);
  assert.equal(notices.length, 1, 'failures propagate to the existing command error owner');
  assert.deepEqual(requests.map(([agentId, input]) => [agentId, { ...input }]), [['agent-a', { name: 'status' }], ['agent-a', { name: 'compact' }]]);
});

test('Chat provider command acknowledgment does not overwrite retained provider output', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = await import('typescript');
  const source = await readFile(new URL('../../apps/web/src/components/ConversationView.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onCommand') callback = node.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const output = [], notices = [], requests = [];
  let result = { message: 'Provider status: usage resets tomorrow' };
  const api = { invokeProviderCommand: async (...args) => { requests.push(args); return result; } };
  const scope = { api, commandTargetAgent: { id: 'agent-a', title: 'Original' },
    setQueuedMessageNotice: value => output.push(value), notify: notice => notices.push(notice) };
  const command = vm.runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), scope);
  await command({ name: 'status' }, ''); assert.equal(output[0], result.message); assert.equal(notices.length, 0);
  result = {}; await command({ name: 'compact' }, ''); assert.equal(output.length, 1);
  assert.equal(notices[0].message, '/compact Completed'); assert.equal(notices[0].persistent, undefined);
  api.invokeProviderCommand = async () => { throw Error('Provider unavailable'); };
  await assert.rejects(command({ name: 'compact' }, ''), /Provider unavailable/);
  assert.equal(notices.length, 1); assert.deepEqual(requests.map(([id, input]) => [id, { ...input }]), [['agent-a', { name: 'status' }], ['agent-a', { name: 'compact' }]]);
});
