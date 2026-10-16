// Run with Node 24: node --test tests/files-results/readTextPreview.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextPreview } from '../../apps/web/src/components/filePreview/readTextPreview.ts';

test('text downloads preview as data, with bounded UTF-8 and safe URL handling', async t => {
  const originalFetch=globalThis.fetch;
  const originalWindow=globalThis.window;
  globalThis.window={ location:{ origin:'https://preview.test' } };
  t.after(()=>{globalThis.fetch=originalFetch;globalThis.window=originalWindow;});
  const signal=new AbortController().signal;
  const text='line one\n\n<script>not executable</script> 😀\nlast line';
  globalThis.fetch=async (url, init)=>{
    assert.equal(url,'https://preview.test/api/asset/download');
    assert.equal(init.redirect,'error');
    assert.equal(init.signal,signal);
    return new Response(text,{headers:{'content-disposition':'attachment; filename=test.md'}});
  };
  assert.deepEqual(await readTextPreview('/api/asset/download',signal),{content:text,truncated:false});
  await assert.rejects(readTextPreview('https://other.test/api/asset',signal),/Invalid/);
  await assert.rejects(readTextPreview('javascript:alert(1)',signal),/Invalid/);
  globalThis.fetch=async()=>new Response(null,{status:404});
  await assert.rejects(readTextPreview('/api/missing',signal),/404/);
  const limit=2*1024*1024;
  let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('a'.repeat(limit-1)+'😀tail')); },
    cancel(){cancelled=true;},
  }));
  const bounded=await readTextPreview('/api/large',signal);
  assert.equal(bounded.truncated,true);
  assert.equal(bounded.content,'a'.repeat(limit-1));
  assert.equal(cancelled,true);
  globalThis.fetch=async()=>new Response('a'.repeat(limit));
  assert.equal((await readTextPreview('/api/exact',signal)).truncated,false);
});
