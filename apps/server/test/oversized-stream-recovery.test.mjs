import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerStreamRoutes} from '../dist/routes/streams.js';

const large = 'x'.repeat(1_058_543);
const stored = (seq, output) => ({seq, ts:'2026-10-01', event:{type:'tool_result', output}});
async function fixture(workspaceHistory=[]) {
  const app=Fastify(), closures=new Set(), subscribers=new Set(), workspaceSubscribers=new Set();
  const history=[stored(146,large),stored(147,'later')];
  registerStreamRoutes(app,{
    store:{getAgent:()=>({id:'agent'}),lastSeqOf:()=>history.at(-1).seq,
      readEventsSince:(_,cursor,limit)=>history.filter(e=>e.seq>cursor).slice(0,limit)},
    workspace:{cursor:()=>147,instanceId:()=> 'instance',readSince:cursor=>workspaceHistory.filter(event=>event.id>cursor)},
    serverClosed:()=>false,maxSubscribersPerStream:20,workspaceSubscribers,
    agentSubscriberCount:()=>subscribers.size,
    subscribe:(_,listener)=>{subscribers.add(listener);return()=>subscribers.delete(listener);},
    liveSseClosures:closures,serverMetrics:{openSse:()=>()=>{},sseBackpressure:()=>{}},
  });
  await app.listen({host:'127.0.0.1',port:0});
  return {app,history,subscribers,workspaceSubscribers,url:app.listeningOrigin,
    close:async()=>{for(const close of closures)close();await app.close();}};
}
async function stream(url) {
  const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),5_000);
  const response=await fetch(url,{signal:abort.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(), decoder=new TextDecoder(), frames=[];
  let pending='';
  return {frames, async until(predicate) {
    while(!predicate(frames)) {
      const {value,done}=await reader.read();assert.equal(done,false,'live connection remains open');
      pending+=decoder.decode(value,{stream:true});
      for(let index;(index=pending.indexOf('\n\n'))>=0;) {
        const block=pending.slice(0,index);pending=pending.slice(index+2);
        const lines=block.split('\n'), data=lines.find(l=>l.startsWith('data:'));
        if(data)frames.push({name:lines.find(l=>l.startsWith('event:'))?.slice(7).trim(),data:JSON.parse(data.slice(5))});
      }
    }
    return frames;
  }, close:()=>{clearTimeout(timer);abort.abort();}};
}
test('real Agent route escapes oversized replay, checkpoints live output, and resumes later events',async()=>{
  const f=await fixture();let first,reconnected;
  try {
    const original=JSON.stringify(f.history);
    first=await stream(`${f.url}/api/agents/agent/stream?lastEventId=145`);
    await first.until(frames=>frames.some(x=>x.name==='agent_status'));
    assert.deepEqual(first.frames[0].data,{agentId:'agent',instanceId:'instance',cursor:147,reset:true,snapshot:true});
    assert(!first.frames.some(x=>x.name==='message'));
    const huge=stored(148,large);
    for(const callback of f.subscribers)callback(huge);
    for(const callback of f.subscribers)callback(stored(149,'continued'));
    await first.until(frames=>frames.some(x=>x.data.seq===149));
    assert(first.frames.some(x=>x.name==='agent_status'&&x.data.cursor===148&&x.data.snapshot===true));
    assert.equal(first.frames.filter(x=>x.name==='message')[0].data.event.output,'continued');
    assert.equal(JSON.stringify(f.history),original,'canonical bytes are untouched');
    assert.equal(huge.event.output,large,'live canonical event is untouched');
    reconnected=await stream(`${f.url}/api/agents/agent/stream?lastEventId=147`);
    await reconnected.until(frames=>frames.some(x=>x.name==='agent_status'));
    assert.equal(reconnected.frames[0].data.reset,false,'checkpoint does not repeat the blocked history');
  } finally {first?.close();reconnected?.close();await f.close();}
});
test('workspace oversized live events reconcile without disconnecting or changing canonical bytes',async()=>{
  const f=await fixture();let connection;
  try {
    connection=await stream(`${f.url}/api/workspace/stream?bootstrap=true`);
    await connection.until(frames=>frames.some(x=>x.name==='workspace_status'));
    const event={id:148,ts:'2026-10-01',event:{type:'notification_changed',body:large}};
    for(const callback of f.workspaceSubscribers)callback(event);
    for(const callback of f.workspaceSubscribers)callback({id:149,event:{type:'notification_changed',action:'read'}});
    await connection.until(frames=>frames.some(x=>x.data.id===149));
    assert(connection.frames.some(x=>x.name==='workspace_status'&&x.data.snapshot&&x.data.cursor===148));
    assert.equal(event.event.body,large);
  } finally {connection?.close();await f.close();}
});
test('repeated workspace retries escape an oversized replay with an explicit snapshot',async()=>{
  const history=[{id:146,event:{type:'notification_changed',body:large}},{id:147,event:{type:'notification_changed',action:'read'}}];
  const original=JSON.stringify(history),f=await fixture(history);
  try {
    for(let attempt=0;attempt<3;attempt++) {
      const connection=await stream(`${f.url}/api/workspace/stream?lastEventId=145&bootstrap=true`);
      try {
        await connection.until(frames=>frames.some(frame=>frame.name==='workspace_status'));
        assert.deepEqual(connection.frames[0].data,{instanceId:'instance',cursor:147,reset:true,snapshot:true});
        assert(f.workspaceSubscribers.size>0,'retry remains subscribed instead of closing on the same replay');
        for(const callback of f.workspaceSubscribers)callback({id:148,event:{type:'notification_changed',action:'read'}});
        await connection.until(frames=>frames.some(frame=>frame.data.id===148));
      } finally {connection.close();}
    }
    assert.equal(JSON.stringify(history),original,'snapshot recovery never rewrites canonical history');
  } finally {await f.close();}
});
