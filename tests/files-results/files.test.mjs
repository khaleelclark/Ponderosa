import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import sharp from 'sharp';
import { AgentStore, managedArtifactContentPath } from '@ponderosa/agents';
import { AgentWorkingCopyService } from '../../apps/server/dist/agent-working-copy-service.js';
import { withFixture, runtimeAttachmentPaths, fixtureTestOptions as options } from '../shared/fixture.mjs';

const exec = promisify(execFile);
const upload = async (f, agent, name, bytes, media = 'text/plain') => f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, bytes, { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': name, 'x-ponderosa-media-type': media }));

test('imported deliverable and checksum links retain captured bytes after reload and fail closed outside their project', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Download links'), foreign = await f.createChat('Other project');
  const agent = await f.createIdleAgent(chat, 'Publisher'), session = await f.hold(agent.id);
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  const files = [['résultat 100%.bin', bytes], ['SHA256SUMS', Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  résultat 100%.bin\n`)]];
  const imported = [];
  for (const [name, body] of files) {
    const file = path.join(chat.workingDirectory, name);
    await writeFile(file, body);
    const { artifact } = f.ok(await f.tool(session, 'ponderosa_import_file', { path: name }));
    imported.push(artifact);
    await rm(file);
  }
  const text = `[Deliverable](ponderosa://artifact/${imported[0].id})\n[Checksum](${imported[1].downloadUrl})`;
  f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text, artifactIds: imported.map(x => x.id) }));
  await f.reopen();
  assert.ok((await f.detail(agent.id)).messages.some(message => message.text === text), 'Reload changed authored Markdown');
  for (const [i, artifact] of imported.entries()) {
    const response = await f.api('GET', artifact.downloadUrl);
    f.ok(response);
    assert.deepEqual(response.rawBody, files[i][1]);
    assert.equal(createHash('sha256').update(response.rawBody).digest('hex'), artifact.sha256);
    assert.match(response.headers['content-disposition'], /^attachment/);
    assert.ok(response.headers['content-disposition'].includes(encodeURIComponent(files[i][0])));
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal((await f.api('GET', `/api/projects/${foreign.projectId}/artifacts/${artifact.id}/download`)).status, 404);
  }
  assert.equal((await f.api('GET', `/api/projects/${chat.projectId}/artifacts/missing/download`)).status, 404);
  // Authoritative captured storage only: no fallback to the mutable host path.
  await writeFile(path.join(chat.workingDirectory, files[0][0]), 'Different mutable host bytes');
  await rm(managedArtifactContentPath(f.dataDir, chat.projectId, imported[0].id));
  assert.equal((await f.api('GET', imported[0].downloadUrl)).status, 404);
  await writeFile(managedArtifactContentPath(f.dataDir, chat.projectId, imported[1].id), 'corrupted');
  assert.equal((await f.api('GET', imported[1].downloadUrl)).status, 404);
}));

test('F15: real Agent, Chat and draft uploads retain Unicode and literal percent names through storage and restart', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Filename round trips'), agent = await f.createIdleAgent(chat, 'Filename reader');
  const ownerId = 'filename-browser', body = Buffer.from('Exact filename fixture bytes'), uploaded = [];
  for (const url of [`/api/agents/${agent.id}/attachments`, `/api/conversations/${chat.id}/attachments`, `/api/conversations/${chat.id}/draft-attachments`]) {
    for (const name of ['plain.txt', 'space in name.txt', '100% ready %20 literal.txt', '普通の資料—résumé📎.txt']) {
      const asset = f.ok(await f.api('POST', url, body, {
        'content-type': 'application/x-ponderosa-attachment', 'x-ponderosa-media-type': 'text/plain',
        'x-ponderosa-filename': encodeURIComponent(name), 'x-ponderosa-draft-owner': ownerId,
      }));
      assert.equal(asset.name, name);
      uploaded.push({ asset, name });
    }
  }
  await f.reopen();
  for (const { asset, name } of uploaded) {
    const download = await f.api('GET', asset.downloadUrl);
    f.ok(download);
    assert.deepEqual(download.rawBody, body);
    assert.ok(download.headers['content-disposition'].includes(encodeURIComponent(name)), 'Stored download name changed');
  }
}));

