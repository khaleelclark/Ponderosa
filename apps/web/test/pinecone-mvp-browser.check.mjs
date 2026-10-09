import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { createServer } from '../../server/dist/app.js';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { AgentStore, CoordinationV3Store } = require('@ponderosa/agents');
const Database = require('better-sqlite3');
const module = await import(pathToFileURL(require.resolve('playwright-core')));
const { chromium } = module.default ?? module;
const web = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'pinecone-mvp-'));
const store = new AgentStore(path.join(root, 'data'));
const database = store.sqlite;
// paths.ts dbPath: retain the physical path after directory-FD authority closes.
const physicalDatabasePath = path.join(root, 'data', 'ponderosa.db');
const databasePaths = { runtimeFilename: database.name, physicalPath: physicalDatabasePath };
const coordination = new CoordinationV3Store(store.sqlite);
const sha = value => createHash('sha256').update(value).digest('hex');
const invocations = [], toolCalls = [], gates = [], responseOwners = [], pageErrors = [], adapterFailures = [], sockets = new Set();
const stages = {}, checkpoints = [], layouts = [], results = [];
let app, browser, page, cone, manager, parentRequestId, childJoinId, decision, resolvedDecision, sourceArtifactId, initialIntake, secondIntake, primaryFailure, closing = false;
let firstHumanConsumed = false, followupDecisionAsked = false, decisionConsumed = false, synthesized = false;
const children = [];
function gate(label) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const owner = { label, released: false, releaseCount: 0, promise, release() {
    if (owner.released) return;
    owner.released = true; owner.releaseCount++; release();
  } };
  gates.push(owner); return owner;
}
const delegationEnd = gate('parent delegation turn'), firstChild = gate('first child result'), secondChild = gate('second child result');
const rows = (table, sqlite = database) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const runRow = id => store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(id);
const joinRow = () => store.sqlite.prepare('SELECT * FROM coordination_joins WHERE id=?').get(childJoinId);
const counts = (sqlite = database) => Object.fromEntries(['agents', 'runtime_communications', 'agent_activations', 'scheduler_runs', 'coordination_requests', 'coordination_joins'].map(table => [table, rows(table, sqlite).length]));
function capture(label, sqlite = database) {
  const proof = { label, utc: new Date().toISOString(), counts: counts(sqlite),
    runs: rows('scheduler_runs', sqlite), activations: rows('agent_activations', sqlite), sources: rows('activation_sources', sqlite),
    requests: rows('coordination_requests', sqlite), updates: rows('coordination_request_updates', sqlite), joins: rows('coordination_joins', sqlite),
    attachments: rows('scheduler_run_activations', sqlite), injections: rows('scheduler_prompt_injections', sqlite), obligations: rows('required_reply_obligations', sqlite) };
  checkpoints.push(proof); console.log('CHECKPOINT ' + JSON.stringify(proof)); return proof;
}
async function until(label, read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (adapterFailures.length) throw adapterFailures[0];
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Canonical state deadline: ' + label);
}
async function operator(url, payload) {
  const response = await app.inject({ method: payload ? 'POST' : 'GET', url, ...(payload ? { payload } : {}) });
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return response.json();
}
async function tool(options, name, route, body) {
  const names = JSON.parse(options.environment.PONDEROSA_AGENT_TOOL_NAMES);
  assert.ok(names.includes(name), 'Tool must belong to the frozen admitted Run: ' + name);
  const run = store.sqlite.prepare("SELECT * FROM scheduler_runs WHERE agent_id=? AND status='running'").get(options.agentId);
  assert.ok(run); assert.equal(run.agent_id, options.agentId);
  const response = await app.inject({ method: 'POST', url: route,
    headers: { authorization: `Bearer ${options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` }, payload: body });
  const proof = { name, runId: run.id, fencingToken: run.fencing_token, agentId: options.agentId, route,
    arguments: body, status: response.statusCode, response: response.json() };
  toolCalls.push(proof); console.log('NORMAL RUN TOOL ' + JSON.stringify(proof));
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  assert.equal(response.json().recovering, undefined, 'No ambiguous committed side effect is accepted');
  return response.json();
}
function waitResponse(predicate) {
  const response = page.waitForResponse(predicate);
  responseOwners.push(response.then(async value => {
    const proof = { url: value.url(), method: value.request().method(), status: value.status(), body: await value.text() };
    console.log('OWNED HTTP RESPONSE ' + JSON.stringify(proof)); return proof;
  }).catch(cause => ({ cause })));
  return response;
}
async function keyboard(locator) {
  await locator.waitFor(); await locator.focus();
  assert.equal(await locator.evaluate(el => el === document.activeElement), true);
  await locator.press('Enter');
}
async function attention() {
  await keyboard(page.getByRole('button', { name: /^Work & attention/ }));
  const dialog = page.getByRole('dialog', { name: 'Work & attention', exact: true });
  await dialog.waitFor(); return dialog;
}
async function layout(label, dialog) {
  const proof = { label, width: page.viewportSize().width, documentOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    dialogOverflow: dialog ? await dialog.evaluate(el => el.scrollWidth > el.clientWidth) : false };
  layouts.push(proof); console.log('LAYOUT ' + JSON.stringify(proof));
  assert.equal(proof.documentOverflow, false); assert.equal(proof.dialogOverflow, false);
}
async function closeAttention(dialog) {
  await keyboard(dialog.getByRole('button', { name: 'Close', exact: true })); await dialog.waitFor({ state: 'hidden' });
}
async function sendPrivate(text, queued = false) {
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.waitFor(); await editor.focus();
  assert.equal(await editor.evaluate(el => el === document.activeElement), true);
  const draftPath = `/api/conversations/${encodeURIComponent('agent:' + cone.id)}/draft`;
  const longPaste = [...text].length > 10_000;
  const expectedText = text.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
  const attachment = longPaste ? waitResponse(r => new URL(r.url()).pathname === draftPath + '-attachments' && r.request().method() === 'POST') : undefined;
  // Register every matching waiter before normal editor input can start a write.
  const saved = waitResponse(r => new URL(r.url()).pathname === draftPath && r.request().method() === 'PUT' &&
    (longPaste ? Boolean(r.request().postDataJSON()?.pastedTextAttachmentId) : r.request().postDataJSON()?.text === text));
  if (longPaste) {
    await editor.evaluate((element, value) => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, text);
    const uploaded = await attachment;
    const body = await uploaded.text();
    console.log('PASTE UPLOAD ' + JSON.stringify({ status: uploaded.status(), body, requestBodyAvailable: uploaded.request().postDataBuffer() !== null }));
    assert.ok(uploaded.ok(), body); assert.equal(JSON.parse(body).size, Buffer.byteLength(expectedText));
  } else await editor.fill(text);
  const savedResponse = await saved, savedBody = await savedResponse.text();
  console.log('PRIVATE DRAFT SAVE ' + JSON.stringify({ status: savedResponse.status(), body: savedBody }));
  assert.ok(savedResponse.ok(), savedBody);
  const draft = JSON.parse(savedBody);
  if (longPaste) {
    const upload = await (await attachment).json();
    assert.equal(draft.pastedTextAttachmentId, upload.id);
    assert.equal(draft.pastedTextAttachment.id, upload.id); assert.equal(draft.text.trim(), '');
    const downloaded = await app.inject(draft.pastedTextAttachment.downloadUrl);
    console.log('DRAFT ATTACHMENT READ ' + JSON.stringify({ status: downloaded.statusCode, bytes: downloaded.rawPayload.length, sha256: sha(downloaded.rawPayload) }));
    assert.equal(downloaded.statusCode, 200); assert.equal(downloaded.rawPayload.toString('utf8'), expectedText);
    const stable = await operator(draftPath + '?' + new URLSearchParams({ ownerId: draft.ownerId }));
    assert.equal(stable.revision, draft.revision); assert.equal(stable.pastedTextAttachmentId, upload.id); assert.equal(stable.text, draft.text);
    stages.pasteTransport = { originalText: text, normalizedText: expectedText, prefix: '', separator: '', draft, upload, byteLength: Buffer.byteLength(expectedText), sha256: sha(expectedText) };
  } else assert.equal(draft.text, text);
  const accepted = waitResponse(r => r.url().endsWith(`/api/agents/${cone.id}/messages`) && r.request().method() === 'POST');
  await keyboard(page.getByRole('button', { name: queued ? 'Queue message' : 'Send message', exact: true }));
  const response = await accepted;
  console.log('PRIVATE SUBMISSION ' + JSON.stringify({ status: response.status(), body: await response.text(), request: response.request().postDataJSON() }));
  assert.equal(response.status(), 202); assert.equal(response.request().postDataJSON().text, expectedText);
  const receipt = await response.json(); assert.ok(receipt.communicationEventId); assert.ok(receipt.deliveryId);
  const runtimeId = `dispatch:${receipt.communicationEventId}:${cone.id}`;
  const communication = coordination.runtimeCommunication(runtimeId)?.payload.communication;
  assert.ok(communication); assert.equal(communication.intent, 'user_dm');
  assert.equal(communication.eventId, receipt.communicationEventId);
  if (longPaste) {
    assert.ok(communication.document?.artifactId);
    const full = await app.inject(`/api/projects/${cone.projectId}/artifacts/${communication.document.artifactId}/download`);
    console.log('ARTIFACT DOWNLOAD sendPrivate ' + JSON.stringify({ method: 'GET', url: `/api/projects/${cone.projectId}/artifacts/${communication.document.artifactId}/download`, artifactId: communication.document.artifactId, communicationEventId: communication.eventId, status: full.statusCode, body: full.body }));
    assert.equal(full.statusCode, 200); assert.equal(full.rawPayload.toString('utf8'), expectedText);
    assert.equal(sha(full.rawPayload), sha(expectedText));
  } else assert.equal(communication.text, expectedText);
  assert.deepEqual(communication.audience, { kind: 'user_agent', userId: 'local-operator', agentId: cone.id });
  const activation = store.sqlite.prepare('SELECT * FROM agent_activations WHERE id=?').get(receipt.deliveryId);
  assert.ok(activation); assert.equal(activation.agent_id, cone.id); assert.equal(activation.kind, 'human_message');
  console.log('PRIVATE INTAKE ' + JSON.stringify({ originalText: text, normalizedText: expectedText, sha256: sha(expectedText), runtimeId, receipt, communication, activation }));
  return receipt;
}
const run = async function* (options) {
  const settled = gate('adapter settlement ' + options.agentId + ':' + invocations.length);
  const identity = store.sqlite.prepare("SELECT * FROM scheduler_runs WHERE agent_id=? AND status='running'").get(options.agentId);
  try {
    assert.ok(identity); const inputs = store.getProviderInput(identity.id, true); assert.ok(inputs);
    assert.equal(inputs.promptHash, sha(inputs.exactPrompt)); assert.equal(inputs.systemPromptHash, sha(inputs.exactSystemPrompt));
    assert.equal(inputs.sourceManifest.schemaVersion, 3);
    assert.ok(inputs.sourceManifest.activationIds.length > 0 && inputs.sourceManifest.activationIds.length < 20);
    const attached = rows('scheduler_run_activations').filter(row => row.run_id === identity.id);
    const activations = attached.map(row => store.sqlite.prepare('SELECT * FROM agent_activations WHERE id=?').get(row.activation_id));
    const invocation = { runId: identity.id, agentId: options.agentId, fence: identity.fencing_token,
      argvRole: 'INERT subscription Adapter', cwd: options.cwd, tools: JSON.parse(options.environment.PONDEROSA_AGENT_TOOL_NAMES),
      bearerSha256: sha(options.environment.PONDEROSA_AGENT_MESSAGE_TOKEN), input: inputs, activations, settled: false };
    invocations.push(invocation); console.log('NORMAL ADMISSION ' + JSON.stringify(invocation));
    if (closing) { yield { type: 'turn_done' }; return; }
    const attachedIds = coordination.requestIdsAttachedToRun(identity.id, options.agentId);
    if (options.agentId === manager?.id) {
      assert.equal(attachedIds.length, 0);
      const delegated = await tool(options, 'ponderosa_coordinate', '/api/agent-coordinate', {
        idempotencyKey: 'fixture-parent-assignment', recipientAgentId: cone.id, completionMode: 'record',
        text: `Original vertical assignment, authorized by the operator's preceding private source intake. Use ${stages.sourcePath}, SHA256 ${stages.sourceSha256}. Coordinate exactly two ordinary managed children, preserve this parent Request, and synthesize their references after one scoped Decision.`,
      });
      assert.equal(delegated.requestIds.length, 1); assert.equal(delegated.joinId, undefined);
      parentRequestId = delegated.requestIds[0];
      await tool(options, 'ponderosa_message', '/api/agent-messages', { intent: 'direct_to_user', text: 'The fixture parent assignment is canonically recorded; its tracked result remains inspectable.' });
    } else if (children.some(child => child.agent.id === options.agentId)) {
      const index = children.findIndex(child => child.agent.id === options.agentId);
      assert.deepEqual(attachedIds, [children[index].requestId]);
      assert.equal(inputs.sourceManifest.communicationEventIds.includes(initialIntake.communicationEventId), false);
      if (secondIntake) assert.equal(inputs.sourceManifest.communicationEventIds.includes(secondIntake.communicationEventId), false);
      assert.equal(inputs.sourceManifest.artifactIds.includes(sourceArtifactId), false);
      stages['child' + index + 'Parked'] = identity.id;
      await (index === 0 ? firstChild : secondChild).promise;
      if (!closing) {
        const sourceBytes = await readFile(stages.sourcePath); assert.equal(sha(sourceBytes), stages.sourceSha256);
        invocation.sourceRead = { path: stages.sourcePath, bytes: sourceBytes.length, sha256: sha(sourceBytes) };
        const resultText = (`Verified bounded source ${index === 0 ? 'A' : 'B'}: ${stages.sourceSha256}.\n` + (`Disposable result ${index} evidence line.\n`).repeat(400)).trim();
        const result = await tool(options, 'ponderosa_update_request', '/api/agent-request-updates', { text: resultText });
        assert.ok(result.resultRef?.startsWith('ponderosa://artifact/'));
        results.push({ index, requestId: children[index].requestId, runId: identity.id, resultRef: result.resultRef, fullText: resultText, sha256: sha(resultText) });
      }
    } else {
      assert.equal(options.agentId, cone.id);
      if (!firstHumanConsumed && activations.some(a => a.kind === 'human_message')) {
        const artifacts = inputs.sourceManifest.artifactIds; assert.equal(artifacts.length, 1);
        sourceArtifactId = artifacts[0];
        const source = store.getProjectArtifact(cone.projectId, sourceArtifactId); assert.ok(source);
        assert.ok(store.agentCanReadProjectArtifact(cone.projectId, sourceArtifactId, cone.id));
        const downloaded = await app.inject(`/api/projects/${cone.projectId}/artifacts/${sourceArtifactId}/download`);
        console.log('ARTIFACT DOWNLOAD Adapter ' + JSON.stringify({ method: 'GET', url: `/api/projects/${cone.projectId}/artifacts/${sourceArtifactId}/download`, artifactId: sourceArtifactId, runId: identity.id, status: downloaded.statusCode, body: downloaded.body }));
        assert.equal(downloaded.statusCode, 200); assert.equal(sha(downloaded.rawPayload), sha(stages.initialText));
        stages.initialSourceArtifact = { artifact: source, access: store.getProjectArtifactAccess(cone.projectId, sourceArtifactId), bodySha256: sha(downloaded.rawPayload) };
        await tool(options, 'ponderosa_message', '/api/agent-messages', { intent: 'direct_to_user', text: 'Private source assignment received. The bounded fixture manager may establish the correlated parent route described in your assignment.' });
        firstHumanConsumed = true;
      } else if (!childJoinId && attachedIds.includes(parentRequestId)) {
        for (const index of [0, 1]) {
          const child = await tool(options, 'ponderosa_create_managed_agent', '/api/agent-spawn', {
            idempotencyKey: 'vertical-child-' + index, title: 'Vertical helper ' + index, engine: index ? 'claude' : 'codex',
            text: `Read only the explicitly shared fixture source ${stages.sourcePath}, SHA256 ${stages.sourceSha256}. Return bounded source ${index ? 'B' : 'A'} evidence through your opening Request. Do not consume unrelated private history.`,
            lifetime: { kind: 'indefinite' }, awaitResult: false,
          });
          assert.equal(child.joinId, undefined); children.push(child);
          assert.equal(child.agent.managerAgentId, cone.id); assert.equal(child.agent.conversationId, cone.conversationId);
        }
        const joined = await tool(options, 'ponderosa_coordinate', '/api/agent-coordinate', {
          idempotencyKey: 'vertical-aggregate', requests: [],
          join: { mode: 'all', wakePolicy: 'each_result', requestIds: children.map(child => child.requestId) },
        });
        childJoinId = joined.joinId; assert.ok(childJoinId);
        assert.deepEqual(JSON.parse(joinRow().continuation_request_ids_json), [parentRequestId]);
        assert.equal(coordination.getRequest(parentRequestId).state, 'waiting_dependency');
        stages.delegationRun = identity.id;
        await delegationEnd.promise;
      } else if (activations.some(a => a.kind === 'human_message') && !followupDecisionAsked) {
        assert.ok(childJoinId); assert.equal(joinRow().state, 'open');
        assert.equal(results.length, 1);
        decision = await tool(options, 'ponderosa_decision', '/api/agent-decisions', {
          idempotencyKey: 'vertical-scoped-decision', mode: 'choice', blocking: true,
          question: 'Which fixture-only synthesis should use the two recorded source results?',
          context: 'Only this disposable vertical assignment is affected. One child result is ready; the other child and aggregate Join remain open.',
          options: [{ id: 'concise', label: 'Concise synthesis' }, { id: 'detailed', label: 'Detailed synthesis' }],
        });
        assert.equal(decision.agentId, cone.id); assert.equal(decision.conversationId, cone.conversationId);
        assert.equal(decision.coordinationRunId, identity.id); assert.equal(decision.status, 'pending');
        followupDecisionAsked = true; stages.decisionRun = identity.id;
      } else if (decision && activations.some(a => JSON.parse(a.payload_json)?.decision?.id === decision.id)) {
        const actual = (await operator(`/api/decisions?agentId=${cone.id}`)).find(item => item.id === decision.id);
        assert.equal(actual.status, 'resolved'); assert.equal(actual.response.optionId, 'concise'); resolvedDecision = actual;
        assert.equal(joinRow().state, 'open'); assert.equal(coordination.getRequest(parentRequestId).state, 'waiting_dependency');
        await tool(options, 'ponderosa_message', '/api/agent-messages', { intent: 'direct_to_user', text: 'Your private follow-up and exact Decision response are consumed. Concise synthesis is selected; the second helper and original parent continuation remain open.' });
        decisionConsumed = true; stages.decisionResponseRun = identity.id;
      } else if (childJoinId && joinRow().state === 'satisfied') {
        assert.equal(decisionConsumed, true); assert.equal(results.length, 2); assert.deepEqual(attachedIds, [parentRequestId]);
        const refs = results.sort((a, b) => a.index - b.index).map(result => result.resultRef);
        for (const result of results) {
          const id = result.resultRef.slice('ponderosa://artifact/'.length);
          assert.ok(store.agentCanReadProjectArtifact(cone.projectId, id, cone.id));
          const downloaded = await app.inject(`/api/projects/${cone.projectId}/artifacts/${id}/download`);
          assert.equal(downloaded.statusCode, 200); assert.equal(sha(downloaded.rawPayload), result.sha256);
        }
        const synthesis = `Concise synthesis: both bounded source results confirm ${stages.sourceSha256}; the scoped Decision selected concise. Result A ${refs[0]}; Result B ${refs[1]}. This is the original parent Request's sole terminal handoff.`;
        await tool(options, 'ponderosa_update_request', '/api/agent-request-updates', { text: synthesis });
        synthesized = true; stages.synthesisRun = identity.id; stages.synthesis = synthesis;
      } else {
        assert.ok(childJoinId && joinRow().state === 'open', 'Only canonical partial Join progress may end without a final handoff');
        assert.ok(activations.every(a => a.kind === 'coordination_join_progress'), JSON.stringify(activations));
        assert.equal(coordination.getRequest(parentRequestId).state, 'waiting_dependency');
      }
    }
    yield { type: 'turn_done' };
  } catch (cause) {
    adapterFailures.push(cause); console.error('PRIMARY ADAPTER FAILURE', cause); throw cause;
  } finally {
    const invocation = invocations.find(item => item.runId === identity?.id); if (invocation) invocation.settled = true;
    settled.release();
  }
};

