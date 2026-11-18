// Deferred: no tests execute until whole-implementation testing is authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackgroundTasks } from '../../packages/engines/dist/codex-background-tasks.js';
import { ClaudeTaskStop } from '../../packages/engines/dist/claude-task-stop.js';
import { ClaudeTaskLifetime } from '../../packages/engines/dist/claude-task-lifetime.js';
import { CodexAppServerSession } from '../../packages/engines/dist/codex-app-server.js';

test('Codex pages exact native identities, coalesces reads and never uses OS pid/command as a target', async () => {
  const calls=[];
  const tasks=new CodexBackgroundTasks('thread',async(method,params)=>{
    calls.push([method,params]);
    if(method.endsWith('/terminate')) return {terminated:true};
    return params.cursor ? {data:[{itemId:'item2',processId:'opaque2',osPid:99}],nextCursor:null}
      : {data:[{itemId:'item',processId:'opaque',command:'untrusted text',osPid:98}],nextCursor:'page2'};
  });
  const a=tasks.list(), b=tasks.list();
  assert.equal(a,b);
  const rows=await a;
  assert.equal(rows.length,2);
  assert.equal(rows[0].command,undefined);
  assert.deepEqual(calls[1][1],{threadId:'thread',limit:100,cursor:'page2'});
  await assert.rejects(tasks.stop('invented task'),/Refresh exact/);
  assert.equal(await tasks.stop(rows[0].taskKey),'terminated');
  assert.deepEqual(calls.at(-1),['thread/backgroundTerminals/terminate',{threadId:'thread',processId:'opaque'}]);
  await assert.rejects(tasks.stop(rows[0].taskKey),/Refresh exact/);
});

test('Codex malformed/repeated cursors fail without treating a partial page as absence', async()=>{
  const tasks=new CodexBackgroundTasks('thread',async()=>({data:[{itemId:'i',processId:'p'}],nextCursor:'repeat'}));
  await assert.rejects(tasks.list(),/Duplicate|cursor/);
  await assert.rejects(tasks.stop(JSON.stringify(['thread','i','p'])),/Refresh exact/);
});

test('Codex false and lost acknowledgements remain distinct and are never retried',async()=>{
  for(const response of [{terminated:false},null,'throw']) {
    let writes=0;
    const tasks=new CodexBackgroundTasks('thread',async method=>{
      if(method.endsWith('/list'))return {data:[{itemId:'i',processId:'p'}],nextCursor:null};
      writes++; if(response==='throw')throw Error('transport lost'); return response;
    });
    const [row]=await tasks.list();
    assert.equal(await tasks.stop(row.taskKey),response?.terminated===false?'not_found':'unknown');
    await assert.rejects(tasks.stop(row.taskKey));
    assert.equal(writes,1);
  }
});

test('Claude exact stop acknowledgement cannot settle the native task lifecycle',async()=>{
  const life=new ClaudeTaskLifetime('session');life.beginTurn();
  life.observe({type:'system',subtype:'task_started',session_id:'session',task_id:'task',run_id:'run-1',task_type:'local_agent'});
  const row=life.inventory()[0], control=new ClaudeTaskStop('session');
  const result=control.stop(life.requireTask(row.taskKey).taskId,async frame=>{
    assert.equal(frame.request.subtype,'stop_task');assert.equal(frame.request.task_id,'task');
    assert.equal(control.observe({type:'control_response',response:{subtype:'success',request_id:'different'}}),false);
    assert.equal(control.observe({type:'control_response',response:{subtype:'success',request_id:frame.request_id}}),true);
  });
  assert.equal(await result,'acknowledged');
  assert.equal(life.inventory().length,1);
  life.observe({type:'system',subtype:'task_started',session_id:'session',task_id:'task',run_id:'run-2',task_type:'local_agent'});
  assert.throws(()=>life.requireTask(row.taskKey),/no longer owned/);
});

test('Claude wrong-session, write failure and close return unknown without replay',async()=>{
  const control=new ClaudeTaskStop('session');let writes=0;
  assert.equal(await control.stop('task',async frame=>{
    writes++;control.observe({type:'control_response',session_id:'other',response:{subtype:'success',request_id:frame.request_id}});
  }),'unknown');
  assert.equal(await control.stop('task',async()=>{writes++;throw Error('lost');}),'unknown');
  const pending=control.stop('task',async()=>{writes++;});control.close();
  assert.equal(await pending,'unknown');assert.equal(writes,3);
});

test('Codex native registry holds source completion and reports removal without claiming process drain',async()=>{
  const runtime=Object.create(CodexAppServerSession.prototype);let rows=[{taskKey:'key',taskId:'opaque'}];
  Object.assign(runtime,{listNativeTasks:async()=>rows,rpc:{isAlive:()=>true},closingNativeTasks:false});
  const iterator=runtime.retainBackgroundTasks()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.status,'running');
  assert.equal(runtime.nativeTaskHold,true);
  await assert.rejects(runtime.startTurn({prompt:'new source'}),/owns the source Run/);
  rows=[];
  assert.equal((await iterator.next()).value.status,'done');
  assert.equal((await iterator.next()).done,true);
  assert.equal(runtime.nativeTaskHold,false);
});


test('Codex current-source ownership rejects an older item even on the same thread',async()=>{
  const runtime=Object.create(CodexAppServerSession.prototype);
  Object.assign(runtime,{engineAgentId:'thread',rpc:{isAlive:()=>true},nativeTaskItems:new Map([['current-item','opaque']]),
    backgroundTasks:{list:async()=>[{taskKey:'old',itemId:'older-item',processId:'opaque'}],stop:async()=>{throw Error('must not dispatch');}}});
  await assert.rejects(runtime.listNativeTasks(),/without an exact current-source/);
  await assert.rejects(runtime.stopNativeTask(JSON.stringify(['thread','older-item','opaque'])),/no current-source/);
});
