import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonRpcOutputLimitError, JsonRpcProcess } from '../../packages/engines/dist/json-rpc-process.js';
import { CodexAppServerSession, discoverCodexAppServerCapabilities } from '../../packages/engines/dist/codex-app-server.js';

test('malformed records and late server replies stay inside the RPC boundary', { timeout: 15_000 }, () => {
  // Observe escaped failures in a disposable parent, so the red baseline cannot
  // crash the test runner or leave its owned fake provider alive.
  const records = `process.stdout.write(${JSON.stringify('null\n42\ntrue\n[]\n{bad\n{"method":42}\n{"method":"valid"}\n')});setInterval(()=>{},1000)`;
  const probe = `
    import { JsonRpcProcess } from ${JSON.stringify(new URL('../../packages/engines/dist/json-rpc-process.js', import.meta.url).href)};
    const escaped = [];
    process.on('uncaughtException', e => escaped.push(e.message));
    process.on('unhandledRejection', e => escaped.push(e.message));
    const reports = [];
    for (const scenario of ['records', 'resolve-after-exit', 'reject-after-exit', 'resolve-after-close', 'reject-after-close', 'unsupported']) {
      let handled = 0, observed = 0;
      const script = scenario === 'records'
        ? ${JSON.stringify(records)}
        : scenario.endsWith('after-exit')
          ? 'console.log(JSON.stringify({id:7,method:"tool"}));setTimeout(()=>process.exit(0),30)'
          : 'console.log(JSON.stringify({id:7,method:"tool"}));process.stdin.on("data",()=>console.log(JSON.stringify({method:"answered"})));setInterval(()=>{},1000)';
      const rpc = new JsonRpcProcess({bin:process.execPath,args:['-e',script],cwd:process.cwd(),signal:new AbortController().signal,
        killGraceMs:50,onRuntimeSpawned(){},onRuntimeRootExit(){},onNotification(){observed++;},
        ...(scenario === 'unsupported' ? {} : {handleServerRequest:async()=>{handled++;await new Promise(r=>setTimeout(r,150));if(scenario.startsWith('reject'))throw Error('Owned handler failure');return 'ok';}})});
      try {
        if(scenario.endsWith('after-close')){for(let i=0;i<100&&!handled;i++)await new Promise(r=>setTimeout(r,5));if(!handled)throw Error('Handler never entered');await rpc.close();}
        await new Promise(r=>setTimeout(r,300));
      } finally {await rpc.close();}
      reports.push({scenario,observed,handled,alive:rpc.isAlive()});
    }
    console.log(JSON.stringify({escaped,reports}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 12_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.escaped, []);
  assert.ok(result.reports.every(r => !r.alive));
  for (const report of result.reports.filter(r => r.scenario.includes('after-'))) assert.equal(report.handled, 1, report.scenario);
  assert.equal(result.reports.find(r => r.scenario === 'records').observed, 1);
  assert.equal(result.reports.find(r => r.scenario === 'unsupported').observed, 1);
});

for (const extra of [0, 1]) test(`aggregate output budget accepts its boundary and rejects overflow: extra=${extra}`, async () => {
  const notification = JSON.stringify({ method: 'valid', params: 'x'.repeat(100) }) + '\n';
  const rpc = new JsonRpcProcess({ bin: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(notification + ' '.repeat(extra))});setInterval(()=>{},1000)`],
    cwd: process.cwd(), signal: new AbortController().signal, maxOutputBytes: Buffer.byteLength(notification),
    killGraceMs: 50, onRuntimeSpawned() {}, onRuntimeRootExit() {} });
  try {
    if (extra) {
      const notifications = [];
      for await (const notification of rpc.notifications) notifications.push(notification);
      assert.equal(notifications.at(-1).method, 'ponderosa/processError');
      assert.match(notifications.at(-1).params.message, /aggregate limit/);
      await assert.rejects(rpc.request('after-failure'), JsonRpcOutputLimitError);
      assert.throws(() => rpc.throwIfFailed(), JsonRpcOutputLimitError);
    } else {
      const first = await rpc.notifications[Symbol.asyncIterator]().next();
      assert.equal(first.value.method, 'valid');
    }
  } finally { await rpc.close(); }
  assert.equal(rpc.isAlive(), false);
});

