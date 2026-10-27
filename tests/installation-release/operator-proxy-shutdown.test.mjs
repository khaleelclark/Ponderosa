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
const headers = { host: 'qualification.test', 'tailscale-user-login': identity };
async function bounded(promise, label, milliseconds = 2_000) {
  const abort = new AbortController();
  try {
    return await Promise.race([promise, delay(milliseconds, undefined, { signal: abort.signal }).then(() => { throw Error(label); })]);
  } finally { abort.abort(); }
}

// Exercise the shipped signal handler in a real owned child, not server.close()
// in the test process. No provider, app state or existing proxy is touched.
for (const [kind, signal] of [
  ['completed HTTP/authentication controls', 'SIGTERM'],
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
  const sockets = new Set();
  let observed, child, exited, client, response, passed = false, stderr = '', backendRequests = 0;
  const received = new Promise(resolve => { observed = resolve; });
  const backend = createServer((incoming, outgoing) => {
    backendRequests++;
    incoming.on('error', () => {});
    assert.equal(incoming.headers.authorization, `Bearer ${token}`);
    assert.equal(incoming.headers[OPERATOR_IDENTITY_HEADER], identity);
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
    assert.equal(incoming.headers.authorization, `Bearer ${token}`);
    assert.equal(incoming.headers[OPERATOR_IDENTITY_HEADER], identity);
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
      PONDEROSA_PROXY_IDENTITY_HEADER: 'tailscale-user-login',
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
      assert.equal((await fetch({ 'tailscale-user-login': 'wrong@qualification.test' })).status, 401);
      assert.equal((await fetch({ 'x-forwarded-host': 'wrong.test' })).status, 421);
      assert.equal(backendRequests, 0, 'Rejected identity/host reached the backend');
      const result = await fetch({ authorization: 'Bearer untrusted-client-token', connection: 'x-remove-me', 'x-remove-me': 'private-hop' });
      assert.deepEqual(result, { status: 200, body: 'exact completed response: café 東京' });
      assert.equal(backendRequests, 1);
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
 for(let i=0;i<4;i++){
  const r=await app.inject({url:'/api/owned',headers:{host:'localhost',authorization:'Bearer '+token,'tailscale-user-login':'rotation-'+i,[OPERATOR_IDENTITY_HEADER]:allowlist[0]??'unvalidated-'+i}});
  assert.equal(r.statusCode,i<2?200:429,r.body);
 }
 if(allowlist.length){const r=await app.inject({url:'/api/owned',headers:{host:'localhost',authorization:'Bearer '+token,[OPERATOR_IDENTITY_HEADER]:'intruder@fixture.test'}});assert.equal(r.statusCode,401);}
});
