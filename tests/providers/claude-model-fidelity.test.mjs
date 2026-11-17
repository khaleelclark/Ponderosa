import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeModelMatches, claudeModelGuard } from '../../packages/engines/dist/claude-model-fidelity.js';
import { claudeAvailabilityStatus } from '../../packages/engines/dist/auth.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { classifyProviderFailure } from '../../packages/core/dist/provider-failure-summary.js';

const reply = model => ({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [] } });
const init = model => ({ type: 'system', subtype: 'init', session_id: 's', model });

test('selected aliases and exact IDs match only the model Claude reports', () => {
  assert.equal(claudeModelMatches('opus', 'claude-opus-5-5'), true);
  assert.equal(claudeModelMatches('opus', 'claude-sonnet-5-5'), false);
  assert.equal(claudeModelMatches('sonnet[1m]', 'claude-sonnet-5-5[1m]'), true);
  assert.equal(claudeModelMatches('claude-opus-5-5', 'claude-opus-5-5-20261001'), true);
  assert.equal(claudeModelMatches('claude-opus-5', 'claude-opus-5-5'), false);
  assert.equal(claudeModelMatches('opus', 'my-gateway-opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-gateway-opus' }), true);
  assert.equal(claudeModelMatches('opus', 'claude-opus-5-5', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-gateway-opus' }), false);
  assert.equal(claudeModelMatches('bedrock-arn', 'anything'), undefined);
});

test('a session pins the model init resolved, so a same-family fallback still stops the Run', () => {
  const guard = claudeModelGuard('opus');
  assert.equal(guard(init('claude-opus-5-5')), undefined);
  assert.equal(guard(reply('claude-opus-5-5')), undefined);
  assert.equal(guard(reply('<synthetic>')), undefined);
  assert.equal(guard({ ...reply('claude-haiku-5-5'), parent_tool_use_id: 'toolu_subagent' }), undefined, 'subagents may use their own model');
  const fallback = guard(reply('claude-opus-4-8'));
  assert.equal(fallback.code, 'invalid_model');
  assert.match(fallback.message, /claude-opus-4-8 instead of the selected opus/);
  assert.equal(claudeModelGuard('opus')(init('claude-sonnet-5-5')).code, 'invalid_model', 'a wrong resolution fails before any reply');
});

test('a real stream session stops on a substituted reply and launches with fallback disabled', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-model-fidelity-'));
  const handles = [];
  try {
    const bin = path.join(root, 'inert-claude.mjs');
    await writeFile(bin, String.raw`#!${process.execPath}
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const session = process.argv[process.argv.indexOf('--session-id')+1];
for await (const line of createInterface({input:process.stdin})) {
 const frame=JSON.parse(line);
 if(frame.type==='control_request' && frame.request.subtype==='initialize') {
  emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{}}});
  emit({type:'system',subtype:'init',session_id:session,model:'claude-opus-5-5'});
 } else if(frame.type==='user') {
  emit({...frame,isReplay:true,parent_tool_use_id:null});
  const model = process.env.CLAUDE_CODE_NO_MODEL_FALLBACK === '1' ? 'claude-opus-4-8' : 'claude-opus-5-5';
  emit({type:'assistant',session_id:session,parent_tool_use_id:null,message:{role:'assistant',id:'m',model,content:[{type:'text',text:'answer'}]}});
  emit({type:'result',uuid:'r',session_id:session,is_error:false,usage:{input_tokens:1}});
 }
}
`, { mode: 0o700 });
    const runtime = new ClaudeStreamSession({ bin, model: 'opus', permissionMode: 'bypassPermissions', killGraceMs: 100,
      agentId: 'fixture-owner', cwd: root, history: [], signal: new AbortController().signal,
      onRuntimeSpawned: handle => handles.push(handle), onRuntimeRootExit: () => {} });
    await runtime.capabilities();
    await runtime.startTurn({ prompt: 'work', clientMessageId: 'source' });
    const events = [];
    for await (const event of runtime.events) { events.push(event); if (event.type === 'error' || event.type === 'turn_done') break; }
    // The fixture substitutes only when the flag reached it, proving both the flag and the stop.
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).code, 'invalid_model');
    assert.equal(events.some(event => event.type === 'text' && event.delta === 'answer'), false, 'substituted output is not published');
  } finally {
    await Promise.allSettled(handles.map(handle => handle.close()));
    await rm(root, { recursive: true, force: true });
  }
});

const signedIn = async () => ({ authenticated: true, billingMode: 'subscription', source: 'cli_status' });
const limited = JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
  result: "You're out of usage credits. Switch to another model, or manage usage credits to continue." });
const ready = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONDEROSA_RUNTIME_READY' });
const modelOf = args => args[args.indexOf('--model') + 1];

test('one model at its usage limit does not make Claude unavailable for the others', async () => {
  const tried = [];
  const result = await claudeAvailabilityStatus({}, async (_bin, args, options) => {
    tried.push(modelOf(args));
    assert.equal(options.env.CLAUDE_CODE_NO_MODEL_FALLBACK, '1');
    return { stderr: '', stdout: modelOf(args) === 'sonnet' ? limited : ready };
  }, signedIn);
  assert.deepEqual(tried, ['sonnet', 'opus'], 'the default agent model is tested first, never the CLI default');
  assert.equal(result.available, true);
});

test('Claude is held only when every offered model is at its usage limit', async () => {
  const tried = [];
  const result = await claudeAvailabilityStatus({}, async (_bin, args) => { tried.push(modelOf(args)); return { stderr: '', stdout: limited }; }, signedIn);
  assert.deepEqual(tried, ['sonnet', 'opus', 'haiku']);
  assert.equal(result.available, false);
  assert.equal(result.failureCategory, 'quota_exhausted');
  assert.match(result.detail, /usage limits are reached for every model/);
  assert.equal(classifyProviderFailure("You're out of usage credits."), 'quota_exhausted');
});
