// Deferred source fixtures; execution requires separate authorization.
import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTaskCommandValid,nativeTaskInventoryValid,nativeTaskReceiptMatches,nativeTaskRecoveryPath,nativeTaskTarget} from '../../apps/web/src/components/nativeTasks.ts';
const command={runId:'run',sourceFence:7,sessionId:'session',taskKey:'opaque/task&key',idempotencyKey:'original'};
test('native inventory rejects partial, duplicate or guessed identity',()=>{
 const task={taskKey:command.taskKey,taskId:'native',kind:'cron',cancellable:false};
 assert.ok(nativeTaskInventoryValid({...command,tasks:[task]}));
 for(const tasks of [[{...task,taskKey:''}],[task,task],[{...task,cancellable:undefined}]])assert.equal(nativeTaskInventoryValid({...command,tasks}),false);
 assert.equal(nativeTaskCommandValid({...command,newKey:true}),false);
});
test('every native outcome requires exact original boundary and never process drain',()=>{
 for(const outcome of ['acknowledged','terminated','not_found','unknown']){
  const receipt={...command,outcome,processDrainObserved:false};assert.ok(nativeTaskReceiptMatches(command,receipt));
  for(const patch of [{runId:'replacement'},{sourceFence:8},{sessionId:'other'},{taskKey:'guessed'},{idempotencyKey:'new'},{outcome:'complete'},{processDrainObserved:true}])assert.equal(nativeTaskReceiptMatches(command,{...receipt,...patch}),false);
 }
 const url=new URL(nativeTaskRecoveryPath('/api/agents/source/native-tasks',command),'https://local.invalid');assert.equal(url.searchParams.get('taskKey'),command.taskKey);assert.equal(url.searchParams.get('sourceFence'),'7');assert.ok(url.pathname.endsWith('/stops/original'));
 assert.equal(nativeTaskTarget(command),nativeTaskTarget({...command,idempotencyKey:'different'}),'new key cannot create a different target');
});