test('check 8: multi-recipient DM supplies only each recipient’s explicitly selected attachment bytes', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Recipient files'), a = await f.createIdleAgent(chat, 'Reader A'), b = await f.createIdleAgent(chat, 'Reader B'), unrelated = await f.createIdleAgent(chat, 'Unrelated');
  const contents = [a, b].map(() => `Private file ${randomUUID()}`), assets = [];
  for (const [i, agent] of [a, b].entries()) assets.push(await upload(f, agent, `private-${i}.txt`, Buffer.from(contents[i])));
  for (const [i, agent] of [a, b].entries()) f.plans.set(agent.id, [{ run: async (session, input, turn) => {
    const prompt = JSON.stringify({ input, history: turn.history });
    assert.ok(!prompt.includes(contents[i]), 'Answer was supplied in prompt');
    const paths = runtimeAttachmentPaths(turn);
    assert.ok(paths.length); const texts = await Promise.all(paths.map(p => readFile(p, 'utf8')));
    assert.ok(texts.includes(contents[i])); assert.ok(!texts.includes(contents[1 - i]));
    f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: `Read ${contents[i]}` }));
  } }]);
  const request = { text: 'Read only your supplied file', idempotencyKey: randomUUID(), recipients: [a, b].map((agent, i) => ({ agentId: agent.id, attachmentIds: [assets[i].id] })) };
  const first = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, request));
  const replay = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, request));
  assert.ok(first.messageId); assert.equal(replay.messageId, first.messageId);
  for (const [i, agent] of [a, b].entries()) assert.ok((await f.settled(agent.id)).messages.some(x => x.text.includes(contents[i])));
  assert.equal((await f.detail(unrelated.id)).runs.length, 0);
  assert.equal(f.turns.filter(x => [a.id, b.id].includes(x.agentId)).length, 2);
}));

test('check 19: uploaded PNG retains exact original bytes/hash and malformed image refusal leaves other attachments readable', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Photo fixture'), agent = await f.createIdleAgent(chat, 'Photo reader');
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#aabbcc' } }).png().toBuffer();
  const asset = await upload(f, agent, 'fixture.png', png, 'image/png');
  assert.equal(asset.sha256, createHash('sha256').update(png).digest('hex')); assert.equal(asset.size, png.length);
  const downloaded = await f.api('GET', asset.downloadUrl); f.ok(downloaded); assert.deepEqual(downloaded.rawBody, png);
  assert.ok((await f.api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from('not an image'), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'broken.png', 'x-ponderosa-media-type': 'image/png' })).status >= 400);
  assert.deepEqual((await f.api('GET', asset.downloadUrl)).rawBody, png);
}));

test('check 20: a long UTF-8 attachment reaches the exact reader without prompt substitution or truncation', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Long text fixture'), agent = await f.createIdleAgent(chat, 'Long text reader');
  const content = `BEGIN-${randomUUID()}\n` + 'Unicode 😀 line\n'.repeat(5000) + `END-${randomUUID()}`;
  const asset = await upload(f, agent, 'long-paste.txt', Buffer.from(content)); let read;
  f.plans.set(agent.id, [{ run: async (session, input, turn) => {
    const prompt = JSON.stringify({ input, history: turn.history }); assert.ok(!prompt.includes(content));
    const suppliedPaths = runtimeAttachmentPaths(turn);
    const supplied = suppliedPaths.length ? suppliedPaths : null; assert.ok(supplied);
    read = await readFile(supplied[0], 'utf8'); assert.equal(read, content);
    f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: `Read hash ${createHash('sha256').update(read).digest('hex')}` }));
  } }]);
  await f.send(agent.id, 'Read the supplied long text', { attachmentIds: [asset.id] }); await f.settled(agent.id); assert.equal(read, content);
}));

