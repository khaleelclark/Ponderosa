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
  controls.observe({type:'control_response',response:{request_id:frames[1].request_id,subtype:'error',error:'Native permission mode is unavailable for this session'}});
  await assert.rejects(refused,/rejected native control: Native permission mode is unavailable for this session/);
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
    writeInputFrame:async frame=>{frames.push(frame);},close:async()=>{closed=true;}});
  await session.startTurn({prompt:'new work',kind:'user_message',model:'exact',clientMessageId:'turn'});
  assert.equal(frames[0].request.subtype,'set_model');assert.equal(frames[0].request.model,'exact');
  assert.equal(frames[1].message.content[0].text,'new work');assert.equal(frames[1].uuid,'turn');assert.equal(session.contextUsage(),undefined,'Old model occupancy is invalidated');
  const permission=await session.invokeCommand('native-permission-mode','plan');assert.equal(permission.outcome,'completed');
  assert.equal(frames[2].request.subtype,'set_permission_mode');
  await session.interrupt();assert.equal(frames[3].request.subtype,'interrupt');assert.equal(closed,false);
  assert.equal(session.active,true,'Interrupt ack does not fabricate ordinary turn completion');
  const usage=await session.invokeCommand('native-context-usage');assert.equal(usage.contextUsage.usedTokens,123);
  await assert.rejects(()=>session.invokeCommand('native-permission-mode','invented'),/Invalid/);
  controls.close();
});

import { answerCodexNativeQuestions, answerClaudeNativeQuestions } from '../../packages/engines/dist/native-questions.js';

const nativeQuestion = {id:'choice',header:'Format',question:'Which format should be used?',isOther:true,isSecret:false,
  options:[{label:'Brief',description:'A short answer'},{label:'Detailed',description:'A complete answer'}]};
const nativeQuestionParams = {threadId:'session',turnId:'turn',itemId:'item',questions:[nativeQuestion],isBlocking:false,autoResolutionMs:null};

test('native Codex questions preserve original IDs, free-text choices, secret metadata and nonblocking intent',async()=>{
  const controller=new AbortController();
  const result=await answerCodexNativeQuestions({signal:controller.signal,handleElicitation:async request=>{
    assert.equal(request.nativeApproval.kind,'question');
    assert.equal(request.nativeApproval.requestId,'original-rpc');
    assert.equal(request.blocking,false);
    assert.deepEqual(request.requestedSchema.properties.answer0.enum,['Brief','Detailed']);
    assert.equal(request.requestedSchema.properties.answer0['x-allow-other'],true);
    assert.equal(request.requestedSchema.properties.answer1.writeOnly,true);
    return {action:'accept',content:{answer0:'A custom human answer',answer1:'private value'}};
  }},'session',()=> 'turn','original-rpc',{...nativeQuestionParams,questions:[nativeQuestion,
    {...nativeQuestion,id:'private',header:'Secret',question:'Enter the private value',isSecret:true,options:null}]});
  assert.deepEqual(result,{answers:{choice:{answers:['A custom human answer']},private:{answers:['private value']}}});
});

test('native questions reject foreign or duplicate scope and cannot supply answers after cancellation or turn replacement',async()=>{
  let calls=0;
  const opts={signal:new AbortController().signal,handleElicitation:async()=>{calls++;return {action:'accept',content:{answer0:'Brief'}};}};
  await assert.rejects(()=>answerCodexNativeQuestions(opts,'foreign',()=> 'turn','rpc',nativeQuestionParams),/Foreign/);
  await assert.rejects(()=>answerCodexNativeQuestions(opts,'session',()=> 'turn','rpc',
    {...nativeQuestionParams,questions:[nativeQuestion,nativeQuestion]}),/alias/);
  assert.equal(calls,0);
  await assert.rejects(()=>answerCodexNativeQuestions({...opts,handleElicitation:async()=>({action:'decline'})},
    'session',()=> 'turn','rpc',nativeQuestionParams),/cancelled/);
  let turn='turn';
  await assert.rejects(()=>answerCodexNativeQuestions({...opts,handleElicitation:async()=>{turn='replacement';return {action:'accept',content:{answer0:'Brief'}};}},
    'session',()=> turn,'rpc',nativeQuestionParams),/expired/);
  const controller=new AbortController();
  await assert.rejects(()=>answerCodexNativeQuestions({signal:controller.signal,handleElicitation:async()=>{
    controller.abort();return {action:'accept',content:{answer0:'Brief'}};
  }},'session',()=> 'turn','rpc',nativeQuestionParams),/cancelled/);
  await assert.rejects(()=>answerCodexNativeQuestions({...opts,handleElicitation:async()=>({action:'accept',content:{answer0:'Other'}})},
    'session',()=> 'turn','rpc',{...nativeQuestionParams,questions:[{...nativeQuestion,isOther:false}]}),/outside/);
});

