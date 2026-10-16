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

test('check-in status keeps old waiting work visible after newer quiet success; unknown outcomes never retry',async()=>{
 const {checkStatus,safeMessageRetry}=await import('../../apps/web/src/components/pinecone/branchPineconeModel.ts');
 const now=Date.parse('2026-10-16T15:00:00Z');
 const row=(state,at)=>({id:at,admissionSource:'automatic',state,createdAt:at,updatedAt:at});
 assert.equal(checkStatus([row('completed','2026-10-16T14:50:00Z'),row('waiting','2026-10-16T13:00:00Z')],true,now),'Check-ins are delayed. Chat still works.');
 assert.equal(checkStatus([],false,now),'Check-ins paused');
 assert.equal(checkStatus([row('running','2026-10-16T14:59:00Z')],true,now),'Checking…');
 for(const state of ['unconfirmed','run_unconfirmed','started','delivered','processed'])assert.equal(safeMessageRetry([{state,canRetry:true}]),false);
 assert.equal(safeMessageRetry([{state:'failed',canRetry:true,retryMayDuplicate:true}]),false);
 assert.equal(safeMessageRetry([{state:'failed',canRetry:true}]),true);
});
