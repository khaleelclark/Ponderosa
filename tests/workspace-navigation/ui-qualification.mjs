// Maintained manual UI fixture for approved stop/recovery, file/transcript and roster checks. Run after build.
// Real web assets/API handlers, controlled provider, synthetic state, loopback only.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { until } from '../shared/fixture.mjs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { fixture } from '../shared/fixture.mjs';

const web = path.resolve(fileURLToPath(new URL('../../apps/web/dist/', import.meta.url)));
const f = await fixture({ diagnosticProvider: true }), requests = [];
let failHome = false, failChunks = false, failStop = false, closing, stopFixture, preparingStop, reviewFixture, preparingReview, rosterFixture, preparingRoster;
const chat = await f.createChat('Isolated UI regression qualification');
await f.createAgent(chat, 'Home cache survivor');
const apiOrigin = await f.listen();
const route = `/projects/${chat.projectId}/chats/${chat.id}`;
// Approved check 37: all resources belong to this disposable fixture. The
// unrelated Chat supplies a positive scope control; no real provider is used.
async function prepareStopFixture() {
  if (stopFixture) return stopFixture;
  return preparingStop ??= (async () => {
    const parent = await f.createIdleAgent(chat, 'Scoped Stop parent');
    const child = await f.createIdleAgent(chat, 'Scoped Stop child', parent.id);
    const otherChat = await f.createChat('Unrelated Stop scope');
    const unrelated = await f.createIdleAgent(otherChat, 'Unrelated held survivor');
    await f.hold(parent.id); await f.hold(child.id); await f.hold(unrelated.id);
    return stopFixture = { parentId: parent.id, childId: child.id, unrelatedId: unrelated.id, otherChatId: otherChat.id };
  })();
}
// Approved manual checks 44/65/67/73/74/83/107: only owned synthetic data.
async function prepareReviewFixture() {
  if (reviewFixture) return reviewFixture;
  return preparingReview ??= (async () => {
    const author = await f.createIdleAgent(chat, 'UI file author');
    const peer = await f.createIdleAgent(chat, 'UI Team recipient');
    const retained = 'Retained UI receipt: café — 資料\n';
    const current = 'Current UI receipt changed after capture\n';
    const diff = 'diff --git a/selected.txt b/selected.txt\n--- a/selected.txt\n+++ b/selected.txt\n@@ -1,2 +1,2 @@\n context\n-before 😀\n+after 😀\n';
    await writeFile(path.join(chat.workingDirectory, 'receipt.txt'), retained);
    await writeFile(path.join(chat.workingDirectory, 'change.patch'), diff);
    await writeFile(path.join(chat.workingDirectory, 'selected.txt'), 'context\nafter 😀\n');
    const session = await f.hold(author.id);
    const captured = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'receipt.txt' })).artifact;
    const patchCapture = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'change.patch' })).artifact;
    session.events.push({ type: 'file_change', path: 'selected.txt', kind: 'edit', diff });
    session.events.push({ type: 'test_result', passed: true, summary: 'Synthetic UI result report — not a product qualification result' });
    const artifacts = await until(async () => {
      const detail = await f.detail(author.id);
      return detail.changedFiles.some(item => item.path === 'selected.txt') && detail.artifacts.some(item => item.kind === 'test_report') ? detail.artifacts : false;
    }, 'owned diff/result projections');
    await writeFile(path.join(chat.workingDirectory, 'receipt.txt'), current);
    await writeFile(path.join(chat.workingDirectory, 'selected.txt'), 'Current selected file changed after its recorded diff\n');
    const teamMarker = `UI_TEAM_${randomUUID()}`, mainMarker = `UI_MAIN_${randomUUID()}`;
    f.plans.set(peer.id, [{ hold: true }]);
    const collaboration = f.ok(await f.tool(session, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [peer.id], urgency: 'urgent', text: teamMarker }));
    const shared = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: `#${author.handle} ${mainMarker}`, idempotencyKey: randomUUID(), recipientAgentMentions: [{ agentId: author.id, projectId: chat.projectId, handle: author.handle, currentHandle: author.handle, currentTitle: author.title }] }));
    return reviewFixture = { authorId: author.id, peerId: peer.id, retained, current, diff, capture: captured, patchCapture, artifacts, teamMarker, mainMarker, collaboration, shared };
  })();
}
async function prepareRosterFixture() {
  if (rosterFixture) return rosterFixture;
  return preparingRoster ??= (async () => {
    const members = [];
    for (let i = 1; i <= 120; i++) {
      const title = `UI roster ${String(i).padStart(3, '0')}`;
      members.push(await f.createIdleAgent(chat, title, i > 1 && i <= 31 ? members[0].id : undefined));
    }
    return rosterFixture = { members: members.map(agent => ({ id: agent.id, title: agent.title, managerAgentId: agent.managerAgentId })) };
  })();
}
async function stopDetails() {
  if (!stopFixture) return undefined;
  return Object.fromEntries(await Promise.all(['parentId', 'childId', 'unrelatedId'].map(async key => {
    const detail = await f.detail(stopFixture[key]);
    return [key, { agentId: detail.agent.id, runs: detail.runs.map(run => ({ id: run.id, status: run.status })) }];
  })));
}
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/__qualification/state') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ fixtureRoot: f.root, route, failHome, failChunks, failStop, stopFixture, reviewFixture, rosterFixture, stopDetails: await stopDetails(), providerProbes: f.providerProbes, requests })); return;
    }
    if (url.pathname === '/api/__qualification/control' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const control = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof control.failHome === 'boolean') failHome = control.failHome;
      if (typeof control.failChunks === 'boolean') failChunks = control.failChunks;
      if (control.prepareStop === true) await prepareStopFixture();
      if (control.prepareReview === true) await prepareReviewFixture();
      if (control.prepareRoster === true) await prepareRosterFixture();
      if (typeof control.failStop === 'boolean') failStop = control.failStop;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ failHome, failChunks, failStop, stopFixture, reviewFixture, rosterFixture }));
      if (control.finish === true) setImmediate(() => void shutdown());
      return;
    }
    if (url.pathname === '/api/__qualification') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Owned UI regression controls</title><h1>Isolated regression fixture</h1><p>All data and provider processes are synthetic. Actual API and SSE are forwarded. Service workers are disabled in this fixture so asset faults cannot be hidden by precaching. PWA behavior is not qualified here.</p><a href="${route}">Open fixture Chat</a><p><button onclick="set({failHome:true})">Fail Home refresh</button><button onclick="set({failHome:false})">Restore Home refresh</button><button onclick="set({failChunks:true})">Fail lazy route assets</button><button onclick="set({failChunks:false})">Restore lazy route assets</button><button onclick="set({prepareStop:true})">Prepare scoped Stop All</button><button onclick="set({failStop:true})">Refuse child stop</button><button onclick="set({failStop:false})">Restore child stop</button><button onclick="set({prepareReview:true})">Prepare file and transcript review</button><button onclick="set({prepareRoster:true})">Prepare long Agent roster</button><button onclick="set({finish:true})">Finish owned fixture</button></p><pre id="state"></pre><script>async function set(x){await fetch('/api/__qualification/control',{method:'POST',body:JSON.stringify(x)});await update()}async function update(){document.getElementById('state').textContent=JSON.stringify(await(await fetch('/api/__qualification/state')).json(),null,2)}update()</script>`); return;
    }
    // Forward actual SSE so refresh failure is not confused with a dead stream.
    if (url.pathname.startsWith('/api/') && (request.headers.accept ?? '').includes('text/event-stream')) {
      const abort = new AbortController(); response.on('close', () => abort.abort());
      const upstream = await fetch(apiOrigin + request.url, { headers: { accept: 'text/event-stream' }, signal: abort.signal });
      response.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const body = Readable.fromWeb(upstream.body); body.on('error', () => response.destroy()); body.pipe(response); return;
    }
    if (url.pathname === '/sw.js') { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end('Service worker disabled only in this fixture'); return; }
    const homeQuery = url.pathname === '/api/workspace/directory/agent' && (url.searchParams.get('active') === 'true' || url.searchParams.get('outcomes') === 'true');
    const asset = !url.pathname.startsWith('/api/') && url.pathname.includes('/async/') && url.pathname.endsWith('.js');
    if ((failHome && homeQuery) || (failChunks && asset)) {
      requests.push({ path: request.url, method: request.method, status: 503, failure: homeQuery ? 'home' : 'lazy_asset' });
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: 'Deliberate isolated qualification failure' })); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), contentType = request.headers['content-type'] ?? '';
      const payload = bytes.length ? (contentType.includes('application/json') ? JSON.parse(bytes.toString()) : bytes) : undefined;
      if (failStop && stopFixture && request.method === 'POST' && url.pathname === `/api/agents/${stopFixture.childId}/cancel`) {
        requests.push({ path: request.url, method: request.method, status: 503, failure: 'owned_child_stop', payload });
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'Controlled child cancellation refusal' })); return;
      }
      const result = await f.api(request.method, request.url, payload, request.headers);
      requests.push({ path: request.url, method: request.method, status: result.status, ...(url.pathname.endsWith('/cancel') ? { payload } : {}) });
      response.writeHead(result.status, result.headers); response.end(result.rawBody); return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filename = path.resolve(web, relative);
    if (filename !== web && !filename.startsWith(web + path.sep)) throw new Error('Fixture refused an unsafe asset path');
    let bytes;
    try { bytes = await readFile(filename); response.setHeader('Content-Type', mime[path.extname(filename)] ?? 'application/octet-stream'); }
    catch (error) {
      if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
      if (path.extname(filename)) { response.writeHead(404); response.end('Fixture asset not found'); return; }
      bytes = await readFile(path.join(web, 'index.html')); response.setHeader('Content-Type', 'text/html');
    }
    response.setHeader('Cache-Control', 'no-store'); response.end(bytes);
  } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
async function shutdown() {
  return closing ??= (async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await f.dispose(false); // Preserve manual evidence until its owner reviews it.
    process.stdout.write(JSON.stringify({ stopped: true, retainedFixtureRoot: f.root, requests }) + '\n');
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown());
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
process.stdout.write(JSON.stringify({ controls: `http://127.0.0.1:${server.address().port}/api/__qualification`, chat: `http://127.0.0.1:${server.address().port}${route}`, fixtureRoot: f.root }) + '\n');
