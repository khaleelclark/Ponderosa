import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JsonRpcProcess } from "../dist/json-rpc-process.js";
import { LineBuffer, JsonlRecordLimitError } from "../dist/jsonl.js";
import { defaultEngineRegistrations } from "../dist/index.js";
import { decodeGrokAcpInitialization, decodeGrokAcpMcpInventory, initializeGrokAcpProtocol } from "../dist/grok-acp-protocol.js";

const captured = JSON.parse(await readFile(new URL("./fixtures/grok-acp-1.0.46.json", import.meta.url), "utf8"));
const frames = captured.cases["acp-hostwire.json"];
const initialization = frames.find(frame => frame.receive?.id === 1).receive;
const inventory = captured.cases["acp-mcp.json"][0].receive;
const lockedInventory = captured.cases["acp-mcp-locked.json"][0].receive;

// Local fixture playback, never a Grok process/model. Adversarial and reverse
// frames below are synthetic host regression cases, not captured Grok parity.
const fixture = `
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const { cases } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const frames = cases['acp-hostwire.json'];
const mode = process.argv[3];
const emit = value => {
 const bytes = Buffer.from(JSON.stringify(value)+'\\n');
 for(let i=0;i<bytes.length;i+=17) process.stdout.write(bytes.subarray(i,i+17));
};
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if(mode==='paced-flood' && request.method==='fixture/continue') {
  emit({method:'fixture/notice',params:{i:request.params.i}}); return;
 }
 if(request.method===undefined) { emit({method:'fixture/response',params:request}); return; }
 if(mode==='silent') return;
 if(mode==='oversized') { process.stdout.write('x'.repeat(4*1024*1024+1)); return; }
 if(mode==='aggregate') { process.stdout.write(' '.repeat(1025)); return; }
 if(mode==='malformed') {
  process.stdout.write('null\\n[]\\n7\\n{broken\\n');
  for(const value of [
   {id:request.id,method:'bad',result:{}},
   {id:request.id,result:{},error:{code:-1,message:'bad'}},
   {id:request.id,error:[]},
   {id:String(request.id),result:'wrong id type'},
   {jsonrpc:'1.0',id:request.id,result:{}},
   {id:request.id,method:7},
  ]) emit(value);
 }
 const reply = frames.find(frame => frame.send?.method===request.method);
 const index = frames.indexOf(reply);
 const response = frames[index+1]?.receive;
 emit(response ? {...response,id:request.id} : {id:request.id,result:{}});
 if(mode==='malformed') emit({id:request.id,result:'duplicate response'});
 if(mode==='replay') {
  emit(cases['acp-mcp.json'][0].receive);
  emit(cases['acp-mcp-locked.json'][0].receive);
 }
 if(mode==='flood') for(let i=0;i<4;i++) emit({method:'fixture/notice',params:{i}});
 if(mode==='paced-flood') emit({method:'fixture/notice',params:{i:0}});
 if(mode==='reverse' || mode==='reverse-string' || mode==='unsupported') {
  const id=mode==='reverse-string'?'fixture-string':-3;
  emit({id,method:'fixture/reverse',params:{inert:true}});
  emit({id,method:'fixture/reverse',params:{inert:true}});
  if(mode!=='unsupported') emit({method:'fixture/reverse_sent'});
 }
 if(mode==='reverse-flood') for(let i=0;i<3;i++) emit({id:-10-i,method:'fixture/reverse'});
});
`;

async function runtime(t, mode, overrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "grok-acp-fixture-"));
  const script = join(cwd, "fixture.mjs");
  await writeFile(script, fixture);
  const controller = new AbortController();
  const exits = [];
  let reportRootExit;
  const rootExit = new Promise(resolve => { reportRootExit = resolve; });
  let handle;
  const deadline = setTimeout(() => controller.abort(), 5_000);
  const rpc = new JsonRpcProcess({
    bin: process.execPath, args: [script, fileURLToPath(new URL("./fixtures/grok-acp-1.0.46.json", import.meta.url)), mode],
    cwd, signal: controller.signal, killGraceMs: 100,
    maxOutputBytes: 64 * 1024, maxPendingRequests: 8, maxQueuedNotifications: 8,
    onRuntimeSpawned: value => { handle = value; },
    onRuntimeRootExit: detail => { exits.push(detail); reportRootExit(); }, ...overrides,
  });
  assert.equal(handle, rpc, "the host owns cleanup before initialization");
  t.after(async () => {
    clearTimeout(deadline);
    await handle.close();
    assert.equal(handle.isAlive(), false, "observed owned group exit");
    await rm(cwd, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({mode,cleanup:true,cwd,identity:handle.processIdentity,alive:false}));
  });
  return { rpc, controller, exits, handle, rootExit };
}

