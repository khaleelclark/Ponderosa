// Deferred regression source; no execution during implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeFileHistory } from '../../packages/engines/dist/claude-file-history.js';
const session='11111111-1111-4111-8111-111111111111';
const user='22222222-2222-4222-8222-222222222222';
const assistant='33333333-3333-4333-8333-333333333333';
function observed(write) {
  const h=new ClaudeFileHistory(session,write,true);
  h.observe({type:'system',subtype:'init',session_id:session,claude_code_version:'2.1.301'});
  h.beginTurn();
  h.observe({type:'user',session_id:session,uuid:user,isReplay:true,message:{role:'user'}});
  h.observe({type:'assistant',session_id:session,uuid:assistant});
  h.observe({type:'result',session_id:session,subtype:'success',is_error:false});
  return h;
}
test('only exact observed main-session completed UUIDs are selectable',()=>{
  const h=observed(async()=>{});
  assert.deepEqual(h.catalog().checkpoints,[{sessionId:session,messageId:user}]);
  assert.deepEqual(h.catalog().forkPoints,[assistant]);
  h.observe({type:'user',session_id:'other',uuid:'foreign',isReplay:true,message:{role:'user'}});
  assert.equal(h.catalog().checkpoints.length,1);
});
test('preview and actual rewind preserve exact correlation and native skipped counts',async()=>{
  let h;const frames=[];
  h=observed(async frame=>{frames.push(frame);h.observe({type:'control_response',session_id:session,response:{subtype:'success',request_id:frame.request_id,response:{canRewind:true,filesChanged:['file.txt'],skippedLinks:2}}});});
  const result=await h.rewind(user,false);
  assert.equal(result.outcome,'completed');
  assert.equal(result.skippedLinks,2);
  assert.deepEqual(frames[0].request,{subtype:'rewind_files',user_message_id:user,dry_run:false});
});
test('wrong-session response remains unknown and cannot be retried',async()=>{
  let h;let writes=0;
  h=observed(async frame=>{writes++;h.observe({type:'control_response',session_id:'wrong',response:{subtype:'success',request_id:frame.request_id,response:{canRewind:true}}});});
  assert.equal((await h.rewind(user,false)).outcome,'outcome_unknown');
  await assert.rejects(h.rewind(user,false));assert.equal(writes,1);
});
test('old unsafe native generation cannot expose rewind',()=>{
  const h=new ClaudeFileHistory(session,async()=>{},true);
  h.observe({type:'system',subtype:'init',session_id:session,claude_code_version:'2.1.215'});
  assert.equal(h.catalog().fileRewindSupported,false);
});

test('tracking disabled never advertises or collects file checkpoints',()=>{
  const h=new ClaudeFileHistory(session,async()=>{});
  h.ready=true;
  assert.equal(h.catalog().trackingEnabled,false);
  assert.equal(h.catalog().fileRewindSupported,false);
  assert.deepEqual(h.catalog().checkpoints,[]);
});
