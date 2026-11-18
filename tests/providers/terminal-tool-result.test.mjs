import test from 'node:test';
import assert from 'node:assert/strict';
import { mapClaudeEvent } from '../../packages/engines/dist/claude-events.js';
import { projectAgentEvent } from '../../packages/engines/dist/agent-event-projection.js';

// Reproduced on Pine DEV: colored `flutter test` output failed the whole Claude Run.
test('colored command output crosses the AgentEvent boundary as plain text', () => {
  const content = '00:01 +2: A09\n\u001b[38;5;3m│ [warning] | Sidecar write failed\u001b[0m\n\tdone\r\n';
  const [event] = mapClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content }] } });
  assert.deepEqual(projectAgentEvent(event), { type: 'tool_result', id: 'toolu_01', output: '00:01 +2: A09\n│ [warning] | Sidecar write failed\n\tdone\r\n' });
});
