import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { ClaudeReplayFraming } from '../../packages/engines/dist/claude-replay-framing.js';

async function* chunks(text) {
  const body = Buffer.from(text);
  for (let i = 0; i < body.length; i += 65537) yield body.subarray(i, i + 65537);
}
const message = () => ({ role: 'user', content: [{ type: 'text', text: 'Exact 😀 prompt' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(5 * 1024 * 1024) } }] });
const replay = content => ({ type: 'user', uuid: 'input', session_id: 'session', isReplay: true, message: content });

test('exact large media replay is stripped; following tool_result survives chunking', async () => {
  const framing = new ClaudeReplayFraming('session');
  const content = message();
  framing.expect('input', content, Buffer.byteLength(JSON.stringify(replay(content))));
  const echo = replay({ content: content.content, role: content.role });
  const tool = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'keep' }] } };
  const result = [];
  for await (const event of framing.parse(chunks(JSON.stringify(echo) + '\n' + JSON.stringify(tool) + '\n'))) result.push(event);
  assert.deepEqual(result[0].message, { role: 'user', content: [] });
  assert.equal(result[0].uuid, 'input');
  assert.deepEqual(result[1], tool);
  assert.equal(JSON.stringify(result).includes('base64'), false);
});

test('oversized unrelated/foreign/mismatched/repeated echoes still refuse', async () => {
  for (const variant of ['unrelated', 'foreign', 'mismatch', 'repeated']) {
    const framing = new ClaudeReplayFraming('session');
    const content = message();
    framing.expect('input', content, Buffer.byteLength(JSON.stringify(replay(content))));
    const event = replay(content);
    if (variant === 'unrelated') event.type = 'assistant';
    if (variant === 'foreign') event.session_id = 'foreign';
    if (variant === 'mismatch') event.message = { ...content, content: [] };
    const line = JSON.stringify(event);
    await assert.rejects(async () => {
      for await (const _event of framing.parse(chunks(line + '\n' + (variant === 'repeated' ? line + '\n' : '')))) {}
    });
  }
});

test('compact stays text-only and does not reserve a media echo', async () => {
  const frames = [];
  const session = Object.assign(Object.create(ClaudeStreamSession.prototype), { closed: false, child: { stdin: { destroyed: false } },
    engineAgentId: 'session', writeFrame: async frame => frames.push(frame) });
  await ClaudeStreamSession.prototype.writeInput.call(session, '/compact', 'compact');
  assert.deepEqual(frames[0].message.content, [{ type: 'text', text: '/compact' }]);
  assert.equal(frames[0].uuid, 'compact');
});
