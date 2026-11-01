import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTaskLifetime } from '../../packages/engines/dist/claude-task-lifetime.js';
import { ClaudeNativeCompaction } from '../../packages/engines/dist/claude-native-compaction.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { normalizeClaudeInitCapabilities } from '../../packages/engines/dist/capabilities.js';

const sessionId = 'exact-retained-session', commandId = 'exact-native-command';
const init = { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-exact' };
const accepted = { type: 'user', uuid: commandId, session_id: sessionId, parent_tool_use_id: null,
  isReplay: true, message: { role: 'user', content: '/compact' } };
const boundary = { type: 'system', subtype: 'compact_boundary', session_id: sessionId,
  uuid: 'exact-boundary', compact_metadata: { trigger: 'manual', pre_tokens: 190000 } };
const result = { type: 'result', subtype: 'success', session_id: sessionId, is_error: false,
  local_command: 'compact', user_message_uuid: commandId, user_message_uuids: [commandId] };
const measurement = { totalTokens: 10000, rawMaxTokens: 200000, model: 'claude-exact' };
const usage = (id = 'fresh-control', value = measurement) => ({ type: 'control_response',
  response: { subtype: 'success', request_id: id, response: value } });
function command(events = [init, accepted, boundary, result]) {
  const operation = new ClaudeNativeCompaction(sessionId, commandId);
  operation.inputSent = true;
  for (const event of events) operation.observe(event);
  return operation;
}

test('native completion requires manual boundary, local command and exact input UUID, then a fresh separate control', async () => {
  const operation = command();
  assert.equal(await operation.completion, true);
  assert.equal(operation.succeeded, false, 'Completion is not fresh occupancy');
  operation.observe(usage('old-control'));
  assert.equal(operation.succeeded, false);
  assert.equal(operation.requestUsage('fresh-control'), true);
  operation.observe(usage('old-control'));
  assert.equal(operation.succeeded, false);
  operation.observe(usage());
  assert.deepEqual(await operation.usage, { usedTokens: 10000, windowTokens: 200000, providerSessionGeneration: sessionId });
  assert.equal(operation.succeeded, true);
});

test('ordinary success prose, stale/merged/foreign frames and no-op compact never authorize recovery', async () => {
  for (const events of [
    [init, accepted, { ...result, result: 'Compaction completed' }],
    [init, accepted, boundary, { ...result, local_command: undefined, result: 'Compaction completed' }],
    [init, accepted, boundary, { ...result, user_message_uuid: 'other-command' }],
    [init, accepted, boundary, { ...result, user_message_uuids: [commandId, 'other-work'] }],
    [init, accepted, boundary, { ...result, session_id: 'other-session' }],
    [init, accepted, boundary, { ...result, subtype: 'error_during_execution', is_error: true }],
    [init, accepted, { ...boundary, compact_metadata: { trigger: 'auto', pre_tokens: 190000 } }],
    [init, accepted, { ...boundary, isReplay: true }],
    [init, boundary],
    [init, { ...accepted, uuid: 'old-input' }],
    [{ ...init, session_id: 'other-session' }],
    [init, accepted, boundary, boundary],
    [init, accepted, boundary, { ...init, model: 'other-model' }],
  ]) {
    const operation = command(events);
    assert.equal(await operation.completion, false);
    assert.equal(await operation.usage, undefined);
    assert.equal(operation.requestUsage('fresh-control'), false);
  }
});

test('usage rejects aggregate/plaintext, invalid counters, other model, errors and changed session', async () => {
  for (const value of [null, {}, { usage: measurement }, { ...measurement, totalTokens: -1 },
    { ...measurement, totalTokens: 1.5 }, { ...measurement, rawMaxTokens: 0 },
    { ...measurement, model: 'other-model' }]) {
    const operation = command();
    assert.equal(operation.requestUsage('fresh-control'), true);
    operation.observe(usage('fresh-control', value));
    assert.equal(await operation.usage, undefined);
  }
  for (const event of [
    { ...usage(), session_id: 'other-session' },
    { type: 'control_response', response: { subtype: 'error', request_id: 'fresh-control', error: 'unsupported' } },
    { type: 'conversation_reset', session_id: sessionId },
  ]) {
    const operation = command(); operation.requestUsage('fresh-control'); operation.observe(event);
    assert.equal(await operation.usage, undefined);
  }
});

test('existing invokeCommand sends one command and one occupancy control without a normal turn or native replay', async () => {
  const session = Object.create(ClaudeStreamSession.prototype);
  Object.assign(session, { engineAgentId: sessionId, opts: { resumeSessionId: sessionId },
    controls: {uncertain:false}, initialized: true, nativeCompactAdvertised: true, initialization: Promise.resolve(), sessionInitialization: init, taskLifetime: new ClaudeTaskLifetime(sessionId) });
  const frames = [];
  session.writeInput = async (text, id) => {
    frames.push({ text, id });
    const operation = session.nativeCommand;
    operation.observe({ ...accepted, uuid: id });
    operation.observe(boundary);
    operation.observe({ ...result, user_message_uuid: id, user_message_uuids: [id] });
  };
  session.writeFrame = async frame => {
    frames.push(frame);
    assert.equal(frame.request.subtype, 'get_context_usage');
    session.nativeCommand.observe(usage(frame.request_id));
  };
  const returned = await session.invokeCommand('compact');
  assert.equal(returned.outcome, 'completed');
  assert.equal(returned.contextUsage.usedTokens, 10000);
  assert.equal(frames.length, 2); assert.equal(frames[0].text, '/compact');
  assert.equal(session.nativeCommand.succeeded, true);
  session.nativeCommand.fail();
  await assert.rejects(() => session.invokeCommand('compact'), /uncertain/);
  assert.equal(frames.length, 2);
});

test('native command classification retains custom compact skills as ordinary commands', () => {
  const native = normalizeClaudeInitCapabilities({ ...init, slash_commands: ['compact'] });
  assert.equal(native.commands[0].invocation, 'runtime');
  assert.equal(native.commands[0].acceptsArguments, false);
  const custom = normalizeClaudeInitCapabilities({ ...init, slash_commands: ['compact'], skills: ['compact'] });
  assert.equal(custom.commands[0].invocation, 'prompt');
});

test('idle stream transport consumes native receipts without an event reader and preserves later ordinary event readers', { timeout: 10000 }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-transport-'));
  const bin = path.join(root, 'inert-claude.mjs');
  await writeFile(bin, `#!${process.execPath}
import { createInterface } from 'node:readline';
const session = ${JSON.stringify(sessionId)};
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const frame=JSON.parse(line);
 if(frame.type==='control_request' && frame.request.subtype==='initialize') {
  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[{name:'compact'}]}}});
  emit({type:'system',subtype:'init',session_id:session,model:'claude-exact',slash_commands:['compact']});
 } else if(frame.type==='control_request' && frame.request.subtype==='get_context_usage') {
  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{totalTokens:10000,rawMaxTokens:200000,model:'claude-exact'}}});
 } else if(frame.type==='user') {
  emit({...frame,isReplay:true,parent_tool_use_id:null});
  if(frame.message.content[0].text==='/compact') {
   emit({type:'system',subtype:'compact_boundary',session_id:session,uuid:'native-boundary',compact_metadata:{trigger:'manual',pre_tokens:190000}});
   emit({type:'result',subtype:'success',session_id:session,is_error:false,local_command:'compact',user_message_uuid:frame.uuid,result:'PRIVATE native receipt'});
  } else {
   emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:{role:'assistant',id:frame.uuid,model:'claude-exact',content:[{type:'text',text:'ordinary reply'}]}});
   emit({type:'result',subtype:'success',session_id:session,is_error:false,result:''});
  }
 }
}
`, { mode: 0o700 });
  const controller = new AbortController(); const handles = [];
  let session;
  try {
    session = new ClaudeStreamSession({ bin, permissionMode: 'bypassPermissions', killGraceMs: 100,
      agentId: 'fixture-owner', cwd: root, resumeSessionId: sessionId, history: [], signal: controller.signal,
      onRuntimeSpawned: handle => handles.push(handle), onRuntimeRootExit: () => {} });
    const catalog = await session.capabilities();
    assert.equal(catalog.commands.find(command => command.name === 'compact').invocation, 'runtime');
    const compact = await session.invokeCommand('compact');
    assert.equal(compact.outcome, 'completed');
    assert.equal(compact.contextUsage.usedTokens, 10000);
    assert.equal(handles.length, 1);
    for (const id of ['first-ordinary-turn', 'second-ordinary-turn']) {
      await session.startTurn({ prompt: 'independent ordinary work', clientMessageId: id });
      const events = [];
      for await (const event of session.events) {
        events.push(event);
        if (event.type === 'turn_done') break;
      }
      assert.equal(events.filter(event => event.type === 'turn_done').length, 1);
      assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), 'ordinary reply');
      assert.equal(JSON.stringify(events).includes('PRIVATE native receipt'), false);
    }
  } finally {
    await session?.close();
    for (const handle of handles) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