test('checks 67, 74: captured artifact bytes stay distinct from later working-folder contents and preserve attribution', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Retained versus live'), agent = await f.createIdleAgent(chat, 'Artifact author');
  const file = path.join(chat.workingDirectory, 'result.txt'), original = `Captured ${randomUUID()}`, newer = `Working ${randomUUID()}`;
  await writeFile(file, original); const session = await f.hold(agent.id);
  const imported = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'result.txt' }));
  await writeFile(file, newer);
  assert.equal((await f.api('GET', imported.artifact.downloadUrl)).body, original);
  const current = f.ok(await f.api('GET', `/api/conversations/${chat.id}/files?path=result.txt`)); assert.equal(current.content, newer);
  const artifacts = (await f.detail(agent.id)).artifacts.filter(x => x.id === imported.artifact.id);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].agentId, agent.id);
}));

test('checks 72, 75: HTML and large/unsupported working files retain safe byte-exact downloads', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Download fallbacks');
  const html = '<!doctype html><script>globalThis.fixtureExecution=true</script><p>fixture</p>', large = 'x'.repeat(2 * 1024 * 1024 + 10), unsupported = Buffer.from([0, 255, 1, 128]);
  for (const [name, body] of [['page.html', html], ['large.txt', large], ['unknown.bin', unsupported]]) {
    await writeFile(path.join(chat.workingDirectory, name), body);
    const info = f.ok(await f.api('GET', `/api/projects/${chat.projectId}/workspace-files/view-info?conversationId=${chat.id}&path=${name}`));
    assert.ok(info.downloadUrl); const response = await f.api('GET', info.downloadUrl); f.ok(response);
    assert.deepEqual(response.rawBody, Buffer.from(body)); assert.match(response.headers['content-disposition'], /^attachment/); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    if (name === 'large.txt') assert.equal(info.truncated, true);
    if (name === 'unknown.bin') assert.equal(info.previewable, false);
  }
}));

test('checks 76, 77: separate Git copy isolates source edits and refuses dirty/untracked cleanup until preserved', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Owned Git source'), agent = await f.createIdleAgent(chat, 'Separate worker');
  const source = chat.workingDirectory;
  const git = (cwd, args) => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  await git(source, ['init', '-b', 'main']);
  // Keep this owned byte-exact fixture independent of host CRLF conversion.
  await git(source, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(source, 'tracked.txt'), 'Original source\n');
  await git(source, ['add', 'tracked.txt']); await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'Owned fixture initial state']);
  const separate = f.ok(await f.api('PATCH', `/api/agents/${agent.id}`, { workingCopyMode: 'separate_git' }));
  const copy = separate.workingCopy.rootPath; assert.ok(copy && copy !== source);
  await writeFile(path.join(copy, 'tracked.txt'), 'Changed in copy\n'); await writeFile(path.join(copy, 'untracked.txt'), 'Keep this untracked work');
  const status = f.ok(await f.api('GET', `/api/agents/${agent.id}/workspace`)); assert.equal(status.isGitRepository, true); assert.ok(status.branch);
  assert.ok(status.changes.some(x => x.path === 'tracked.txt')); assert.ok(status.changes.some(x => x.path === 'untracked.txt' && x.untracked));
  assert.equal(await readFile(path.join(source, 'tracked.txt'), 'utf8'), 'Original source\n');
  assert.equal((await f.api('PATCH', `/api/agents/${agent.id}`, { workingCopyMode: 'shared' })).status, 409);
  assert.equal(await readFile(path.join(copy, 'untracked.txt'), 'utf8'), 'Keep this untracked work');
  const review = f.ok(await f.api('GET', `/api/agents/${agent.id}/workspace/file?path=tracked.txt`)); assert.match(review.diff, /Changed in copy/);
  // Preserve the disposable edits outside the copy before restoring its clean state.
  await writeFile(path.join(f.root, 'preserved-tracked.txt'), await readFile(path.join(copy, 'tracked.txt')));
  await writeFile(path.join(f.root, 'preserved-untracked.txt'), await readFile(path.join(copy, 'untracked.txt')));
  await writeFile(path.join(copy, 'tracked.txt'), 'Original source\n'); await rm(path.join(copy, 'untracked.txt'));
  const shared = f.ok(await f.api('PATCH', `/api/agents/${agent.id}`, { workingCopyMode: 'shared' })); assert.equal(shared.workingCopy.mode, 'shared');
  await assert.rejects(access(copy), { code: 'ENOENT' }); assert.equal(await readFile(path.join(source, 'tracked.txt'), 'utf8'), 'Original source\n');
}));

