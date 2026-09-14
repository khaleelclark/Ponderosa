// Run against a disposable, locally bound Ponderosa and a disposable Chrome CDP
// instance. Creates one Project/Chat and one native Agent Run; retain the runtime
// data for evidence, then remove that disposable runtime after all Runs settle.
// PONDEROSA_DISPOSABLE=1 PONDEROSA_TEST_ORIGIN=http://127.0.0.1:18898 \
// PONDEROSA_TEST_CDP=http://127.0.0.1:18899 node apps/web/scripts/check-sent-draft-race.mjs
import assert from 'node:assert/strict';
const origin = new URL(process.env.PONDEROSA_TEST_ORIGIN);
const cdp = new URL(process.env.PONDEROSA_TEST_CDP);
assert.equal(process.env.PONDEROSA_DISPOSABLE, '1');
for (const url of [origin, cdp]) {
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) >= 18000, 'Only explicit disposable high ports are allowed');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, body) {
  const result = await fetch(new URL(path, origin), { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body) });
  const value = await result.json();
  assert.ok(result.ok, JSON.stringify(value));
  return value;
}
const project = await post('/api/projects', {label:'Disposable draft race',defaultEngine:'codex'});
const chat = await post(`/api/projects/${project.id}/conversations`, {title:'Delayed send',defaultEngine:'codex'});
console.log('Disposable fixture:', project.id, chat.id);
const tabs = await (await fetch(new URL('/json/list', cdp))).json();
const ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, {once:true}));
let id = 0;
const pending = new Map();
let held;
ws.addEventListener('message', ({data}) => {
  const message = JSON.parse(data);
  if (message.id) {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback?.reject(new Error(JSON.stringify(message.error)));
    else callback?.resolve(message.result);
  } else if (message.method === 'Fetch.requestPaused') {
    if (message.params.request.method === 'POST') held = message.params.requestId;
    else void send('Fetch.continueResponse', {requestId:message.params.requestId});
  }
});
function send(method, params={}) {
  return new Promise((resolve,reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {pending.delete(requestId);reject(new Error(`${method} timed out`));}, 10000);
    pending.set(requestId, {resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression, timeout=15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if(await evaluate(expression)) return;await pause(100);}
  throw new Error(`Timed out waiting for ${expression}: ${(await evaluate('document.body.innerText')).slice(-2000)}`);
}
const editor = 'document.querySelector("[contenteditable=true]")';
const marker = `DRAFT_ACK_${crypto.randomUUID().replaceAll('-','')}`;
const prompt = `#new-agent Use ponderosa_send_message to reply to #operator in this Project Chat with exactly ${marker}. Then finish; no other work.`;
try {
  await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled:true});
  await send('Network.setBypassServiceWorker', {bypass:true});
  await send('Page.navigate', {url:new URL(`/projects/${project.id}/chats/${chat.id}`,origin).href});
  await wait(`!!${editor}`);
  await pause(1000);
  await send('Fetch.enable', {patterns:[{urlPattern:'*/api/projects/*/agents',requestStage:'Response'}]});
  await evaluate(`${editor}.focus()`);
  await send('Input.insertText', {text:prompt});
  await pause(700);
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait(`[...document.querySelectorAll('p')].some(element => [${JSON.stringify(marker)}, ${JSON.stringify(`#operator ${marker}`)}].includes(element.textContent.trim()))`, 60000);
  assert.ok(held, 'Response must arrive through SSE before HTTP send acknowledgement');
  await send('Fetch.continueResponse', {requestId:held});held=undefined;
  await send('Fetch.disable');
  await wait(`!!${editor}`);
  await pause(1500);
  assert.ok(!(await evaluate(`${editor}.innerText`)).includes(marker), 'Sent text must clear after acknowledgement');
  assert.ok(!(await evaluate('document.body.innerText')).includes('This draft changed elsewhere'));
  await send('Page.reload', {ignoreCache:true});
  await wait(`!!${editor}`);await pause(1500);
  assert.ok(!(await evaluate(`${editor}.innerText`)).includes(marker), 'Sent draft must stay cleared after reload');
  console.log('PASS: reply before acknowledgement clears sent text and remains cleared after reload');
} finally {
  if (held) await send('Fetch.continueResponse', {requestId:held}).catch(()=>{});
  await send('Fetch.disable').catch(()=>{});
  ws.close();
}
