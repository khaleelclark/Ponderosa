import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {appendLiveRunText,closeLiveRunText} from '../../apps/web/src/agentLiveProjection.ts';
const delta=(seq,text,executionId='r',kind='response')=>({agentId:'a',executionId,kind,seq,createdAt:'2026-11-01T00:00:00Z',delta:text});

test('queued deltas preserve identity/order and do not replay text already in a canonical snapshot',()=>{
 let rows=appendLiveRunText([],delta(1,'Hello'));
 const id=rows[0].id;
 rows=appendLiveRunText(rows,delta(2,' world'));
 assert.equal(rows[0].id,id);assert.equal(rows[0].text,'Hello world');
 assert.equal(appendLiveRunText(rows,delta(2,' world')),rows,'snapshot can win the race with a pending delta');
 assert.equal(appendLiveRunText(rows,delta(1,'Hello')),rows);
 rows=appendLiveRunText(rows,delta(3,'Thought','r','reasoning'));
 assert.equal(rows[0].completed,true);assert.equal(rows[1].kind,'reasoning');
 rows=appendLiveRunText(rows,delta(4,'Next','r','response'));
 assert.equal(rows.length,3);assert.equal(rows[2].text,'Next');
});
test('terminal lifecycle closes only the exact Run and retains completed segment objects',()=>{
 const a=appendLiveRunText([],delta(1,'One'))[0],b={...a,id:'b',executionId:'other'},done={...a,id:'done',completed:true};
 const result=closeLiveRunText([a,b,done],'r');
 assert.equal(result[0].completed,true);assert.equal(result[1],b);assert.equal(result[2],done);
});