test('working-folder diff and patch previews expose safe UTF-8 text with exact downloads and bounded fallback', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Diff preview MIME');
  const diff = '--- a/owned.txt\n+++ b/owned.txt\n@@ -1 +1 @@\n-before 😀\n+after 東京\n';
  for (const [name, bytes, readable] of [
    ['owned.diff', Buffer.from(diff), true], ['owned.PATCH', Buffer.from(diff), true], ['empty.diff', Buffer.alloc(0), true],
    ['large.diff', Buffer.from('x'.repeat(2 * 1024 * 1024 + 10)), false], ['invalid.patch', Buffer.from([0xff, 0xfe, 0x80]), false],
  ]) {
    await writeFile(path.join(chat.workingDirectory, name), bytes);
    const info = f.ok(await f.api('GET', `/api/projects/${chat.projectId}/workspace-files/view-info?conversationId=${chat.id}&path=${name}`));
    assert.equal(info.mediaType, 'text/x-diff');
    assert.equal(info.previewable, false, 'Diff text is rendered as data, not an active document');
    assert.equal(info.text, readable ? bytes.toString('utf8') : undefined);
    assert.equal(info.truncated, !readable);
    assert.ok(info.downloadUrl);
    assert.deepEqual((await f.api('GET', info.downloadUrl)).rawBody, bytes);
  }
}));

