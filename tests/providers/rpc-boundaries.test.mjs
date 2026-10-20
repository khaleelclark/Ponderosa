import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonRpcOutputLimitError, JsonRpcProcess } from '../../packages/engines/dist/json-rpc-process.js';
import { discoverCodexAppServerCapabilities } from '../../packages/engines/dist/codex-app-server.js';

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
