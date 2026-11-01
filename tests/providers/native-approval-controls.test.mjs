import { ClaudeFileHistory } from '../../packages/engines/dist/claude-file-history.js';
import { ClaudeTaskLifetime } from '../../packages/engines/dist/claude-task-lifetime.js';
// Deferred source fixtures: no provider execution is needed for these contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeControls } from '../../packages/engines/dist/claude-controls.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { requestNativeApproval, answerCodexNativeApproval } from '../../packages/engines/dist/native-approvals.js';

const identity = {requestId:'rpc-1',sessionId:'session',turnId:'turn',kind:'command'};
const options = (response, extra={}) => ({signal:new AbortController().signal,
  handleElicitation:async request => { assert.deepEqual(request.nativeApproval,identity); return response; }, ...extra});

test('native callback accepts one explicit human boolean, never generic Submit, prose or run grants', async () => {
  for (const response of [{action:'decline'},{action:'cancel'}, {action:'accept'},
    {action:'accept',content:{}}, {action:'accept',content:{approve:'true'}},
    {action:'accept',content:{approve:true,other:true}}]) {
    assert.equal(await requestNativeApproval(options(response),identity,{command:'exact command'}),false);
  }
  assert.equal(await requestNativeApproval(options({action:'accept',content:{approve:true}}),identity,{command:'exact command'}),true);
  let called=false;
  assert.equal(await requestNativeApproval(options(null,{capabilityRestrictions:{filesystemWriteRestricted:true,restrictedConnectorNames:[]},
    handleElicitation:async()=>{called=true;return {action:'accept',content:{approve:true}};}}),identity,{}),false);
  assert.equal(called,false);
});

test('original Codex RPC schemas retain exact turn and one-time scope; stale approvals deny', async () => {
  let turn='turn';
  const opts={signal:new AbortController().signal,handleElicitation:async request=>{
    assert.equal(request.nativeApproval.requestId,'rpc-1'); return {action:'accept',content:{approve:true}};
  }};
  const params={threadId:'session',turnId:'turn',itemId:'item',permissions:{network:{enabled:true},fileSystem:null}};
  for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval'])
    assert.deepEqual(await answerCodexNativeApproval(opts,'session',()=>turn,'rpc-1',method,params),{decision:'accept'});
  assert.deepEqual(await answerCodexNativeApproval(opts,'session',()=>turn,'rpc-1','item/permissions/requestApproval',params),
    {permissions:{network:{enabled:true}},scope:'turn'});
  await assert.rejects(()=>answerCodexNativeApproval(opts,'foreign',()=>turn,'rpc-1','item/fileChange/requestApproval',params),/Foreign/);
  opts.handleElicitation=async()=>{turn='new-turn';return {action:'accept',content:{approve:true}};};
  assert.deepEqual(await answerCodexNativeApproval(opts,'session',()=>turn,'rpc-1','item/fileChange/requestApproval',params),{decision:'decline'});
});

test('Claude controls match exact IDs and subtype success; error and close reject without replay', async () => {
  const frames=[];const controls=new ClaudeControls(async frame=>{frames.push(frame);});
  const pending=controls.request({subtype:'interrupt'});
  assert.equal(controls.observe({type:'control_response',response:{request_id:'foreign',subtype:'success'}}),false);
  assert.equal(controls.observe({type:'control_response',response:{request_id:frames[0].request_id,subtype:'success',response:{}}}),true);
  await pending;
  assert.equal(frames.length,1);
  const refused=controls.request({subtype:'set_permission_mode',mode:'default'});
  controls.observe({type:'control_response',response:{request_id:frames[1].request_id,subtype:'error'}});
  await assert.rejects(refused,/rejected/);
  const cancelled=controls.request({subtype:'set_model',model:'exact'});
  controls.close(); await assert.rejects(cancelled,/closed/);
  await assert.rejects(()=>controls.request({subtype:'interrupt'}),/uncertain/);
  assert.equal(frames.length,3);
});

test('Claude native request returns original input only on exact live permission; cancellation cannot revive it', async () => {
  const session=Object.create(ClaudeStreamSession.prototype);
  const frames=[];let release;
  Object.assign(session,{engineAgentId:'session',active:true,activeInputId:'turn',approvals:new Map(),seenApprovalIds:new Set(),
    opts:{signal:new AbortController().signal,handleElicitation:async()=>new Promise(resolve=>{release=resolve;})},
    writeFrame:async frame=>{frames.push(frame);}});
  const request={type:'control_request',request_id:'native-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'exact'}}};
  assert.equal(session.handleNativeRequest(request),true);
  release({action:'accept',content:{approve:true}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(frames[0],{type:'control_response',response:{subtype:'success',request_id:'native-1',response:{behavior:'allow',updatedInput:{command:'exact'}}}});
  session.handleNativeRequest(request);assert.equal(frames.length,1,'duplicate native identity never receives a second grant');
  session.handleNativeRequest({...request,request_id:'native-2'});
  session.handleNativeRequest({type:'control_cancel_request',request_id:'native-2'});
  release({action:'accept',content:{approve:true}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.length,1);
});

test('Claude session live methods dispatch structured controls, apply typed turn model and retain process on interrupt', async () => {
  const session=Object.create(ClaudeStreamSession.prototype);const frames=[];let closed=false;
  const controls=new ClaudeControls(async frame=>{
    frames.push(frame);
    queueMicrotask(()=>controls.observe({type:'control_response',response:{subtype:'success',request_id:frame.request_id,
      response:frame.request.subtype==='get_context_usage'?{totalTokens:123,rawMaxTokens:200000,model:'exact'}:{}}}));
  },()=> 'session');
  Object.assign(session,{engineAgentId:'session',opts:{resumeSessionId:'session',model:'old',handleElicitation:async()=>({action:'decline'})},
    fileHistory:new ClaudeFileHistory('session',async()=>{}),taskLifetime:new ClaudeTaskLifetime('session'),selectedModel:'old',controls,approvals:new Map(),seenApprovalIds:new Set(),seedHistory:[],
    contextObservations:{beginTurn(){},endTurn(){},contextUsage:()=>({usedTokens:999})},
    writeInput:async(text,id)=>{frames.push({text,id});},close:async()=>{closed=true;}});
  await session.startTurn({prompt:'new work',kind:'user_message',model:'exact',clientMessageId:'turn'});
  assert.equal(frames[0].request.subtype,'set_model');assert.equal(frames[0].request.model,'exact');
  assert.equal(frames[1].text,'new work');assert.equal(session.contextUsage(),undefined,'Old model occupancy is invalidated');
  const permission=await session.invokeCommand('native-permission-mode','plan');assert.equal(permission.outcome,'completed');
  assert.equal(frames[2].request.subtype,'set_permission_mode');
  await session.interrupt();assert.equal(frames[3].request.subtype,'interrupt');assert.equal(closed,false);
  assert.equal(session.active,true,'Interrupt ack does not fabricate ordinary turn completion');
  const usage=await session.invokeCommand('native-context-usage');assert.equal(usage.contextUsage.usedTokens,123);
  await assert.rejects(()=>session.invokeCommand('native-permission-mode','invented'),/Invalid/);
  controls.close();
});