for (const flood of ['none', 'large-valid', 'before-initialize', 'after-initialize', 'many-small']) test(`discovery bounds retained output and reports overflow: ${flood}`, { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-discovery-'));
  const handles = [];
  try {
    // Node treats the first normal CLI argument as this owned script on every
    // platform; no shell wrapper or provider installation is needed.
    writeFileSync(path.join(root, 'app-server'), `
      const fs=require('node:fs');let flooded=false;const seen=[];
      const mode=${JSON.stringify(flood)};
      const flood=()=>{const count=mode==='many-small'?9216:mode==='large-valid'?1:9;const size=mode==='many-small'?1024:mode==='large-valid'?3*1024*1024:1024*1024;for(let i=0;i<count;i++)process.stdout.write(JSON.stringify({method:'fixture',params:'x'.repeat(size)})+'\\n');};
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);if(m.id===undefined)return;seen.push([m.method,m.params?.cursor]);fs.writeFileSync('requests.json',JSON.stringify(seen));
        if(!flooded&&(${JSON.stringify(flood)}==='before-initialize'||(['after-initialize','many-small','large-valid'].includes(mode)&&m.method!=='initialize'))){flooded=true;flood();}
        const result=m.method==='model/list'&&!m.params?.cursor?{data:[],nextCursor:'page-2'}:{data:[],nextCursor:null};
        console.log(JSON.stringify({id:m.id,result}));
      });
    `);
    const operation = discoverCodexAppServerCapabilities({ bin: process.execPath, cwd: root, sandboxMode: 'read-only',
      signal: new AbortController().signal, killGraceMs: 50, configuredMcps: [], timeoutMs: 10_000,
      onRuntimeSpawned: handle => handles.push(handle) });
    if (flood === 'none' || flood === 'large-valid') {
      await operation;
      assert.ok(JSON.parse(readFileSync(path.join(root, 'requests.json'), 'utf8')).some(([method,cursor]) => method === 'model/list' && cursor === 'page-2'));
    } else {
      await assert.rejects(operation, /aggregate limit/);
      assert.ok(handles[0].queue.values.length < (flood === 'many-small' ? 9216 : 9), 'Overflow retained the complete notification flood');
    }
    assert.ok(handles.every(h => !h.isAlive()));
  } finally {
    await Promise.all(handles.map(h => h.close()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ordinary consumed runtime notifications have no discovery lifetime cap', { timeout: 15_000 }, async () => {
  const rpc = new JsonRpcProcess({ bin: process.execPath,
    args: ['-e', `for(let i=0;i<9;i++)console.log(JSON.stringify({method:'runtime',params:'x'.repeat(1024*1024)}))`],
    cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 50, onRuntimeSpawned() {}, onRuntimeRootExit() {} });
  try {
    let count = 0;
    for await (const notification of rpc.notifications) { assert.equal(notification.method, 'runtime'); count++; }
    assert.equal(count, 9);
  } finally { await rpc.close(); }
  assert.equal(rpc.isAlive(), false);
});

for (const matches of [true, false]) test(`Codex validates the exact saved thread before allowing a resumed turn; matches=${matches}`, { timeout: 5_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-resume-'));
  const handles = []; let session;
  writeFileSync(path.join(root, 'app-server'), `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line); if (message.id === undefined) return;
      const result = message.method === 'initialize' ? {userAgent:'codex/0.100.0'}
        : {thread:{id:${JSON.stringify(matches ? 'saved-thread' : 'foreign-thread')}}};
      console.log(JSON.stringify({id:message.id,result}));
    });
  `);
  try {
    const opening = CodexAppServerSession.open({ bin: process.execPath, cwd: root, agentId: 'owned-resume', history: [],
      signal: new AbortController().signal, sandboxMode: 'read-only', resumeSessionId: 'saved-thread',
      killGraceMs: 50, onRuntimeSpawned: handle => handles.push(handle) });
    if (matches) {
      session = await opening;
      assert.equal(session.engineAgentId, 'saved-thread');
      assert.equal(session.validatesResumeBeforeTurn, true);
    } else await assert.rejects(opening, /did not confirm the requested saved session/);
  } finally {
    await session?.close(); await Promise.all(handles.map(handle => handle.close()));
    assert.ok(handles.length && handles.every(handle => !handle.isAlive()), 'Owned resume probes must exit');
    await rm(root, { recursive: true, force: true });
  }
});

for (const trailing of [false, true]) test(`throwing notification observers fail the transport: trailing=${trailing}`, { timeout: 5_000 }, async () => {
  const rpc = new JsonRpcProcess({ bin: process.execPath,
    // Exit for real EOF on Windows too; closing fd 1 alone leaves its pipe open.
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ method: 'observer' }) + (trailing ? '' : '\n'))});${trailing ? '' : 'setInterval(()=>{},1000)'}`],
    cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 50,
    onRuntimeSpawned() {}, onRuntimeRootExit() {}, onNotification() { throw new Error('Owned observer failure'); } });
  try {
    await assert.rejects(rpc.request('pending'), /Owned observer failure/);
    const notifications = [];
    for await (const notification of rpc.notifications) notifications.push(notification);
    assert.equal(notifications.at(-1).method, 'ponderosa/processError');
    assert.match(notifications.at(-1).params.message, /Owned observer failure/);
  } finally { await rpc.close(); }
  assert.equal(rpc.isAlive(), false);
});

for (const transport of ['cli', 'rpc']) for (const size of [8192, 8193, 20000]) {
  test(`${transport} diagnostic loss is explicit at stderr length ${size}`, { timeout: 5_000 }, async () => {
    const { streamProcess } = await import('../../packages/engines/dist/process.js');
    const script = `process.stderr.write('x'.repeat(${size}-4)+'END!',()=>process.exit(7))`;
    const handles = []; let rootDetail; let message;
    if (transport === 'cli') {
      const events = [];
      for await (const event of streamProcess({ bin: process.execPath, args: ['-e', script],
        cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 50,
        label: 'fixture', map: () => [], onRuntimeSpawned: h => handles.push(h) })) events.push(event);
      message = events.find(e => e.type === 'error').message;
    } else {
      const rpc = new JsonRpcProcess({ bin: process.execPath, args: ['-e', script],
        cwd: process.cwd(), signal: new AbortController().signal, killGraceMs: 50,
        onRuntimeSpawned: h => handles.push(h), onRuntimeRootExit: detail => { rootDetail = detail; } });
      try {
        const events = [];
        for await (const event of rpc.notifications) events.push(event);
        message = events.find(e => e.method === 'ponderosa/processError').params.message;
        assert.ok(rootDetail.stderr.endsWith('END!'));
        assert.equal(rootDetail.stderr.includes('stderr truncated'), size > 8192);
      } finally { await rpc.close(); }
    }
    assert.match(message, /exited with code 7/);
    assert.ok(message.endsWith('END!'));
    assert.equal(message.includes('stderr truncated'), size > 8192);
    if (size > 8192) assert.ok(message.includes(`${size - 8192} UTF-16 code units omitted`));
    else assert.ok(message.endsWith('x'.repeat(size - 4) + 'END!'));
    assert.ok(handles.length && handles.every(h => !h.isAlive()));
  });
}

test('stderr tail counts incremental omissions and keeps Unicode boundaries intact', async () => {
  const { StderrTail } = await import('../../packages/engines/dist/stderr-tail.js');
  const tail = new StderrTail();
  tail.append('x' + '😀' + 'y'.repeat(8191));
  assert.equal(tail.text(), '[stderr truncated: 3 UTF-16 code units omitted; retained tail follows]\n' + 'y'.repeat(8191));
  tail.append('END!');
  assert.equal(tail.text(), '[stderr truncated: 6 UTF-16 code units omitted; retained tail follows]\n' + 'y'.repeat(8188) + 'END!');
  const short = new StderrTail(); short.append('😀'); short.append(' ok');
  assert.equal(short.text(), '😀 ok');
});

// Implementation-first regressions: execute with the assembled implementation.
test('native token mappers preserve partial counters without inventing totals', async () => {
  const { mapCodexTokenUsage, sumProviderRequestUsage } = await import('../../packages/engines/dist/codex-app-server.js');
  const { mapCodexEvent } = await import('../../packages/engines/dist/events.js');
  const { mapClaudeAssistantUsage } = await import('../../packages/engines/dist/claude-events.js');
  for (const partial of [{ inputTokens: 7 }, { outputTokens: 9 }, { cachedInputTokens: 4 }, { reasoningOutputTokens: 2 }]) {
    assert.deepEqual(mapCodexTokenUsage(partial), partial);
  }
  assert.deepEqual(mapCodexTokenUsage({ totalTokens: 0 }), { totalTokens: 0 });
  assert.deepEqual(mapCodexTokenUsage({ inputTokens: 7, outputTokens: 9, cachedInputTokens: 3 }),
    { inputTokens: 7, outputTokens: 9, cachedInputTokens: 3, totalTokens: 16 });
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.equal(mapCodexTokenUsage({ inputTokens: invalid }), undefined);
  }
  assert.equal(mapCodexTokenUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }).totalTokens, undefined);
  assert.equal(sumProviderRequestUsage([
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER },
    { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
  ]), undefined, 'overflow must not become an exact aggregate');
  for (const usage of [{ input_tokens: 7 }, { output_tokens: 9 }, { cached_input_tokens: 3 }]) {
    const done = mapCodexEvent({ type: 'turn.completed', usage }).find(e => e.type === 'turn_done');
    assert.equal(done.usage.totalTokens, undefined);
  }
  const claude = usage => mapClaudeAssistantUsage({ type: 'assistant', message: { usage } });
  assert.deepEqual(claude({ cache_read_input_tokens: 4 }), { cachedInputTokens: 4 });
  assert.deepEqual(claude({ input_tokens: 7 }), { inputTokens: 7 });
  assert.deepEqual(claude({ output_tokens: 9 }), { outputTokens: 9 });
  assert.deepEqual(claude({ input_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 9 }),
    { inputTokens: 13, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 9, totalTokens: 22 });
  assert.deepEqual(claude({ input_tokens: 7, cache_read_input_tokens: -1, output_tokens: 9 }), { outputTokens: 9 });
});

test('persistent Claude root diagnostics disclose discarded stderr and retain the final cause', { timeout: 5_000 }, async () => {
  const { ClaudeStreamSession } = await import('../../packages/engines/dist/claude-stream-session.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-tail-regression-'));
  const bin = path.join(root, 'fake-claude');
  const { chmodSync } = await import('node:fs');
  writeFileSync(bin, '#!' + process.execPath + '\nprocess.stdin.resume();process.stderr.write("😀"+"x".repeat(8191)+"END!",()=>process.exit(7));\n');
  chmodSync(bin, 0o700);
  const roots = [];
  let notifyDrained;
  const drainedRoot = new Promise(resolve => { notifyDrained = resolve; });
  let runtime;
  try {
    runtime = new ClaudeStreamSession({ bin, cwd: root, history: [], sandboxMode: 'danger-full-access', permissionMode: 'bypassPermissions',
      killGraceMs: 100, signal: new AbortController().signal, onRuntimeSpawned() {}, onRuntimeRootExit: value => { roots.push(value); if (typeof value.stderr === 'string') notifyDrained(); } });
    const events = [];
    for await (const event of runtime.events) events.push(event);
    await drainedRoot;
    const drained = roots.find(value => typeof value.stderr === 'string');
    assert.match(drained.stderr, /^\[stderr truncated: 5 UTF-16 code units omitted;/u);
    assert.ok(drained.stderr.endsWith('END!'));
    assert.equal(drained.exitCode, 7);
    assert.match(events.find(event => event.type === 'error').message, /stderr truncated/u);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude native partial text streams once, reconciles completion and preserves native tool events', async () => {
  const { claudeStreamEventMapper } = await import('../../packages/engines/dist/claude-stream-events.js');
  const map = claudeStreamEventMapper();
  const wrap = event => ({ type: 'stream_event', session_id: 'session', parent_tool_use_id: null, event });
  map({ type: 'system', subtype: 'init', session_id: 'session' });
  map(wrap({ type: 'message_start', message: { id: 'message-1' } }));
  assert.deepEqual(map(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })), []);
  assert.deepEqual(map(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } })), [{ type: 'text', delta: 'Hello ' }]);
  assert.deepEqual(map({ ...wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'foreign' } }), session_id: 'foreign' }), []);
  assert.deepEqual(map({ ...wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child' } }), parent_tool_use_id: 'child-tool' }), []);
  const complete = content => ({ type: 'assistant', session_id: 'session', parent_tool_use_id: null, message: { id: 'message-1', content } });
  assert.deepEqual(map(complete([{ type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 'native-call', name: 'Bash', input: { command: 'echo fixture' } }])),
    [{ type: 'text', delta: 'world' }, { type: 'command', command: 'echo fixture', cwd: '', callId: 'native-call' }]);
  map(wrap({ type: 'message_start', message: { id: 'message-1' } }));
  map(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Provisional' } }));
  assert.deepEqual(map(complete([{ type: 'text', text: 'Corrected' }])),
    [{ type: 'text', delta: '\n[Claude corrected provisional streamed text; complete text follows]\nCorrected' }]);
  map(wrap({ type: 'message_start', message: { id: 'message-1' } }));
  map(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Old' } }));
  map({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(map(complete([{ type: 'text', text: 'Full completed fallback' }])), [{ type: 'text', delta: 'Full completed fallback' }]);
});

for (const persistent of [false, true]) test(`Claude native launch emits partial execution text before completion: retained=${persistent}`, { timeout: 5_000 }, async () => {
  const { ClaudeAdapter } = await import('../../packages/engines/dist/claude.js');
  const { ClaudeStreamSession } = await import('../../packages/engines/dist/claude-stream-session.js');
  const { chmodSync } = await import('node:fs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-partial-launch-'));
  const bin = path.join(root, 'fake-claude');
  const emit = value => `{const event=JSON.parse(${JSON.stringify(JSON.stringify(value))});if('session_id' in event)event.session_id=fixtureSession;console.log(JSON.stringify(event));}`;
  const envelope = event => ({ type: 'stream_event', session_id: 'fixture-session', parent_tool_use_id: null, event });
  writeFileSync(bin, '#!' + process.execPath + '\n' +
    'if(!process.argv.includes("--include-partial-messages"))throw Error("Native partials were not requested");\n' +
    'const fixtureSession = process.argv.includes("--session-id") ? process.argv[process.argv.indexOf("--session-id")+1] : "fixture-session";\n' +
    'const launch=()=>{console.log(JSON.stringify({type:"system",subtype:"init",session_id:fixtureSession}));\n' +
    emit(envelope({ type: 'message_start', message: { id: 'fixture-message' } })) +
    emit(envelope({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })) +
    emit(envelope({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Early native text. ' } })) +
    'setTimeout(()=>{' + emit({ type: 'assistant', session_id: 'fixture-session', parent_tool_use_id: null,
      message: { id: 'fixture-message', content: [{ type: 'text', text: 'Early native text. Completed tail.' }] } }) +
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-session' }) + 'process.exit(0);},100);};\n' +
    'if(process.argv.includes("--input-format")){require("node:readline").createInterface({input:process.stdin}).on("line",line=>{if(JSON.parse(line).type==="user")launch();});}else launch();\n');
  chmodSync(bin, 0o700);
  let runtime;
  const handles = [];
  const options = { cwd: root, history: [], prompt: 'Synthetic input', signal: new AbortController().signal,
    onRuntimeSpawned: handle => handles.push(handle), onRuntimeRootExit() {} };
  try {
    runtime = persistent ? new ClaudeStreamSession({ ...options, bin, permissionMode: 'bypassPermissions', killGraceMs: 100 }) : undefined;
    if (runtime) await runtime.startTurn({prompt:'Synthetic input',kind:'user_message'});
    const source = runtime?.events ?? new ClaudeAdapter({ bin, killGraceMs: 100 }).seed(options);
    const events = [];
    for await (const event of source) {
      events.push(event);
      if (event.type === 'turn_done') break;
    }
    assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.delta), ['Early native text. ', 'Completed tail.']);
    assert.equal(events.at(-1).type, 'turn_done');
  } finally { await runtime?.close(); await Promise.all(handles.map(handle => handle.close())); await rm(root, { recursive: true, force: true }); }
});


test('Claude billing environment freezes configured selectors and refuses conflicting human mode without changing host environment',async()=>{
 const {claudeBillingEnvironment}=await import('../../packages/engines/dist/runtime-environment.js');
 const overrides={ANTHROPIC_API_KEY:'synthetic-only-key',ANTHROPIC_AUTH_TOKEN:undefined,CLAUDE_CODE_OAUTH_TOKEN:undefined};
 const env=claudeBillingEnvironment(overrides,'api');overrides.ANTHROPIC_API_KEY='changed-synthetic-key';
 assert.equal(env.ANTHROPIC_API_KEY,'synthetic-only-key');
 assert.throws(()=>claudeBillingEnvironment(overrides,'subscription'),/billing-mode selection/);
 assert.throws(()=>claudeBillingEnvironment({...overrides,CLAUDE_CODE_OAUTH_TOKEN:'synthetic-oauth'},'api'),/billing-mode selection/);
 assert.throws(()=>claudeBillingEnvironment({...overrides,ANTHROPIC_API_KEY:undefined},'api'),/billing-mode selection/);
 assert.equal(claudeBillingEnvironment({...overrides,ANTHROPIC_API_KEY:undefined},'subscription').ANTHROPIC_API_KEY,undefined);
});


for (const mode of ['subscription','api']) test('executing Codex account mode fences thread and turn admission '+mode,async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'ponderosa-billing-admission-')),handles=[];let session;
 const type=mode==='api'?'apiKey':'chatgpt';
 writeFileSync(path.join(root,'app-server'),`
  const fs=require('node:fs');const seen=[];
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
   const m=JSON.parse(line);if(m.id===undefined)return;seen.push(m.method);fs.writeFileSync('seen.json',JSON.stringify(seen));
   const changed=fs.existsSync('changed');
   const result=m.method==='initialize'?{userAgent:'codex/0.100.0'}:
    m.method==='account/read'?{account:{type:changed?${JSON.stringify(type==='apiKey'?'chatgpt':'apiKey')}:${JSON.stringify(type)}}}:
    m.method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:'saved'}};
   console.log(JSON.stringify({id:m.id,result}));
  });
 `);
 try{
  session=await CodexAppServerSession.open({bin:process.execPath,cwd:root,agentId:'a',history:[],resumeSessionId:'saved',
   expectedBillingMode:mode,sandboxMode:'read-only',signal:new AbortController().signal,killGraceMs:50,
   onRuntimeSpawned:h=>handles.push(h),onRuntimeRootExit(){}});
  const seen=JSON.parse(readFileSync(path.join(root,'seen.json'),'utf8'));
  assert.ok(seen.indexOf('account/read')<seen.indexOf('thread/resume'));
  writeFileSync(path.join(root,'changed'),'');
  await assert.rejects(session.startTurn({prompt:'must stay pending'}),/billing mode/);
  assert.equal(JSON.parse(readFileSync(path.join(root,'seen.json'),'utf8')).includes('turn/start'),false);
 }finally{await session?.close();await Promise.all(handles.map(h=>h.close()));await rm(root,{recursive:true,force:true});}
});
