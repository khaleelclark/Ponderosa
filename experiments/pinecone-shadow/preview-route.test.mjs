import test from 'node:test';
import assert from 'node:assert/strict';
import {productApiPath} from '../../apps/web/src/api/productScope.ts';

// This focused integration check requires the candidate-only preview server.
const origin='http://127.0.0.1:18795';
globalThis.window={location:{pathname:'/branches'}};

for(const id of ['49005cab-f4d3-4b38-a468-bf153624e4f4','592f4798-cd48-445a-91f2-9f9a86b1c135']){
 test(`Branches frontend receives qualification metadata for ${id}`,async()=>{
  const direct=`/api/pinecone-candidate/${id}/runtime`;
  const scoped=productApiPath(direct);
  assert.equal(scoped,`/api/branches/engine/pinecone-candidate/${id}/runtime`);
  const responses=await Promise.all([direct,scoped].map(path=>fetch(origin+path,{signal:AbortSignal.timeout(5000)})));
  for(const response of responses){assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');}
  const [unscopedData,scopedData]=await Promise.all(responses.map(response=>response.json()));
  assert.deepEqual(scopedData,unscopedData);
  assert.equal(typeof scopedData.supported,'boolean');
  assert.equal(typeof scopedData.model,'string');
  assert.equal(typeof scopedData.effort,'string');
 });
}

test('Scoped runtime metadata stays read-only',async()=>{
 const response=await fetch(origin+productApiPath('/api/pinecone-candidate/49005cab-f4d3-4b38-a468-bf153624e4f4/runtime'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
 assert.equal(response.status,403);
});
