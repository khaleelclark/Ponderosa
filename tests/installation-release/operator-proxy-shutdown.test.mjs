import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const proxy = fileURLToPath(new URL('../../apps/server/dist/operator-auth-proxy.js', import.meta.url));
import {OPERATOR_IDENTITY_HEADER} from '../../apps/server/dist/security.js';
const token = 'owned-proxy-fixture-token'.padEnd(40, 'x');
const identity = 'operator@qualification.test';
async function bounded(promise, label, milliseconds = 2_000) {
  const abort = new AbortController();
  try {
    return await Promise.race([promise, delay(milliseconds, undefined, { signal: abort.signal }).then(() => { throw Error(label); })]);
  } finally { abort.abort(); }
}

// Exercise the shipped signal handler in a real owned child, not server.close()
// in the test process. No provider, app state or existing proxy is touched.
for (const [kind, signal, identityHeader = 'tailscale-user-login'] of [
  ['completed HTTP/authentication controls', 'SIGTERM'],
  ['completed HTTP/authentication controls', 'SIGTERM', 'x-owned-upstream-identity'],
  ['active HTTP response', 'SIGINT'],
  ['SSE response', 'SIGTERM'],
  ['incomplete upload', 'SIGINT'],
  ['incomplete request headers', 'SIGTERM'],
  ['established upgrade', 'SIGINT'],
  ['pending upgrade', 'SIGTERM'],
  ['rejected upgrade', 'SIGINT'],
]) test(`operator proxy ${signal} closes ${kind} and observes exit`, {
  timeout: 15_000,
  skip: process.platform === 'win32' ? 'Host-local Unix proxy is a POSIX deployment option' : false,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pqs-')), socketPath = path.join(root, 's');
  const headers = { host: 'qualification.test', [identityHeader]: identity };
  const sockets = new Set();
  let observed, child, exited, client, response, passed = false, stderr = '', backendRequests = 0, lastAuthorization;
  const received = new Promise(resolve => { observed = resolve; });
  const backend = createServer((incoming, outgoing) => {
    backendRequests++;
    incoming.on('error', () => {});
    assert.notEqual(incoming.headers.authorization, `Bearer ${token}`);
    lastAuthorization=incoming.headers.authorization;
    assert.equal(incoming.headers[OPERATOR_IDENTITY_HEADER], undefined);
    assert.equal(incoming.headers['tailscale-user-login'], undefined);
    assert.equal(incoming.headers.host, 'qualification.test');
    assert.equal(incoming.headers['x-remove-me'], undefined);
    if (kind === 'completed HTTP/authentication controls') outgoing.end('exact completed response: café 東京');
    else if (kind === 'incomplete upload') incoming.once('data', observed);
    else {
      outgoing.writeHead(200, { 'content-type': kind === 'SSE response' ? 'text/event-stream' : 'text/plain' });
      outgoing.write('data: owned response\n\n');
      observed();
    }
  });
  backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  backend.on('upgrade', (incoming, socket) => {
    assert.notEqual(incoming.headers.authorization, `Bearer ${token}`);
    lastAuthorization=incoming.headers.authorization;
    assert.equal(incoming.headers[OPERATOR_IDENTITY_HEADER], undefined);
    assert.equal(incoming.headers['tailscale-user-login'], undefined);
    socket.resume();
    socket.once('end', () => socket.end());
    if (kind === 'established upgrade') socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    observed();
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  try {
    child = spawn(process.execPath, [proxy], { env: {
      PATH: process.env.PATH,
      PONDEROSA_PROXY_SOCKET_PATH: socketPath,
      PONDEROSA_PROXY_BACKEND_PORT: String(backend.address().port),
      PONDEROSA_PROXY_BACKEND_TOKEN: token,
      PONDEROSA_PROXY_PUBLIC_ORIGIN: 'https://qualification.test',
      PONDEROSA_PROXY_IDENTITY_HEADER: identityHeader,
      PONDEROSA_PROXY_ALLOWED_IDENTITIES: identity,
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    await bounded((async () => {
      while (!await stat(socketPath).catch(() => false)) {
        assert.equal(child.exitCode, null, stderr); await delay(10);
      }
    })(), 'Owned proxy did not listen', 5_000);

    if (kind === 'completed HTTP/authentication controls') {
      const fetch = extra => new Promise((resolve, reject) => {
        const req = request({ socketPath, path: '/', headers: { ...headers, ...extra } }, result => {
          let body = ''; result.setEncoding('utf8'); result.on('data', chunk => { body += chunk; });
          result.once('end', () => resolve({ status: result.statusCode, body })); result.once('error', reject);
        }); req.once('error', reject); req.end();
      });
      assert.equal((await fetch({ [identityHeader]: 'wrong@qualification.test', [OPERATOR_IDENTITY_HEADER]: identity })).status, 200);
      assert.equal((await fetch({ 'x-forwarded-host': 'wrong.test' })).status, 200);
      assert.equal(backendRequests, 2, 'The bridge imposes no network identity gate');
      const result = await fetch({ authorization: 'Bearer untrusted-client-token', [OPERATOR_IDENTITY_HEADER]: 'forged@client.test', connection: 'x-remove-me', 'x-remove-me': 'private-hop' });
      assert.deepEqual(result, { status: 200, body: 'exact completed response: café 東京' });
      assert.equal(backendRequests, 3);
      assert.equal(lastAuthorization,'Bearer untrusted-client-token','Scoped runtime Authorization is forwarded without an injected operator credential');
    } else if (kind.includes('upgrade') || kind === 'incomplete request headers') {
      client = createConnection({ path: socketPath, allowHalfOpen: kind === 'rejected upgrade' });
      client.on('error', () => {});
      await once(client, 'connect');
      if (kind === 'incomplete request headers') client.write('GET / HTTP/1.1\r\nHost: qualification.test\r\n');
      else {
        const ready = new Promise(resolve => client.once('data', resolve));
        client.write(`GET ${kind === 'rejected upgrade' ? '/not-a-browser' : '/api/hosted-browser/desktop'} HTTP/1.1\r\nHost: qualification.test\r\nTailscale-User-Login: ${identity}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
        if (kind !== 'pending upgrade') {
          const bytes = await bounded(ready, 'Upgrade response missing');
          assert.match(bytes.toString(), kind === 'rejected upgrade' ? /^HTTP\/1.1 404/ : /^HTTP\/1.1 101/);
        }
        if (kind !== 'rejected upgrade') await bounded(received, 'Backend did not observe upgrade');
      }
    } else {
      const receivedBody = new Promise(resolve => {
        client = request({ socketPath, path: '/', method: kind === 'incomplete upload' ? 'POST' : 'GET',
          headers: { ...headers, ...(kind === 'incomplete upload' ? { 'content-length': '100000' } : {}) } }, result => {
          response = result; result.on('error', () => {}); result.once('data', resolve); result.resume();
        });
        client.on('error', () => {});
      });
      if (kind === 'incomplete upload') { client.flushHeaders(); client.write('owned partial upload'); }
      else { client.end(); await bounded(receivedBody, 'Client did not receive active response'); }
      await bounded(received, 'Backend did not receive proxy request');
    }
    // Include a connection with no complete request in the accepting server.
    if (kind === 'incomplete request headers') await delay(50);
    const backendClosed = Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve))));
    const downstreamClosed = response && new Promise(resolve => response.once('close', resolve));
    child.kill(signal);
    assert.deepEqual(await bounded(exited, `Proxy kept ${kind} alive after ${signal}`), { code: 0, signal: null }, stderr);
    await bounded(backendClosed, 'Owned backend connection leaked after proxy exit');
    if (downstreamClosed) await bounded(downstreamClosed, 'Active response did not close');
    assert.equal(await stat(socketPath).catch(() => undefined), undefined, 'Proxy socket remains after exit');
    passed = true;
  } finally {
    response?.destroy(); client?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => backend.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await exited;
    }
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failed owned proxy fixture retained: ${root}`);
  }
});

import Fastify from 'fastify';
import {registerRequestSecurityHooks} from '../../apps/server/dist/server-request-hooks.js';
for(const allowlist of [[],['verified@fixture.test']])test(`authenticated rate buckets ignore unvalidated rotated claims; allowlist=${allowlist.length}`,async t=>{
 const app=Fastify();t.after(()=>app.close());
 registerRequestSecurityHooks(app,{opts:{authToken:token,operatorIdentities:allowlist,networkSecurity:{mode:'reverse_proxy',bindHost:'127.0.0.1'},requestLimits:{maxRequestsPerMinute:2,maxInflight:2}},v3DispatchKey:'private-dispatch',agentMessageCapabilities:new Map(),deletingAgentIds:new Set(),validLauncherSession:()=>false,artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,isPublicWebAssetRequest:()=>false});
 app.get('/api/owned',async()=>({ok:true}));
 app.post('/api/agents/:id/cancel',async()=>({ok:true}));
 for(let i=0;i<4;i++){
  const r=await app.inject({url:'/api/owned',headers:{host:'localhost',authorization:'Bearer '+token,'tailscale-user-login':'rotation-'+i,[OPERATOR_IDENTITY_HEADER]:allowlist[0]??'unvalidated-'+i}});
  assert.equal(r.statusCode,i<2?200:429,r.body);
 }
 const r=await app.inject({url:'/api/owned',headers:{host:'localhost',[OPERATOR_IDENTITY_HEADER]:'intruder@fixture.test'}});assert.equal(r.statusCode,429,'Rotating a claim cannot bypass the shared capacity budget');
 assert.equal((await app.inject({method:'POST',url:'/api/agents/owned/cancel'})).statusCode,200,'Stop has reserved rate capacity');
});

import {resolveNetworkSecurity} from '../../packages/core/dist/config.js';

test('Stop can enter while ordinary handlers occupy their last slot', async t => {
 const app = Fastify();
 t.after(() => app.close());
 registerRequestSecurityHooks(app, {
  opts: {requestLimits: {maxRequestsPerMinute: 20, maxInflight: 2}},
  agentMessageCapabilities: new Map(), deletingAgentIds: new Set(),
  artifactFilesystemError: () => undefined, isArtifactDependentWorkIntake: () => false,
 });
 const started = Promise.withResolvers();
 const release = Promise.withResolvers();
 app.get('/api/owned', async () => {
  started.resolve();
  await release.promise;
  return {ok: true};
 });
 app.post('/api/agents/:id/cancel', async () => ({ok: true}));
 const pending = app.inject('/api/owned').then(response => response);
 try {
  await Promise.race([started.promise, pending.then(response => {
   assert.fail(`Ordinary handler finished before it entered: ${response.statusCode}`);
  })]);
  assert.equal((await app.inject('/api/owned')).statusCode, 503);
  assert.equal((await app.inject({method: 'POST', url: '/api/agents/owned/cancel'})).statusCode, 200);
 } finally {
  release.resolve();
  assert.equal((await pending).statusCode, 200);
 }
});
test('network configuration accepts arbitrary listeners without operator credentials or VPN dependencies',()=>{
 for(const host of ['0.0.0.0','192.168.1.7','::','ponderosa.internal']){
  const config=resolveNetworkSecurity({PONDEROSA_HOST:host,PONDEROSA_OPERATOR_ORIGINS:'http://ponderosa.internal:8787',NODE_ENV:'production'});
  assert.equal(config.host,host);assert.equal(config.authToken,undefined);assert.equal(config.posture.authenticationRequired,false);assert.equal(config.posture.mode,'trusted_network');
 }
});
test('operator access needs no token, while browser origins and Agent capability boundaries stay enforced',async t=>{
 const app=Fastify();t.after(()=>app.close());
 registerRequestSecurityHooks(app,{opts:{authToken:token,launcherSecurity:{controlToken:'obsolete'},operatorOrigins:['https://owned.test'],operatorIdentities:['obsolete'],networkSecurity:{mode:'reverse_proxy'}},v3DispatchKey:'owned',agentMessageCapabilities:new Map([['live-agent',{agentId:'owned-agent'}]]),deletingAgentIds:new Set(),artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,isPublicWebAssetRequest:()=>false});
 app.get('/api/owned',async()=>({ok:true}));app.post('/api/owned',async()=>({ok:true}));app.post('/api/launcher/owned',async()=>({ok:true}));
 for(const url of ['/api/owned','/api/launcher/owned'])assert.equal((await app.inject({method:'POST',url,headers:{host:'owned.test',origin:'https://owned.test'}})).statusCode,200);
 assert.equal((await app.inject({url:'/api/owned',headers:{host:'arbitrary.internal'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/owned',headers:{host:'arbitrary.internal','x-forwarded-host':'owned.test'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/owned',headers:{host:'owned.test'}})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/owned',headers:{host:'owned.test',origin:'https://outside.test'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/owned',headers:{host:'owned.test','sec-fetch-site':'cross-site'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/owned',headers:{host:'owned.test',authorization:'Bearer live-agent'}})).statusCode,401);
});

test('sandboxed preview assets stay within an owned IPv6 loopback registration', async t => {
 const {createLinkPreviewService}=await import('../../apps/server/dist/link-preview-service.js');
 const upstream=createServer((req,res)=>{
  res.setHeader('content-type',req.url==='/module.js'?'text/javascript':'text/html');
  res.end(req.url==='/module.js'?'export const ready = true;':'<head><script type="module" src="/module.js"></script></head>');
 });
 upstream.listen(0,'::1');
 try { await once(upstream,'listening'); } catch(error) {
  if (['EADDRNOTAVAIL','EAFNOSUPPORT'].includes(error.code)) return t.skip('IPv6 loopback unavailable');
  throw error;
 }
 t.after(()=>new Promise(resolve=>upstream.close(resolve)));
 const app=Fastify();
 t.after(()=>app.close());
 registerRequestSecurityHooks(app,{
  opts:{},agentMessageCapabilities:new Map(),deletingAgentIds:new Set(),
  artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,
 });
 const activeRuns=new Map([['agent',{runId:'run',executionId:'run'}]]);
 createLinkPreviewService({
  store:{getProject:id=>id==='project'?{id}:undefined,getAgent:id=>id==='agent'?{id,projectId:'project'}:undefined},
  activeRuns,ownsActiveRun:()=>true,
 }).registerRoutes(app);
 const issued=await app.inject({method:'POST',url:'/api/link-previews',payload:{
  url:'http://[::1]:'+upstream.address().port+'/',agentId:'agent',projectId:'project',runId:'run',
 }});
 assert.equal(issued.statusCode,200,issued.body);
 const {id,openUrl,targetOrigin}=issued.json();
 assert.equal(targetOrigin,'http://[::1]:'+upstream.address().port);
 const document=await app.inject(openUrl);
 assert.equal(document.statusCode,200,document.body);
 assert.match(document.headers['content-security-policy'],/^sandbox allow-scripts/u);
 assert.ok(document.body.includes(openUrl+'module.js'));
 const assets={url:openUrl+'module.js',headers:{origin:'null','sec-fetch-site':'cross-site'}};
 const asset=await app.inject(assets);
 assert.equal(asset.statusCode,200,asset.body);
 assert.equal(asset.headers['access-control-allow-origin'],'null');
 assert.equal(asset.body,'export const ready = true;');
 activeRuns.clear();
 assert.equal((await app.inject(assets)).statusCode,404);
 assert.ok(id);
});
