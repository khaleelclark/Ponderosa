import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareDownload} from '../src/downloads.js';

function browserDownload(t) {
  let clicks=0;
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({dataset:{},click:()=>clicks++,remove(){}}),body:{append(){}}};
  t.mock.method(globalThis,'setTimeout',callback=>{callback();return 0;});
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  return ()=>clicks;
}
test('download preparation reports bounded byte progress before handing off',async t=>{
  const clicks=browserDownload(t),progress=[];
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new Uint8Array(3));controller.enqueue(new Uint8Array(2));controller.close();
  }}),{headers:{'Content-Length':'5'}}));
  await prepareDownload('/api/files/download','file.bin',undefined,value=>{assert.equal(clicks(),0);progress.push(value);});
  assert.deepEqual(progress,[{receivedBytes:0,totalBytes:5},{receivedBytes:3,totalBytes:5},{receivedBytes:5,totalBytes:5}]);
  assert.equal(clicks(),1);
});
test('unknown-length progress does not invent a total and cancellation never hands off',async t=>{
  const clicks=browserDownload(t),controller=new AbortController(),progress=[];
  t.mock.method(globalThis,'fetch',async()=>new Response('bytes'));
  await assert.rejects(prepareDownload('/api/files/download','file.bin',controller.signal,value=>{
    progress.push(value);if(value.receivedBytes)controller.abort(new DOMException('Cancelled','AbortError'));
  }),{name:'AbortError'});
  assert.equal(progress.at(-1).receivedBytes,5);
  assert.equal(progress.at(-1).totalBytes,undefined);
  assert.equal(clicks(),0);
});