const { validMotionVideo, validAvif } = await import('../../apps/server/dist/image-containers.js');
const box = (type, content, wide = false) => {
  const header = Buffer.alloc(wide ? 16 : 8); header.writeUInt32BE(wide ? 1 : header.length + content.length); header.write(type, 4, 'latin1');
  if (wide) header.writeBigUInt64BE(BigInt(header.length + content.length), 8);
  return Buffer.concat([header, content]);
};
function motionVideo(count, { wide = false, major = 'isom', last = 'isom' } = {}) {
  const brands = Buffer.alloc(8 + count * 4, 'zzzz'); brands.write(major, 0, 'latin1'); brands.writeUInt32BE(0, 4);
  if (count) brands.write(last, brands.length - 4, 'latin1');
  const handler = Buffer.alloc(24); handler.write('vide', 8);
  return Buffer.concat([box('ftyp', brands, wide), box('moov', box('trak', box('mdia', box('hdlr', handler)))), box('mdat', Buffer.from([1]))]);
}
function motionPhoto(jpeg, video) {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${video.length}"/></rdf:RDF></x:xmpmeta>`;
  const payload = Buffer.from('http://ns.adobe.com/xap/1.0/\0' + xml), segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1); segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2), video]);
}
test('Motion Photo brand budget accepts ordinary, near and exact boundaries including extended headers', () => {
  for (const wide of [false, true]) for (const count of [0, 1, 63, 64]) {
    const body = motionVideo(count, { wide }), slice = body.subarray.bind(body); let brandReads = 0;
    body.subarray = (start, end) => { if (start >= (wide ? 16 : 8) && start < (wide ? 16 : 8) + 8 + count * 4 && end - start === 4) brandReads++; return slice(start, end); };
    assert.equal(validMotionVideo(body), true); assert.equal(brandReads, count + 1);
    if (count) assert.equal(validMotionVideo(motionVideo(count, { wide, major: 'zzzz', last: 'qt  ' })), true);
  }
  assert.equal(validMotionVideo(motionVideo(64, { major: 'zzzz', last: 'zzzz' })), false);
  const minorOnly = motionVideo(0, { major: 'zzzz' }); minorOnly.write('isom', 12);
  assert.equal(validMotionVideo(minorOnly), false, 'Minor version cannot authorize a video brand');
  const avif = Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avif', 'latin1')), box('meta', Buffer.alloc(4)), box('mdat', Buffer.from([1]))]);
  assert.equal(validAvif(avif, 4096), true);
});
test('Motion Photo rejects excessive brands before scanning and retains malformed-container checks', () => {
  for (const wide of [false, true]) for (const count of [65, 250_000]) {
    const body = motionVideo(count, { wide }), slice = body.subarray.bind(body); let brandReads = 0;
    body.subarray = (start, end) => { if (start >= (wide ? 16 : 8) && start < (wide ? 16 : 8) + 8 + count * 4 && end - start === 4) brandReads++; return slice(start, end); };
    assert.equal(validMotionVideo(body), false); assert.equal(brandReads, 0, 'Oversized region was scanned before rejection');
  }
  const valid = motionVideo(64);
  for (const malformed of [valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), box('ftyp', Buffer.alloc(9)), box('ftyp', Buffer.alloc(4)), Buffer.concat([valid.subarray(0, 272), valid])]) {
    assert.equal(validMotionVideo(malformed), false);
  }
  const tooLarge = Buffer.from(valid); tooLarge.writeUInt32BE(valid.length + 1); assert.equal(validMotionVideo(tooLarge), false);
});
test('Motion Photo upload retains accepted exact bytes and refuses an oversized brand table without harming prior uploads', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Motion brand boundary'), agent = await f.createIdleAgent(chat, 'Photo reader');
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#aabbcc' } }).jpeg().toBuffer();
  const accepted = [];
  for (const [name, body] of [['ordinary.jpg', jpeg], ['motion.jpg', motionPhoto(jpeg, motionVideo(64))]]) {
    const asset = await upload(f, agent, name, body, 'image/jpeg');
    assert.equal(asset.sha256, createHash('sha256').update(body).digest('hex')); accepted.push([asset, body]);
  }
  const refused = await f.api('POST', `/api/agents/${agent.id}/attachments`, motionPhoto(jpeg, motionVideo(65)), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'over-budget.jpg', 'x-ponderosa-media-type': 'image/jpeg' });
  assert.equal(refused.status, 415);
  for (const [asset, body] of accepted) assert.deepEqual((await f.api('GET', asset.downloadUrl)).rawBody, body);
}));

