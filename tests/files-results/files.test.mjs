import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import sharp from 'sharp';
import { withFixture, runtimeAttachmentPaths } from '../shared/fixture.mjs';

const options = { timeout: 30000 };
const exec = promisify(execFile);
const upload = async (f, agent, name, bytes, media = 'text/plain') => f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, bytes, { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': name, 'x-ponderosa-media-type': media }));

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
