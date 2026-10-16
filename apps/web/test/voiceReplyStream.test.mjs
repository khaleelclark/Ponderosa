import assert from 'node:assert/strict';
import test from 'node:test';
import { VoicePhraseBuffer, voiceTimingText } from '../src/components/speech/voiceReplyStream.js';
const reply=(text,sequence=1,patch={})=>({messageId:'m',agentId:'a',runId:'r',fence:1,streamId:'s',itemId:'i',providerTurnId:'p',sequence,text,state:'streaming',...patch});
test('stable sentence chunks order, dedupe and reconnect snapshot repair without repeated speech',()=>{
 const b=new VoicePhraseBuffer();assert.deepEqual(b.accept(reply('One nat')),[]);
 assert.deepEqual(b.accept(reply('One natural sentence. ',2)),['One natural sentence.']);
 assert.deepEqual(b.accept(reply('One natural sentence. ',2)),[]);
 assert.deepEqual(b.accept(reply('One natural sentence. Next sentence. Tail',5)),['Next sentence.']);
 assert.deepEqual(b.finish('One natural sentence. Next sentence. Tail'),['Tail']);
 assert.deepEqual(b.accept(reply('late',6)),[]);
});
test('Unicode split/surrogates, abbreviations/decimals and ending tail sound natural',()=>{
 const b=new VoicePhraseBuffer();assert.deepEqual(b.accept(reply('Dr. Smith measured 3.14. Café \ud83d')),['Dr. Smith measured 3.14.']);
 assert.deepEqual(b.accept(reply('Dr. Smith measured 3.14. Café \ud83d\ude00 你好. ',2)),['Café 😀 你好.']);
 assert.deepEqual(b.finish('Dr. Smith measured 3.14. Café 😀 你好. Finished'),['Finished']);
});
test('bounded phrase flush avoids raw short tokens and never reads unfinished Markdown/code',()=>{
 const b=new VoicePhraseBuffer();b.accept(reply('tiny'));assert.deepEqual(b.flush(),[]);
 const long='A comfortably worded phrase '.repeat(7);const c=new VoicePhraseBuffer();assert.deepEqual(c.accept(reply(long)),[]);assert.equal(c.flush().length,1);
 const code=new VoicePhraseBuffer();assert.deepEqual(code.accept(reply('```js\nsecret_code();')),[]);
 assert.deepEqual(code.finish('```js\nsecret_code();\n```\nReadable tail with `secret_inline()`.'),['Readable tail with .']);
});
test('successor fence/item, changed canonical prefix and oversized text fail closed',()=>{
 for(const patch of [{runId:'new'},{fence:2},{streamId:'new'},{itemId:'new'},{providerTurnId:'new'}]){
  const b=new VoicePhraseBuffer();b.accept(reply('Already spoken. '));assert.throws(()=>b.accept(reply('Already spoken. New.',2,patch)));
 }
 const b=new VoicePhraseBuffer();b.accept(reply('Already spoken. '));assert.throws(()=>b.finish('Rewritten answer.'));
 assert.throws(()=>new VoicePhraseBuffer().accept(reply('x'.repeat(10001))));
});
test('partial stream fallback appends only canonical remaining text once',()=>{
 const b=new VoicePhraseBuffer();assert.deepEqual(b.accept(reply('First phrase. ')),['First phrase.']);
 assert.deepEqual(b.finish('First phrase. Canonical fallback tail.'),['Canonical fallback tail.']);
});
test('server stages use paired timestamps; browser stages never use enqueue or mixed clock subtraction',()=>{
 assert.match(voiceTimingText({}),/Run start unavailable/);
 const t={acceptedAt:'2026-10-10T00:00:00.000Z',runStartedAt:'2026-10-10T00:00:02.000Z',firstTextAt:'2026-10-10T00:00:02.100Z',completedAt:'2026-10-10T00:00:05.000Z',sentObserved:30,acceptedObserved:50,firstReceived:190,firstCommitted:200,firstAudio:250};
 const text=voiceTimingText(t);assert.match(text,/Run start 2000 ms/);assert.match(text,/first reply text 100 ms/);assert.match(text,/audio start 50 ms/);assert.match(text,/canonical completion 5000 ms/);assert.match(text,/visible reply DOM commit → browser audio start 50 ms/);assert.match(text,/first reply text receipt → browser audio start 60 ms/);assert.match(voiceTimingText({...t,firstCommitted:260}),/DOM commit → browser audio start unavailable/);assert.match(text,/Observed acceptance → browser audio start 200 ms/);
 assert.match(voiceTimingText({...t,firstAudio:undefined}),/browser audio start unavailable/);
 assert.match(voiceTimingText({...t,runStartedAt:'2025-01-01T00:00:00Z'}),/Run start unavailable/);
 assert.match(text,/Acceptance → browser audio start 200–220 ms \(HTTP acceptance window/);
});
