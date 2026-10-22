import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVoiceCallAttempt, retainVoiceCallAttempt, restoreVoiceCallAttempt, settleVoiceCallAttempt, voiceCallAttemptCanRetry, VOICE_ATTEMPT_TTL } from '../../apps/web/src/components/speech/voiceCallAttempt.ts';
import { durableSubmissionFingerprint } from '../../apps/web/src/components/idempotentAttempt.ts';
import { readBrowserStorage } from '../../apps/web/src/browserStorage.ts';
const data = new Map();
globalThis.window = { sessionStorage: { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) } };
const words='SYNTHETIC PRIVATE FULL REQUEST';
const route = name => ({origin:'http://test',product:'/api/conversations',projectId:'project',conversationId:name,agentId:'agent'});
const prepare = (name, now=100) => prepareVoiceCallAttempt(route(name), words, () => `key-${name}`, now);
const slot = r => `ponderosa.voice.pending.v1:${JSON.stringify(r)}`;
const legacy = a => { const {idempotencyKey, ...identity}=a.marker;return {...identity,version:1,request:a.request}; };
const prepareLegacy = async name => {
  const a=await prepare(name);const {voiceReply,...request}=a.request;
  return {request,marker:{...a.marker,fingerprint:await durableSubmissionFingerprint(request)}};
};
test('mounted immutable request stays exact; only marker persists and reopening cannot reconstruct words', async () => {
  data.set('ponderosa.workspace.instance.v1','server-one');
  const a=await prepare('one'); assert.equal(retainVoiceCallAttempt(a),true);
  assert.deepEqual(a.request,{text:words,voiceReply:true,idempotencyKey:'key-one',recipients:[{agentId:'agent'}],activeRunDelivery:'queue'});
  assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);
  assert.throws(()=>{a.request.text='changed';},TypeError);assert.throws(()=>{a.request.recipients[0].agentId='changed';},TypeError);
  const raw=data.get(slot(a.marker.route));assert.equal(raw.includes(words),false);assert.equal(raw.includes('request'),false);assert.equal(raw.includes('recipients'),false);
  const restored=await restoreVoiceCallAttempt(a.marker.route,101);assert.deepEqual(restored.marker,a.marker);assert.equal(restored.attempt,undefined);assert.match(restored.notice,/requires Chat review/);
  settleVoiceCallAttempt(a.marker);assert.deepEqual(await restoreVoiceCallAttempt(a.marker.route,102),{});
});
test('foreign origin/product/Project/Chat/Agent neither scans nor restores another slot',async()=>{
  const a=await prepare('isolation');retainVoiceCallAttempt(a);
  for(const patch of [{origin:'http://other'},{product:'/api/branches/engine/conversations'},{projectId:'other'},{conversationId:'other'},{agentId:'other'}]){
    assert.deepEqual(await restoreVoiceCallAttempt({...a.marker.route,...patch},101),{});
    assert.equal(await voiceCallAttemptCanRetry(a,{...a.marker.route,...patch},101),false);
  }
  assert.equal(data.has(slot(a.marker.route)),true);settleVoiceCallAttempt(a.marker);
});
test('changed body/recipient/key/queue/fingerprint and instance cannot retry',async()=>{
  const a=await prepare('immutable');retainVoiceCallAttempt(a);
  assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);
  for(const patch of [{text:'changed'},{idempotencyKey:'changed'},{recipients:[{agentId:'other'}]},{activeRunDelivery:'steer'},{engine:'claude'}]) {
    assert.equal(await voiceCallAttemptCanRetry({...a,request:{...a.request,...patch}},a.marker.route,101),false);
    assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);
  }
  assert.equal(await voiceCallAttemptCanRetry({...a,marker:{...a.marker,fingerprint:'bad'}},a.marker.route,101),false);
  data.set('ponderosa.workspace.instance.v1','other-server');assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),false);data.set('ponderosa.workspace.instance.v1','server-one');
  assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);settleVoiceCallAttempt(a.marker);
});
test('expiry refuses retry and repeated reopen keeps marker warning against replacement',async()=>{
  const a=await prepare('expiry');retainVoiceCallAttempt(a);const now=100+VOICE_ATTEMPT_TTL;
  assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,now),false);
  for(let i=0;i<2;i++)assert.match((await restoreVoiceCallAttempt(a.marker.route,now+i)).notice,/expired/);
  assert.equal(data.get(slot(a.marker.route)).includes(words),false);
  assert.throws(()=>retainVoiceCallAttempt({...a,marker:{...a.marker,idempotencyKey:'replacement'}}),/unresolved/);settleVoiceCallAttempt(a.marker);
});
test('valid legacy request becomes text-free inspection-only marker, never returned payload',async()=>{
  const a=await prepareLegacy('legacy');data.set(slot(a.marker.route),JSON.stringify(legacy(a)));
  const result=await restoreVoiceCallAttempt(a.marker.route,101);assert.deepEqual(result.marker,a.marker);assert.equal(result.attempt,undefined);assert.equal(JSON.stringify(result).includes(words),false);
  assert.equal(data.get(slot(a.marker.route)),JSON.stringify(a.marker));settleVoiceCallAttempt(a.marker);
});
test('expired legacy private record is converted without dropping unknown-outcome warning',async()=>{
  const a=await prepareLegacy('oldlegacy');data.set(slot(a.marker.route),JSON.stringify(legacy(a)));
  assert.match((await restoreVoiceCallAttempt(a.marker.route,100+VOICE_ATTEMPT_TTL)).notice,/expired/);
  assert.equal(data.get(slot(a.marker.route)).includes(words),false);assert.match((await restoreVoiceCallAttempt(a.marker.route,100+VOICE_ATTEMPT_TTL+1)).notice,/expired/);settleVoiceCallAttempt(a.marker);
});
test('corrupt/future/oversized legacy data is disposed into a minimal persistent review warning',async()=>{
  const a=await prepare('corrupt');
  for(const raw of ['{',JSON.stringify({...legacy(a),fingerprint:'bad'}),JSON.stringify({...legacy(a),createdAt:999}),JSON.stringify({...legacy(a),request:{...a.request,recipients:[{agentId:'other'}]}}),words.repeat(5000)]){
    data.set(slot(a.marker.route),raw);const result=await restoreVoiceCallAttempt(a.marker.route,101);assert.equal(result.marker,undefined);assert.match(result.notice,/invalid/);
    const stored=data.get(slot(a.marker.route));assert.equal(stored.includes(words),false);assert.deepEqual(JSON.parse(stored),{version:2,route:a.marker.route,reviewRequired:true});
    assert.match((await restoreVoiceCallAttempt(a.marker.route,102)).notice,/requires Chat review/);assert.throws(()=>retainVoiceCallAttempt(a),/unresolved/);
  }
  data.delete(slot(a.marker.route));
});
test('malformed marker extras/foreign identity cannot reconstruct or authorize another send',async()=>{
  const a=await prepare('invalid-marker');
  for(const patch of [{fingerprint:'bad'},{createdAt:999},{version:3},{route:route('other')},{request:{text:words}},{recipients:[{agentId:'agent'}]}]){
    data.set(slot(a.marker.route),JSON.stringify({...a.marker,...patch}));assert.match((await restoreVoiceCallAttempt(a.marker.route,101)).notice,/invalid/);assert.equal(data.get(slot(a.marker.route)).includes(words),false);
  }
  data.delete(slot(a.marker.route));
});
test('one unresolved marker per route prevents another key',async()=>{
  const a=await prepare('collision');retainVoiceCallAttempt(a);assert.throws(()=>retainVoiceCallAttempt({...a,marker:{...a.marker,idempotencyKey:'new'}}),/unresolved/);settleVoiceCallAttempt(a.marker);
});
test('late acknowledgement deletes only its exact identity, never replacement',async()=>{
  const a=await prepare('late');retainVoiceCallAttempt(a);settleVoiceCallAttempt(a.marker);
  const next=await prepareVoiceCallAttempt(a.marker.route,'Next',()=> 'next',101);retainVoiceCallAttempt(next);
  for(const patch of [{idempotencyKey:'other'},{fingerprint:'0'.repeat(64)},{createdAt:100},{instanceId:'other'}])settleVoiceCallAttempt({...next.marker,...patch});
  settleVoiceCallAttempt(a.marker);assert.deepEqual((await restoreVoiceCallAttempt(next.marker.route,102)).marker,next.marker);settleVoiceCallAttempt(next.marker);
});
test('denied storage uses text-free shared memory fallback, mounted exact retry and Chat review',async()=>{
  const storage=window.sessionStorage;window.sessionStorage={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
  try{
    const a=await prepare('denied');assert.equal(retainVoiceCallAttempt(a),false);assert.equal(readBrowserStorage('sessionStorage',slot(a.marker.route)).includes(words),false);
    assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);assert.match((await restoreVoiceCallAttempt(a.marker.route,101)).notice,/requires Chat review/);
    settleVoiceCallAttempt(a.marker);assert.equal(readBrowserStorage('sessionStorage',slot(a.marker.route)),null);
  }finally{window.sessionStorage=storage;}
});
test('storage failure upgrading legacy never retains its text in shared fallback',async()=>{
  const a=await prepare('legacy-fallback');data.set(slot(a.marker.route),JSON.stringify(legacy(a)));
  const set=window.sessionStorage.setItem;window.sessionStorage.setItem=()=>{throw Error('quota');};
  try{await restoreVoiceCallAttempt(a.marker.route,101);assert.equal(data.has(slot(a.marker.route)),false);assert.equal(readBrowserStorage('sessionStorage',slot(a.marker.route)).includes(words),false);settleVoiceCallAttempt(a.marker);}finally{window.sessionStorage.setItem=set;}
});
test('empty/long turns do not prepare and persisted fields have no payload/receipt/transcript',async()=>{
  await assert.rejects(prepareVoiceCallAttempt(route('long'),'x'.repeat(10001),()=> 'key'),/Chat/);await assert.rejects(prepareVoiceCallAttempt(route('empty'),' ',()=> 'key'),/Chat/);
  const a=await prepare('minimal');assert.deepEqual(Object.keys(a.marker).sort(),['createdAt','fingerprint','idempotencyKey','instanceId','route','version']);
});
test('changed stored marker fences mounted retry and inspection touches only the exact route slot',async()=>{
  const a=await prepare('stored-change');retainVoiceCallAttempt(a);assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),true);
  for(const patch of [{idempotencyKey:'other'},{fingerprint:'0'.repeat(64)},{instanceId:'other'},{route:route('foreign')}]){
    data.set(slot(a.marker.route),JSON.stringify({...a.marker,...patch}));assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),false);
  }
  data.delete(slot(a.marker.route));assert.equal(await voiceCallAttemptCanRetry(a,a.marker.route,101),false);
  const get=window.sessionStorage.getItem;const reads=[];window.sessionStorage.getItem=k=>{reads.push(k);return get(k);};
  try{await restoreVoiceCallAttempt(route('isolated'),101);assert.deepEqual(reads,[slot(route('isolated'))]);}finally{window.sessionStorage.getItem=get;}
});