try {
  console.log('TOOLCHAIN RUNTIME ' + JSON.stringify({ node: process.version, abi: process.versions.modules,
    sqlite: store.sqlite.prepare('SELECT sqlite_version() AS version').get().version, providerModelStarts: 0 }));
  const physicalMetadata = await stat(physicalDatabasePath), runtimeMetadata = await stat(database.name);
  assert.equal(physicalMetadata.dev, runtimeMetadata.dev); assert.equal(physicalMetadata.ino, runtimeMetadata.ino);
  Object.assign(databasePaths, { device: physicalMetadata.dev, inode: physicalMetadata.ino });
  console.log('DATABASE PATHS ' + JSON.stringify(databasePaths));
  const output = path.join(root, 'web');
  await (await createRsbuild({ cwd: web, rsbuildConfig: { plugins: [pluginReact()],
    source: { entry: { index: path.join(web, 'test/pinecone-mvp-browser-entry.tsx') } },
    output: { distPath: { root: output } }, logLevel: 'error' } })).build();
  const adapter = id => ({ id, displayName: 'INERT subscription ' + id, trustedSystemPromptChannel: 'developer',
    listModels: () => [], listEfforts: () => [], seed: run, continue: run });
  app = createServer({ dataDir: path.join(root, 'data'), store, webDist: output, logger: false,
    engines: ['codex', 'claude'].map(id => ({ adapter: adapter(id), authStatus: async () => ({ authenticated: true }) })),
    communicationV3: { pollMs: 10, maxConcurrentRuns: 4 } });
  app.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.PONDEROSA_CHROMIUM_PATH, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 932 } });
  page.on('pageerror', cause => pageErrors.push(cause.message));
  const sourcePath = path.join(root, 'bounded-source.txt'), sourceBody = 'Source A: canonical coordination.\nSource B: private intake and honest partial state.\n';
  await writeFile(sourcePath, sourceBody); stages.sourcePath = sourcePath; stages.sourceSha256 = sha(sourceBody);
  const project = store.createProject({ label: 'Original Pinecone vertical proof', hostPath: root, defaultEngine: 'codex' });
  const chat = store.getConversation(project.lastConversationId);
  await page.goto(app.listeningOrigin + '/?' + new URLSearchParams({ project: project.id, chat: chat.id }));
  await keyboard(page.getByRole('button', { name: 'Create Pinecone', exact: true }));
  await page.getByLabel('Name', { exact: true }).fill('Vertical Pinecone');
  await keyboard(page.getByRole('button', { name: 'Create Pinecone', exact: true }));
  await page.getByText('Vertical Pinecone · Private Agent chat', { exact: true }).waitFor();
  cone = store.listAgents(project.id)[0]; assert.ok(cone);
  const profile = store.getPineconeProfile(cone.id); assert.ok(profile);
  assert.equal(cone.projectId, project.id); assert.equal(cone.conversationId, chat.id);
  assert.equal(profile.agentId, cone.id); assert.equal(profile.projectId, project.id); assert.equal(profile.conversationId, chat.id);
  assert.equal(profile.guidanceVersion, 1); assert.equal(profile.admissionState, 'active'); assert.equal(profile.revision, 1);
  stages.initialProfile = profile;
  assert.equal(invocations.length, 0); assert.equal(rows('runtime_communications').length, 0);
  const beforeAllow = counts();
  await keyboard(page.getByRole('button', { name: 'Helper settings', exact: true }));
  const helperDialog = page.getByRole('dialog', { name: 'Managed helpers', exact: true }); await helperDialog.waitFor();
  const allow = helperDialog.getByRole('checkbox', { name: 'Allow', exact: true }); await allow.focus(); await allow.press('Space');
  const policySaved = waitResponse(r => r.url().endsWith(`/api/agents/${cone.id}/capabilities`) && r.request().method() === 'PUT');
  await keyboard(helperDialog.getByRole('button', { name: 'Save capabilities', exact: true })); assert.equal((await policySaved).status(), 200);
  assert.deepEqual(counts(), beforeAllow); assert.equal(invocations.length, 0);
  await keyboard(helperDialog.getByRole('button', { name: 'Close', exact: true })); await helperDialog.waitFor({ state: 'hidden' });
  stages.setup = { beforeAllow, afterAllow: counts(), providerModelStarts: 0 };
  stages.initialText = (`PINECONE VERTICAL PRIVATE SOURCE ASSIGNMENT. Read only ${sourcePath}, SHA256 ${stages.sourceSha256}. You may share these exact bounded source facts with the disposable fixture manager and exactly two ordinary managed children. The fixture manager will establish the original correlated parent route; preserve it while coordinating, accept my private follow-up, ask one fixture-only Decision, then synthesize the two managed result references. ` + sourceBody.replaceAll('\n', ' | ').repeat(140)).trim();
  assert.ok(stages.initialText.length > 10_000);
  initialIntake = await sendPrivate(stages.initialText);
  await until('initial private source consumed', () => firstHumanConsumed && rows('scheduler_runs').every(r => r.status !== 'running'));
  assert.equal(rows('scheduler_runs').length, 1);
  const initialProof = capture('initial human source replied exactly once');
  assert.equal(initialProof.obligations.filter(o => o.source_activation_id === initialIntake.deliveryId && o.state === 'satisfied').length, 1);
  manager = await operator(`/api/projects/${project.id}/agents`, { title: 'Fixture parent route owner', engine: 'codex', conversationId: chat.id, idempotencyKey: 'fixture-manager' });
  await operator(`/api/agents/${manager.id}/messages`, { text: 'Establish the operator-authorized original correlated vertical parent assignment in this fixture Chat.', idempotencyKey: 'fixture-manager-intake', activeRunDelivery: 'queue' });
  await until('two normal child invocations genuinely concurrent', () => childJoinId && stages.child0Parked && stages.child1Parked);
  const concurrent = capture('two children and parent Run concurrent; one aggregate Join');
  const childRunIds = [stages.child0Parked, stages.child1Parked];
  assert.ok(childRunIds.every(id => runRow(id).status === 'running'));
  assert.notEqual(...childRunIds); assert.equal(rows('coordination_joins').length, 1); assert.equal(rows('coordination_requests').length, 3);
  assert.equal(joinRow().state, 'open'); assert.equal(synthesized, false);
  let dialog = await attention(); await dialog.getByText('Waiting for assigned work', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Results ready for review', { exact: true }).count(), 0);
  await layout('concurrent waiting', dialog); await closeAttention(dialog);
  const secondText = 'PINECONE EXACT SECOND PRIVATE TURN: choose concise synthesis only after my scoped Decision, and preserve the original parent Request and open aggregate Join.';
  secondIntake = await sendPrivate(secondText, true);
  await page.getByText(/Queued in position|Queued successfully/).first().waitFor();
  const queued = capture('second exact private turn accepted while both children execute');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(secondIntake.deliveryId).state, 'pending');
  assert.ok(childRunIds.every(id => runRow(id).status === 'running')); assert.equal(joinRow().state, 'open');
  firstChild.release();
  await until('first child canonical result', () => results.length === 1 && runRow(stages.child0Parked).status === 'completed');
  assert.equal(runRow(stages.child1Parked).status, 'running'); assert.equal(joinRow().state, 'open'); assert.equal(synthesized, false);
  await page.evaluate(() => window.pineconeMvpFixture.invalidate());
  dialog = await attention(); await dialog.getByText('Result ready', { exact: true }).waitFor(); await dialog.getByText('Waiting for assigned work', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Results ready for review', { exact: true }).count(), 0);
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 932 }); await layout('honest one-child partial', dialog); }
  capture('first child complete; second running; aggregate Join open; parent preserved');
  await closeAttention(dialog); delegationEnd.release();
  await until('normally admitted scoped Decision', () => decision && runRow(stages.decisionRun).status === 'completed');
  assert.equal(joinRow().state, 'open'); assert.equal(coordination.getRequest(parentRequestId).state, 'waiting_dependency');
  await page.evaluate(() => window.pineconeMvpFixture.invalidate());
  dialog = await attention(); await dialog.getByText(decision.question, { exact: true }).waitFor();
  await dialog.getByText('Needs your decision', { exact: true }).waitFor();
  for (const width of [320, 390, 1440]) { await page.setViewportSize({ width, height: 932 }); await layout('scoped Decision and partial results', dialog); }
  assert.ok(await dialog.getByRole('button', { name: 'Review Decision in Work', exact: true }).count());
  const decisionResponse = waitResponse(r => r.url().endsWith(`/api/decisions/${decision.id}/respond`) && r.request().method() === 'POST');
  await keyboard(dialog.getByRole('region', { name: 'Decision', exact: true }).getByRole('button', { name: 'Concise synthesis', exact: true }));
  assert.equal((await decisionResponse).status(), 200);
  await until('ordinary Decision response wake consumes correct input', () => decisionConsumed && runRow(stages.decisionResponseRun).status === 'completed');
  capture('Decision resolved; exact second private intake consumed; original Join and parent remain open');
  await closeAttention(dialog); secondChild.release();
  await until('ordinary final Join wake and sole parent handoff', () => synthesized && rows('scheduler_runs').every(r => r.status !== 'running'));
  await page.evaluate(() => window.pineconeMvpFixture.invalidate());
  dialog = await attention(); await dialog.getByText('Results ready for review', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Result ready', { exact: true }).count(), 2);
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 932 }); await layout('two terminal results and synthesis', dialog); }
  assert.ok(await dialog.getByRole('button', { name: 'Review Work', exact: true }).count());
  assert.ok(await dialog.getByRole('button', { name: 'Files & Results', exact: true }).count());
  await closeAttention(dialog);
  const final = capture('canonical final settled topology');
  assert.equal(final.requests.length, 3); assert.ok(final.requests.every(r => r.state === 'completed'));
  assert.equal(final.joins.length, 1); assert.equal(final.joins[0].state, 'satisfied');
  assert.deepEqual(JSON.parse(final.joins[0].continuation_request_ids_json), [parentRequestId]);
  const terminalParent = final.updates.filter(u => u.request_id === parentRequestId && ['completed', 'blocked', 'failed', 'outcome_unknown', 'cancelled'].includes(u.kind));
  assert.equal(terminalParent.length, 1); assert.equal(terminalParent[0].kind, 'completed'); assert.equal(terminalParent[0].actor_id, cone.id);
  assert.equal(JSON.parse(terminalParent[0].payload_json).text, stages.synthesis);
  assert.ok(final.runs.every(r => r.status === 'completed' && r.terminal_at));
  assert.ok(final.activations.every(a => a.state === 'consumed' && a.consumed_at));
  assert.ok(final.injections.every(i => i.state === 'acknowledged' && i.acknowledged_at));
  assert.ok(final.attachments.every(a => a.consumed_at));
  assert.ok(final.obligations.every(o => ['satisfied', 'superseded'].includes(o.state) && o.attempt_count === 0 && !o.recovery_activation_id));
  for (const intake of [initialIntake, secondIntake]) {
    const obligations = final.obligations.filter(o => o.source_activation_id === intake.deliveryId);
    const satisfiedIds = [...new Set(obligations.map(o => o.satisfied_communication_id).filter(Boolean))];
    assert.equal(satisfiedIds.length, 1, 'Each original human reply is canonically satisfied once');
  }
  const decisions = await operator(`/api/decisions?agentId=${cone.id}`);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].status, 'resolved');
  assert.equal(final.updates.some(u => ['cancelled', 'outcome_unknown', 'failed'].includes(u.kind)), false);
  assert.equal(store.readCommunicationEvents(project.id).some(c => c.intent === 'broadcast'), false);
  assert.deepEqual(pageErrors, []); assert.deepEqual(adapterFailures, []);
  console.log('PASS ORIGINAL 11B ' + JSON.stringify({ stages, initialIntake, secondIntake, parentRequestId, childJoinId,
    children, sourceArtifactId, decision: resolvedDecision, results, layouts,
    counts: counts(), normalAdapterInvocations: invocations.length, providerModelStarts: 0 }));
} catch (cause) {
  primaryFailure = cause; console.error('PRIMARY VERTICAL FAILURE', cause);
} finally {
  closing = true; const teardownFailures = []; let browserClosed = false, serverClosed = false, storeClosed = false;
  let residualReadSucceeded = false, residualReaderClosed = false, residualReader;
  try { app?.prepareForShutdown(); } catch (cause) { teardownFailures.push(cause); }
  for (const owner of [delegationEnd, firstChild, secondChild]) owner.release();
  for (const owner of gates.filter(g => g.label.startsWith('adapter settlement '))) {
    try { await owner.promise; } catch (cause) { teardownFailures.push(cause); }
  }
  const responseOutcomes = await Promise.all(responseOwners);
  for (const outcome of responseOutcomes) if (outcome.cause) teardownFailures.push(outcome.cause);
  try { await browser?.close(); browserClosed = !browser?.isConnected(); } catch (cause) { teardownFailures.push(cause); }
  try { if (app) await app.close(); serverClosed = true; } catch (cause) { teardownFailures.push(cause); }
  const storeClosedByServer = !database.open;
  try { store.close(); storeClosed = !database.open; } catch (cause) { teardownFailures.push(cause); }
  let finalState;
  try {
    if (app) assert.equal(storeClosedByServer, true, 'Normal server shutdown must close its injected store');
    assert.equal(database.open, false, 'Owned runtime store must close before the read-only terminal inspection');
    databasePaths.postCloseBytes = (await stat(physicalDatabasePath)).size;
    databasePaths.postCloseSha256 = sha(await readFile(physicalDatabasePath));
    residualReader = new Database(physicalDatabasePath, { readonly: true, fileMustExist: true });
    assert.equal(residualReader.readonly, true);
    finalState = capture('post-close canonical residual state', residualReader); residualReadSucceeded = true;
  } catch (cause) { teardownFailures.push(cause); }
  finally {
    try { if (residualReader) { await residualReader.close(); residualReaderClosed = !residualReader.open;
      assert.equal(sha(await readFile(physicalDatabasePath)), databasePaths.postCloseSha256); } }
    catch (cause) { teardownFailures.push(cause); }
  }
  const liveInvocations = invocations.filter(i => !i.settled);
  const residual = residualReadSucceeded ? finalState.activations.filter(a => ['pending', 'retry_pending', 'attached', 'leased'].includes(a.state)) : null;
  const proof = { root, databasePaths, browserClosed, serverClosed, storeClosed, storeClosedByServer, residualReadSucceeded, residualReaderClosed, sockets: sockets.size,
    gates: gates.map(({ label, released, releaseCount }) => ({ label, released, releaseCount })),
    adapterInvocations: invocations.length, liveInvocations: liveInvocations.length, residualActivationIds: residual?.map(a => a.id) ?? null,
    responseOwners: responseOwners.length, responseFailures: responseOutcomes.filter(o => o.cause).length,
    pageErrors, teardownFailures: teardownFailures.map(cause => String(cause)), providerModelStarts: 0,
    firstCause: primaryFailure ? String(primaryFailure) : null, rootsRemoved: false };
  if (!primaryFailure && !teardownFailures.length && !liveInvocations.length && residualReadSucceeded && residualReaderClosed && !residual.length && !sockets.size) {
    try { await rm(root, { recursive: true }); proof.rootsRemoved = true; }
    catch (cause) { teardownFailures.push(cause); proof.teardownFailures.push(String(cause)); }
  }
  console.log('SETTLED ' + JSON.stringify(proof));
  if (primaryFailure) throw primaryFailure;
  if (teardownFailures.length || liveInvocations.length || !residualReadSucceeded || !residualReaderClosed || residual?.length || sockets.size) throw new AggregateError(teardownFailures, 'Vertical fixture settlement incomplete');
}