test("captured ACP initialize uses the observed client envelope and generic error correlation", async t => {
  const sent = frames.find(frame => frame.send?.method === "initialize").send;
  const { rpc } = await runtime(t, "replay");
  const original = rpc.request.bind(rpc);
  t.mock.method(rpc, "request", (method, params) => {
    if (method === "initialize") assert.deepEqual({method,params}, {method:sent.method,params:sent.params});
    return original(method, params);
  });
  assert.deepEqual(await initializeGrokAcpProtocol(rpc), {
    protocolVersion: 1, advertisedAgentVersion: "1.0.46", advertisedAuthMethodIds: ["grok.com"],
  });
  await assert.rejects(rpc.request("stage0/unknown", {}), error => {
    assert.deepEqual(error.rpcError, {code:-32601,message:"Method not found"});
    return true;
  });
  assert.deepEqual(await rpc.request("session/close", {sessionId:"stage0-nonexistent"}), {_meta:{"x.ai/closeOutcome":"notResident"}});
  const iterator = rpc.notifications[Symbol.asyncIterator]();
  assert.deepEqual(decodeGrokAcpMcpInventory((await iterator.next()).value), ["stage0_inert"]);
  assert.deepEqual(decodeGrokAcpMcpInventory((await iterator.next()).value), []);
});

test("decoders discard sensitive/unproven metadata and reject malformed or duplicate identifiers", () => {
  const value = structuredClone(initialization.result);
  value._meta.systemPromptOverride = "untrusted synthetic metadata";
  assert.deepEqual(Object.keys(decodeGrokAcpInitialization(value)), ["protocolVersion","advertisedAgentVersion","advertisedAuthMethodIds"]);
  for (const invalid of [null, [], {}, {...value,protocolVersion:2}, {...value,authMethods:[{id:"grok.com"},{id:"grok.com"}]}, {...value,authMethods:Array(129).fill({id:"x"})}]) {
    assert.throws(() => decodeGrokAcpInitialization(invalid), /invalid|duplicate/);
  }
  assert.deepEqual(decodeGrokAcpMcpInventory(inventory), ["stage0_inert"]);
  assert.deepEqual(decodeGrokAcpMcpInventory(lockedInventory), []);
  assert.equal(decodeGrokAcpMcpInventory({method:"unknown",params:null}), undefined);
  for (const rows of [null,[{name:"same"},{name:"same"}],[{name:"bad\u0000name"}]]) {
    assert.throws(() => decodeGrokAcpMcpInventory({method:inventory.method,params:{mcpServers:rows}}), /invalid|duplicate/);
  }
});

test("malformed envelopes and duplicate responses cannot settle another request or crash parsing", async t => {
  const { rpc } = await runtime(t, "malformed");
  assert.equal((await initializeGrokAcpProtocol(rpc)).advertisedAgentVersion, "1.0.46");
  await assert.rejects(rpc.request("stage0/unknown", {}), error => error.rpcError.code === -32601);
});

test("caller abort rejects bounded pending requests and closes the owned process", async t => {
  const {rpc,controller} = await runtime(t, "silent", {maxPendingRequests:1});
  const pending = assert.rejects(rpc.request("initialize", {}), /closed/);
  await assert.rejects(rpc.request("initialize", {}), /pending request limit/);
  controller.abort();
  await pending;
  await rpc.close();
  assert.equal(rpc.isAlive(), false);
});

test("a local serialization failure releases the correlation slot", async t => {
  const {rpc} = await runtime(t,"malformed",{maxPendingRequests:1});
  await assert.rejects(rpc.request("initialize",{invalid:1n}),/BigInt/);
  assert.equal((await initializeGrokAcpProtocol(rpc)).protocolVersion,1);
});

for (const [mode, options, reason] of [
  ["flood", {maxQueuedNotifications:2}, /notification queue limit/],
  ["aggregate", {maxOutputBytes:1024}, /aggregate limit/],
  ["oversized", {maxOutputBytes:undefined}, /JSONL record exceeded/],
]) {
  test(`bounded stream: ${mode} revokes transport and retains cleanup authority`, async t => {
    const {rpc,controller,exits,handle,rootExit} = await runtime(t, mode, options);
    const request = rpc.request("initialize", {}).catch(error => error);
    if (mode === "flood") {
      // Cap two RETAINED notices: withhold consumption until the four-notice
      // producer overflows. A concurrent waiter need not retain any notice.
      let aborted;
      const deadline = new Promise(resolve => {
        aborted = resolve;
        controller.signal.addEventListener("abort", aborted, {once:true});
      });
      try { await Promise.race([rootExit, deadline]); }
      finally { controller.signal.removeEventListener("abort", aborted); }
      assert.equal(controller.signal.aborted, false, "overflow precedes the existing host deadline");
    }
    const notices = [];
    for await (const notice of rpc.notifications) notices.push(notice);
    await request;
    assert.equal(exits.length, 1);
    assert.ok(notices.some(notice => notice.method === "ponderosa/processError" && reason.test(notice.params.message)));
    if (mode === "flood") {
      assert.deepEqual(notices, [
        {method:"fixture/notice",params:{i:0}},
        {method:"ponderosa/processError",params:{message:"engine RPC notification queue limit exceeded"}},
      ], "cap two reserves exactly one terminal error instead of the retained tail");
      assert.deepEqual(await rpc.notifications[Symbol.asyncIterator]().next(), {value:undefined,done:true});
      await assert.rejects(rpc.request("late"), /closed/);
    }
    assert.equal(handle, rpc, "same registered cleanup owner");
    await handle.close();
    assert.equal(rpc.isAlive(), false);
  });
}

