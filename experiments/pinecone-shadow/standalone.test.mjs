import test from 'node:test';
import assert from 'node:assert/strict';
import {productApiPath,setStandaloneProductScope} from '../../apps/web/src/api/productScope.ts';
import {mergePineconeHistory,pineconeMessages} from '../../apps/web/src/components/pinecone/branchPineconeModel.ts';

test('standalone root uses canonical Branches APIs without changing ordinary product routes',()=>{
  globalThis.window={location:{pathname:'/'}};
  assert.equal(productApiPath('/api/agents/speaker'),'/api/agents/speaker');
  setStandaloneProductScope('branches');
  for(const path of ['/api/agents/speaker','/api/conversations/chat','/api/workspace/stream'])
    assert.equal(productApiPath(path),'/api/branches/engine/'+path.slice(5));
  for(const path of ['/api/branches/v4','/api/branches/engine/agents/speaker','/api/branch-executions/run','/api/branch-gates/gate','/static/app.js'])
    assert.equal(productApiPath(path),path,'already scoped paths must not gain a second prefix');
  setStandaloneProductScope(undefined);
  assert.equal(productApiPath('/api/agents/speaker'),'/api/agents/speaker');
  window.location.pathname='/branches';
  assert.equal(productApiPath('/api/agents/speaker'),'/api/branches/engine/agents/speaker');
  delete globalThis.window;
});

test('earlier canonical pages retain chronology, latest receipts and authored audience',()=>{
  const message=(id,createdAt,extra={})=>({id,createdAt,role:'assistant',authorAgentId:'speaker',communicationIntent:'user_dm',...extra});
  const first=message('first','2026-10-01T00:00:00Z');
  const overlap=message('overlap','2026-10-02T00:00:00Z',{role:'user',deliveryReceipts:[{state:'queued'}]});
  const refreshed={...overlap,deliveryReceipts:[{state:'processed'}]};
  const last=message('last','2026-10-03T00:00:00Z');
  const worker=message('worker','2026-10-02T01:00:00Z',{authorAgentId:'scout',communicationIntent:'collaboration'});
  const merged=pineconeMessages(mergePineconeHistory([[first,overlap],[overlap,worker],[refreshed,last]]),'speaker');
  assert.deepEqual(merged.map(row=>row.id),['first','overlap','last']);
  assert.equal(merged[1].deliveryReceipts[0].state,'processed');
  assert.equal(overlap.deliveryReceipts[0].state,'queued','canonical input projections must remain untouched');
});
