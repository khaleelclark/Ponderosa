import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTaskLifetime } from '../../packages/engines/dist/claude-task-lifetime.js';

const session = 'native-session';
const system = (subtype, fields = {}) => ({ type: 'system', subtype, session_id: session, uuid: 'event', ...fields });
const started = (run_id = 'run-001') => system('task_started', { task_id: 'task', run_id, task_type: 'local_agent' });
const terminal = (run_id = 'run-001') => system('task_notification', { task_id: 'task', run_id, status: 'completed' });
const state = state => system('session_state_changed', { state });
function lifetime() { const value = new ClaudeTaskLifetime(session); value.beginTurn(); return value; }
function result(value, id = 'result-1', tokens = 3) {
  return value.project({ type: 'turn_done', usage: { inputTokens: tokens } }, { type: 'result', uuid: id, session_id: session });
}
function stop(value, crons, tasks = []) {
  return value.stopHook({ type: 'control_request', request_id: 'exact-callback', request: {
    subtype: 'hook_callback', callback_id: value.stopCallbackId,
    input: { hook_event_name: 'Stop', session_id: session, session_crons: crons, background_tasks: tasks },
  } });
}

test('accepted task holds the original managed lifetime through result, terminal and native followup', () => {
  const value = lifetime();
  value.observe(state('running'));
  const accepted = value.observe(started());
  assert.equal(accepted[0].status, 'running');
  assert.deepEqual(JSON.parse(accepted[0].workItemId.slice(7)), [session, 'local_agent', 'task', 'run-001']);
  assert.deepEqual(result(value), []);
  assert.deepEqual(value.observe(state('idle')), []);
  assert.throws(() => value.beginTurn(), /still owns/);
  assert.equal(value.observe(terminal())[0].status, 'done');
  value.observe(state('running'));
  assert.deepEqual(result(value, 'result-2', 5), []);
  assert.deepEqual(value.observe(state('idle')), [{ type: 'turn_done', usage: { inputTokens: 8 } }]);
  value.beginTurn();
});