test("four cumulative notices fit cap two when each has a waiting consumer", async t => {
  const {rpc,controller,exits,handle} = await runtime(t, "paced-flood", {maxQueuedNotifications:2});
  const iterator = rpc.notifications[Symbol.asyncIterator]();
  const first = iterator.next();
  const request = rpc.request("initialize", {});
  assert.deepEqual((await first).value, {method:"fixture/notice",params:{i:0}});
  for (let i=1;i<4;i++) {
    const next = iterator.next();
    rpc.notify("fixture/continue", {i});
    assert.deepEqual((await next).value, {method:"fixture/notice",params:{i}});
  }
  assert.deepEqual(await request, initialization.result);
  assert.equal(controller.signal.aborted, false);
  assert.equal(exits.length, 0, "cumulative delivery alone does not overflow retained cap two");
  assert.equal(handle.isAlive(), true);
  await handle.close();
  assert.equal(handle.isAlive(), false);
  assert.deepEqual(await iterator.next(), {value:undefined,done:true});
  assert.equal(exits.length, 0, "host close is expected");
});

for(const [mode,id] of [['reverse',-3],['reverse-string','fixture-string']]) {
test(`${typeof id} reverse requests reuse the generic handler and ignore duplicates while in flight`, async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => {release=resolve;});
  const {rpc} = await runtime(t, mode, {
    handleServerRequest: async (requestId,method,params) => {
      calls++;
      assert.equal(requestId,id); assert.equal(method,"fixture/reverse"); assert.deepEqual(params,{inert:true});
      await gate;
      return {inert:true};
    },
  });
  await initializeGrokAcpProtocol(rpc);
  const iterator=rpc.notifications[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.method,'fixture/reverse_sent');
  release();
  const next = await iterator.next();
  assert.deepEqual(next.value.params, {id,result:{inert:true}});
  assert.equal(calls, 1, "synthetic host test only; no Grok reverse request was captured");
});
}

test("unsupported reverse requests are denied without invoking a tool", async t => {
  const {rpc} = await runtime(t, "unsupported");
  await initializeGrokAcpProtocol(rpc);
  const next = await rpc.notifications[Symbol.asyncIterator]().next();
  assert.equal(next.value.params.error.code, -32601);
});

test("excess active reverse requests fail closed and late handler results stay revoked", async t => {
  let release, calls=0;
  const gate = new Promise(resolve => {release=resolve;});
  const {rpc,exits} = await runtime(t,"reverse-flood", {maxPendingRequests:2,handleServerRequest:async () => {calls++;await gate;return {};}});
  await initializeGrokAcpProtocol(rpc);
  const notices=[];
  for await (const notice of rpc.notifications) notices.push(notice);
  assert.equal(calls,2); assert.equal(exits.length,1);
  assert.match(notices.at(-1).params.message,/reverse request limit/);
  release();
  await rpc.close();
});

test("failed teardown rejects protocol work but retains the same retryable process owner", {skip:process.platform==='win32'}, async t => {
  const {rpc,handle} = await runtime(t,"silent");
  const pending=assert.rejects(rpc.request("initialize",{}),/closed/);
  const pgid=rpc.processIdentity.pgid;
  const kill=process.kill.bind(process);
  const mocked=t.mock.method(process,"kill",(pid,signal) => {
    if(pid===-pgid || pid===pgid) {
      if(signal===0) return true;
      throw Object.assign(new Error("inert injected signal denial"),{code:"EPERM"});
    }
    return kill(pid,signal);
  });
  try {
    await assert.rejects(handle.close(),/remained alive/);
    await pending;
    assert.equal(handle.isAlive(),true,"a rejected close does not release authority");
    await assert.rejects(rpc.request("initialize",{}),/closed/);
  } finally {mocked.mock.restore();}
  await handle.close();
  assert.equal(handle.isAlive(),false,"retry observes actual group exit");
});

test("the existing byte-bound line parser preserves split UTF-8 and rejects overlong partial records", () => {
  const bytes=Buffer.from('😀\r\n{"ok":true}\n');
  const lines=new LineBuffer(11), result=[];
  for(const byte of bytes) result.push(...lines.push(Buffer.from([byte])));
  assert.deepEqual(result,['😀','{"ok":true}']);
  assert.equal(lines.flush(),undefined);
  assert.throws(() => lines.push('x'.repeat(12)),JsonlRecordLimitError);
  assert.deepEqual(lines.push('ok\n'),['ok']);
});

test("invalid transport limits fail before spawn and Grok remains unregistered", () => {
  for(const limit of [0,-1,Infinity,1.5]) assert.throws(() => new JsonRpcProcess({maxPendingRequests:limit}), /positive safe integers/);
  assert.deepEqual(defaultEngineRegistrations({}).map(value => value.adapter.id), ['codex','claude']);
});
