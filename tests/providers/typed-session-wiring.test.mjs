import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';

// Deferred fixture: exercise the actual frame boundary without spawning a provider.
test('Claude rejects oversized replay frames before writing; compact remains text-only', async () => {
  const frames = [];
  const session = { closed: false, child: { stdin: { destroyed: false } },
    engineAgentId: 'session', writeFrame: async frame => frames.push(frame) };
  await assert.rejects(ClaudeStreamSession.prototype.writeInput.call(session, 'x'.repeat(3 * 1024 * 1024), 'large'), /3 MiB/);
  assert.equal(frames.length, 0);
  await ClaudeStreamSession.prototype.writeInput.call(session, '/compact', 'compact');
  assert.deepEqual(frames[0].message.content, [{ type: 'text', text: '/compact' }]);
  assert.equal(frames[0].uuid, 'compact');
});
