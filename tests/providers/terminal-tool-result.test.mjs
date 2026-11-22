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

test('provider display text and tool input are cleaned without rewriting identifiers', () => {
  assert.deepEqual(projectAgentEvent({type:'text', delta:'first\u001b[31mred\u001b[0m'}), {type:'text', delta:'firstred'});
  assert.deepEqual(projectAgentEvent({type:'tool_call',id:'tool-1',name:'search',input:{query:'x\fy'}}),
    {type:'tool_call',id:'tool-1',name:'search',input:{query:'xy'}});
  assert.throws(() => projectAgentEvent({type:'tool_call',id:'tool\u001b-1',name:'search',input:{}}));
});

test('managed providers keep native credential and user environment configuration', async () => {
  const { runtimeEnvironment } = await import('../../packages/engines/dist/runtime-environment.js');
  const supplied = { NODE_ENV:'production', PONDEROSA_PORT:'1234', PONDEROSA_DATA_DIR:'/server-only',
    PONDEROSA_BROWSER_SERVICE_SOCKET:'/server-only.sock', PATH:'/custom', TMPDIR:'/user-temp',
    CLAUDE_CONFIG_DIR:'/user-claude', CODEX_HOME:'/user-codex', OPENAI_API_KEY:'fixture-only',
    PONDEROSA_AGENT_MESSAGE_URL:'http://127.0.0.1/fixture' };
  const environment = runtimeEnvironment(supplied);
  for (const key of ['NODE_ENV','PONDEROSA_PORT','PONDEROSA_DATA_DIR','PONDEROSA_BROWSER_SERVICE_SOCKET'])
    assert.equal(environment[key], undefined, key);
  for (const key of ['PATH','TMPDIR','CLAUDE_CONFIG_DIR','CODEX_HOME','OPENAI_API_KEY','PONDEROSA_AGENT_MESSAGE_URL'])
    assert.equal(environment[key], supplied[key], key);
});