test('Claude native questions return original questions plus human multi-select and free text through the existing form',async()=>{
  const questions=[{header:'Sections',question:'Which sections?',multiSelect:true,options:[
    {label:'Intro',description:'Opening'},{label:'Conclusion',description:'Closing'}]},
    {header:'Format',question:'Which format?',multiSelect:false,options:nativeQuestion.options}];
  const original={questions};
  const result=await answerClaudeNativeQuestions({signal:new AbortController().signal,handleElicitation:async request=>{
    assert.equal(request.nativeApproval.kind,'question');
    assert.equal(request.requestedSchema.properties.answer0_0.type,'boolean');
    return {action:'accept',content:{answer0_0:true,answer0_1:true,answer0_other:'Appendix',answer1:'Custom format'}};
  }},{requestId:'rpc',sessionId:'session',turnId:'turn',kind:'question'},original);
  assert.deepEqual(result,{questions,answers:{'Which sections?':'Intro, Conclusion, Appendix','Which format?':'Custom format'}});
  assert.deepEqual(original,{questions},'Native tool input was not mutated');
});

test('Claude native question callback writes answers only while the original turn is current',async()=>{
  const session=Object.create(ClaudeStreamSession.prototype);
  const frames=[];let release;
  Object.assign(session,{engineAgentId:'session',active:true,activeInputId:'turn',approvals:new Map(),seenApprovalIds:new Set(),
    opts:{signal:new AbortController().signal,handleElicitation:()=>new Promise(resolve=>{release=resolve;})},
    writeFrame:async frame=>{frames.push(frame);}});
  const input={questions:[{header:'Format',question:'Which format?',multiSelect:false,options:nativeQuestion.options}]};
  const callback={type:'control_request',request_id:'question-1',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input}};
  session.handleNativeRequest(callback);
  release({action:'accept',content:{answer0:'Brief'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(frames[0].response.response,{behavior:'allow',updatedInput:{...input,answers:{'Which format?':'Brief'}}});
  session.handleNativeRequest({...callback,request_id:'question-2'});
  session.activeInputId='replacement';
  release({action:'accept',content:{answer0:'Detailed'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames[1].response.response.behavior,'deny');
  session.handleNativeRequest(callback);
  assert.equal(frames.length,2,'A duplicate original question cannot be replayed');
});

test('native question IDs and question text retain own data for prototype-shaped names',async()=>{
  const names=['__proto__','constructor','toString'];
  const opts={signal:new AbortController().signal,handleElicitation:async()=>({
    action:'accept',content:{answer0:'Brief',answer1:'Detailed',answer2:'Custom'},
  })};
  const codex=await answerCodexNativeQuestions(opts,'session',()=> 'turn','rpc',{
    ...nativeQuestionParams,questions:names.map(id=>({...nativeQuestion,id})),
  });
  assert.deepEqual(Object.keys(codex.answers),names);
  for (const [index,name] of names.entries()) {
    assert.equal(Object.hasOwn(codex.answers,name),true);
    assert.deepEqual(codex.answers[name],{answers:[['Brief','Detailed','Custom'][index]]});
  }
  assert.deepEqual(JSON.parse(JSON.stringify(codex)),codex);
  const claude=await answerClaudeNativeQuestions(opts,{
    requestId:'rpc',sessionId:'session',turnId:'turn',kind:'question',
  },{questions:names.map(question=>({header:'Format',question,multiSelect:false,options:nativeQuestion.options}))});
  assert.deepEqual(Object.keys(claude.answers),names);
  assert.deepEqual(JSON.parse(JSON.stringify(claude.answers)),Object.fromEntries(names.map((name,index)=>[name,['Brief','Detailed','Custom'][index]])));
});