test('rejected and no-op working-copy changes preserve compatible context; teardown errors cannot be swallowed as missing paths',options,async t=>{
 let store;await withFixture(t,async f=>{
  const chat=await f.createChat('Working-copy continuity'),agent=await f.createAgent(chat,'Continuity reader'),session=f.sessions.get(agent.id),before=store.getAgent(agent.id).workingCopy;
  assert.equal((await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'separate_git'})).status,409);
  assert.equal(JSON.stringify(store.getAgent(agent.id).workingCopy),JSON.stringify(before));
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{workingCopyMode:'shared'}));assert.equal(JSON.stringify(store.getAgent(agent.id).workingCopy),JSON.stringify(before));
  const previous=(await f.detail(agent.id)).runs.map(r=>r.id);await f.send(agent.id,'Continue after rejected folder change');await f.settled(agent.id,previous);assert.equal(f.turns.at(-1).sessionId,session.engineAgentId);
  const source=chat.workingDirectory;await exec('git',['init','-b','main'],{cwd:source});await writeFile(path.join(source,'tracked'),'Keep');await exec('git',['add','tracked'],{cwd:source});await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','Owned baseline'],{cwd:source});
  const service=new AgentWorkingCopyService(f.dataDir,store),release=service.beginModeChange(agent.id);let called=0;
  try{await assert.rejects(service.setMode(store.getAgent(agent.id),store.getProject(chat.projectId),'separate_git',async()=>{called++;throw Object.assign(Error('Owned teardown failure'),{code:'ENOENT'})}),/Owned teardown failure/);}finally{release()}
  assert.equal(called,1);assert.equal(JSON.stringify(store.getAgent(agent.id).workingCopy),JSON.stringify(before));
 },{storeFactory:root=>store=new AgentStore(root)});
});

test('canonical history reuses authorized artifact full-file references without treating the inline preview as the document',options,async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Retained document history'),agent=await f.createIdleAgent(chat,'Document reader'),other=await f.createIdleAgent(chat,'Other reader');
  const body='Retained document 🧭\n'+'Exact Unicode 東京 😀\n'.repeat(3000),session=await f.hold(agent.id);
  await writeFile(path.join(chat.workingDirectory,'document.txt'),body);
  const {artifact}=f.ok(await f.tool(session,'ponderosa_import_file',{path:'document.txt'}));
  const sent=f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Retained short document preview',artifactIds:[artifact.id]}));
  session.finish();await f.settled(agent.id);await f.reopen();
  for(let index=0;index<45;index++){const event={schemaVersion:2,eventId:randomUUID(),projectId:chat.projectId,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:agent.id},text:'Newer bounded item '+index+' '+('Controlled held task evidence '.repeat(150)),createdAt:new Date().toISOString()};store.appendCommunicationEvent(event);store.appendEvent(agent.id,{type:'communication_projection',communicationEventId:event.eventId,text:event.text,role:'user'})}
  // A fresh boundary, not a fabricated managed rollover, grants this canonical read.
  f.ok(await f.api('PATCH','/api/workspace/preferences',{contextRolloverTokens:75000,globalInstructions:'Read omitted evidence through the canonical history tool'}));
  const next=await f.hold(agent.id),run=(await f.detail(agent.id)).runs.find(item=>item.status==='running');
  const packet=store.getProviderInput(run.id,true);
  assert.equal(packet.sourceManifest.historyContext.fullyIncludedCommunicationEventIds.includes(sent.eventId),false,'Use a real policy-budget omission, independent of message-count cutoffs');
  assert.equal(packet.exactPrompt.includes('Retained short document preview'),false);
  const frozen=JSON.stringify(packet),result=f.ok(await f.tool(next,'ponderosa_history',{action:'read',communicationEventId:sent.eventId,before:0,after:0}));
  assert.equal(JSON.stringify(store.getProviderInput(run.id,true)),frozen,'Retrieval must not rewrite the accepted provider packet');
  const message=result.messages[0],reference=message.referencedFiles.find(file=>file.artifactId===artifact.id);assert.ok(reference.localPath);assert.equal(reference.sha256,createHash('sha256').update(body).digest('hex'));assert.equal(await readFile(reference.localPath,'utf8'),body);
  assert.equal(message.text,'Retained short document preview');assert.equal(message.complete,true);assert.match(result.notice,/inline.*referenced|referenced.*inline/i);
  const foreign=await f.hold(other.id),denied=await f.tool(foreign,'ponderosa_history',{action:'read',communicationEventId:sent.eventId,before:0,after:0});assert.ok(denied.status>=400);assert.doesNotMatch(JSON.stringify(denied),new RegExp(artifact.id));
 },{storeFactory:root=>store=new AgentStore(root)});
});