test('terminal before result does not replace the authoritative post-result idle', () => {
  const value = lifetime();
  value.observe(started()); value.observe(terminal());
  assert.deepEqual(value.observe(started()), [], 'late duplicate start cannot revive ended task');
  assert.deepEqual(result(value), []);
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('background snapshot never erases a foreground task or replays its work', () => {
  const value = lifetime();
  const accepted = value.observe(started());
  assert.deepEqual(value.observe(started()), []);
  value.observe(system('background_tasks_changed', { tasks: [] }));
  assert.deepEqual(result(value), []);
  assert.deepEqual(value.observe(state('idle')), []);
  assert.equal(value.observe(terminal())[0].workItemId, accepted[0].workItemId);
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('same task ID resumed with newer run ignores old or missing run terminal events', () => {
  const value = lifetime();
  value.observe(started());
  const replacement = value.observe(started('run-002'));
  assert.deepEqual(replacement.map(event => event.status), ['done', 'running']);
  assert.deepEqual(value.observe(terminal()), []);
  assert.deepEqual(value.observe({ ...terminal(), run_id: undefined }), []);
  assert.deepEqual(value.observe(started('run-001')), []);
  assert.deepEqual(result(value), []);
  assert.deepEqual(value.observe(state('idle')), []);
  value.observe(terminal('run-002'));
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('native session cron snapshot retains source Run without turning a clipped prompt into work', () => {
  const value = lifetime();
  value.observe(state('running'));
  const receipt = stop(value, [{ id: 'cron-1', schedule: '* * * * *', recurring: false, prompt: 'CLIPPED SECRET' }]);
  assert.equal(receipt.requestId, 'exact-callback');
  assert.equal(receipt.events[0].status, 'running');
  assert.equal(JSON.stringify(receipt).includes('CLIPPED SECRET'), false);
  assert.deepEqual(result(value), []);
  assert.deepEqual(value.observe(state('idle')), []);
  stop(value, []);
  value.observe(state('running'));
  result(value, 'scheduled-result');
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('schedule tool intent alone creates only an unresolved receipt hold, not an accepted schedule', () => {
  const value = lifetime();
  value.observe({ type: 'assistant', session_id: session, parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'call', input: { prompt: 'not replayed' } }] } });
  assert.deepEqual(result(value), []);
  assert.deepEqual(value.observe(state('idle')), []);
  assert.deepEqual(stop(value, []).events.map(event => event.status), ['done']);
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('foreign/replayed frames and duplicate result UUIDs cannot close or double account work', () => {
  const value = lifetime();
  value.observe(state('running')); value.observe(started());
  assert.deepEqual(value.observe({ ...terminal(), session_id: 'foreign' }), []);
  assert.deepEqual(value.observe({ ...terminal(), isReplay: true }), []);
  assert.deepEqual(value.project({ type: 'turn_done' }, { session_id: 'foreign' }), []);
  result(value); result(value);
  assert.deepEqual(value.observe(state('idle')), []);
  value.observe(terminal());
  assert.deepEqual(value.observe(state('idle')), [{ type: 'turn_done', usage: { inputTokens: 3 } }]);
  assert.deepEqual(result(value), []);
});

test('only exact registered Stop callback is answered and missing fields never clear accepted obligations', () => {
  const value = lifetime();
  stop(value, [{ id: 'cron' }]);
  assert.equal(value.stopHook({ type: 'control_request', request_id: 'other', request: {
    subtype: 'hook_callback', callback_id: 'foreign', input: { session_id: session, hook_event_name: 'Stop' },
  } }), undefined);
  value.stopHook({ type: 'control_request', request_id: 'exact', request: {
    subtype: 'hook_callback', callback_id: value.stopCallbackId, input: { session_id: session, hook_event_name: 'Stop' },
  } });
  result(value);
  assert.deepEqual(value.observe(state('idle')), []);
  assert.throws(() => value.beginTurn(), /still owns/);
});

test('ordinary older producer keeps ordinary completion, malformed snapshots fail instead of clearing ownership', () => {
  const value = lifetime();
  assert.equal(result(value)[0].type, 'turn_done');
  value.beginTurn(); value.observe(started());
  assert.throws(() => value.observe(system('background_tasks_changed', { tasks: [{ task_id: '' }] })), /Invalid/);
  assert.throws(() => stop(value, [{ id: '' }]), /Invalid/);
  result(value, 'result-2');
  assert.deepEqual(value.observe(state('idle')), []);
});


test('process snapshot upgrades weak Stop-hook identity without letting an old run settle it', () => {
  const value = lifetime();
  stop(value, [], [{ id: 'task', type: 'subagent', status: 'running' }]);
  value.observe(system('background_tasks_changed', { tasks: [
    { task_id: 'task', task_type: 'local_agent', run_id: 'run-002' },
  ] }));
  assert.deepEqual(value.observe(terminal('run-001')), []);
  result(value);
  assert.deepEqual(value.observe(state('idle')), []);
  assert.equal(value.observe(terminal('run-002'))[0].status, 'done');
  assert.equal(value.observe(state('idle'))[0].type, 'turn_done');
});

test('actual stream session keeps its reader and accepts followup input until native task completion', { timeout: 10000 }, async () => {
  const { ClaudeStreamSession } = await import('../../packages/engines/dist/claude-stream-session.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-task-lifetime-'));
  const handles = [];
  let runtime;
  try {
    const bin = path.join(root, 'inert-claude.mjs');
    await writeFile(bin, String.raw`#!${process.execPath}
import { createInterface } from 'node:readline';
const session = ${JSON.stringify(session)};
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
let callback, pending, turn=0;
for await (const line of createInterface({input:process.stdin})) {
 const frame=JSON.parse(line);
 if(frame.type==='control_request' && frame.request.subtype==='initialize') {
  callback=frame.request.hooks.Stop[0].hookCallbackIds[0];
  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{}}});
  emit({type:'system',subtype:'init',session_id:session,model:'claude-exact'});
 } else if(frame.type==='user') {
  turn++;
  emit({...frame,isReplay:true,parent_tool_use_id:null});
  emit({type:'system',subtype:'session_state_changed',state:'running',session_id:session});
  if(turn===1) emit({type:'system',subtype:'task_started',session_id:session,task_id:'task',run_id:'run-001',task_type:'local_agent'});
  else {
   emit({type:'system',subtype:'task_notification',session_id:session,task_id:'task',run_id:'run-001',status:'completed'});
   emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:{role:'assistant',id:'followup',content:[{type:'text',text:'native followup retained'}]}});
  }
  pending='stop-'+turn;
  emit({type:'control_request',request_id:pending,request:{subtype:'hook_callback',callback_id:callback,
   input:{hook_event_name:'Stop',session_id:session,session_crons:[],background_tasks:[]}}});
 } else if(frame.type==='control_response' && frame.response.request_id===pending) {
  emit({type:'result',uuid:'result-'+turn,session_id:session,is_error:false,usage:{input_tokens:turn}});
  emit({type:'system',subtype:'session_state_changed',state:'idle',session_id:session});
 }
}
`, { mode: 0o700 });
    runtime = new ClaudeStreamSession({ bin, permissionMode: 'bypassPermissions', killGraceMs: 100,
      agentId: 'fixture-owner', cwd: root, resumeSessionId: session, history: [], signal: new AbortController().signal,
      onRuntimeSpawned: handle => handles.push(handle), onRuntimeRootExit: () => {} });
    await runtime.capabilities();
    await runtime.startTurn({ prompt: 'accepted source work', clientMessageId: 'source' });
    const iterator = runtime.events[Symbol.asyncIterator]();
    let accepted;
    do { accepted = await iterator.next(); }
    while (!accepted.done && accepted.value.type !== 'work_item_update' && accepted.value.type !== 'turn_done');
    assert.equal(accepted.value.type, 'work_item_update');
    assert.equal(accepted.value.status, 'running');
    assert.deepEqual(await runtime.steer({ prompt: 'release native task', clientMessageId: 'followup' }), { status: 'accepted', turnId: 'followup' });
    const events = [];
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      events.push(next.value);
      if (next.value.type === 'turn_done') break;
    }
    assert.equal(events.filter(event => event.type === 'turn_done').length, 1);
    assert.equal(events.some(event => event.type === 'text' && event.delta === 'native followup retained'), true);
    assert.equal(events.some(event => event.type === 'work_item_update' && event.status === 'done'), true);
    assert.equal(handles.length, 1);
  } finally {
    const cleanup = await Promise.allSettled(handles.map(handle => handle.close()));
    await rm(root, { recursive: true, force: true });
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned fixture runtime cleanup failed');
  }
});


test('native command cannot take an uncertain source lifetime after an ordinary error', async () => {
  const { ClaudeStreamSession } = await import('../../packages/engines/dist/claude-stream-session.js');
  const runtime = Object.create(ClaudeStreamSession.prototype);
  Object.assign(runtime, { active: false, taskLifetime: lifetime() });
  await assert.rejects(() => runtime.invokeCommand('compact'), /uncertain native work/);
});
