// Deferred source: run only after the normal dependency build is authorized.
import assert from 'node:assert/strict';
import test from 'node:test';
import {requiredReplyRequest} from '../../apps/server/dist/required-reply-route.js';
import {VoiceReplyStream} from '../../apps/server/dist/voice-reply-stream.js';
import {parseReplyStreamArguments,replyStreamSource,replyStreamCommit} from '../../apps/server/dist/reply-stream-publication.js';

const scope={runId:'run',agentId:'agent',conversationId:'chat'};
const shared={eventId:'shared',projectId:'project',conversationId:'chat',createdAt:'accepted',intent:'broadcast',sender:{kind:'user',userId:'local-operator'},audience:{kind:'all'},document:{id:'incoming-document'}};
const privateInput={...shared,eventId:'private',intent:'user_dm',audience:{kind:'user_agents',userId:'local-operator',agentIds:['agent']}};
function fixture(){
 const inputs=[shared,privateInput],requests=new Map([['request',{id:'request',projectId:'project',conversationId:'chat',recipientAgentId:'agent',requesterAgentId:'peer',state:'in_progress'}]]);
 const store={getAgent:id=>id==='agent'?{id,projectId:'project',conversationId:'chat'}:undefined,getConversation:id=>id==='chat'?{id,projectId:'project'}:undefined,
   sqlite:{prepare:sql=>({get:()=>sql.includes('SELECT created_at')?{created_at:'accepted'}:{branch_id:null,branch_execution_id:null,project_id:'project'}})}};
 const coordination={requestIdsAttachedToRun:()=>['request'],requiredReplyObligationsForRun:()=>[],
   activationIdsAttachedToRun:()=>['a','b'],activationPayloads:()=>inputs.map((communication,i)=>({id:i?'b':'a',kind:'human_message',payload:{communication}})),
   runtimeCommunicationForEvent:(id,agentId)=>{const input=agentId==='agent'&&inputs.find(x=>x.eventId===id);return input?{payload:{communication:input},activations:[{id:id==='shared'?'a':'b',agentId:'agent'}]}:undefined;},getRequest:id=>requests.get(id)};
 return {store,coordination,requests};
}
test('document input and coalesced routes require the selected exact canonical audience',()=>{
 const {store,coordination}=fixture();
 assert.equal(replyStreamSource(store,coordination,scope,'text'),undefined,'mixed routes have no inferred default');
 for(const intent of ['broadcast','direct_to_user'])assert.equal(replyStreamSource(store,coordination,scope,'text',{kind:'message',intent}).publication.intent,intent);
 assert.equal(replyStreamSource(store,coordination,scope,'text',{kind:'message',intent:'collaboration',recipientAgentIds:['outsider']}),undefined);
 const selected={kind:'message',intent:'direct_to_user',documentTitle:'Private report',taskDelivery:'final'};
 const command=replyStreamCommit(selected,'PRIVATE DOCUMENT','fence');
 assert.equal(command.url,'/api/agent-messages');assert.equal(command.payload.intent,'direct_to_user');
 assert.equal(command.payload.document.content,'PRIVATE DOCUMENT');assert.equal(command.payload.text,'Private report');assert.equal(command.payload.taskDelivery,'final');
 assert.equal(command.payload.steeringInjectionId,'fence');
});
test('correlated stream requires attached recipient ownership and commits only through update_request',()=>{
 const {store,coordination,requests}=fixture(),publication={kind:'request_update',requestId:'request',updateKind:'completed'};
 assert.equal(replyStreamSource(store,coordination,scope,'text',publication).messageId,'request');
 assert.deepEqual(replyStreamCommit(publication,'Canonical result'),{url:'/api/agent-request-updates',payload:{requestId:'request',kind:'completed',text:'Canonical result'}});
 assert.equal(replyStreamSource(store,coordination,scope,'text',{...publication,requestId:'foreign'}),undefined);
 for(const patch of [{recipientAgentId:'other'},{projectId:'other'},{conversationId:'other'},{state:'completed'}]){
  requests.set('request',{id:'request',projectId:'project',conversationId:'chat',recipientAgentId:'agent',state:'in_progress',...patch});
  assert.equal(replyStreamSource(store,coordination,scope,'text',publication),undefined);
 }
});
test('acknowledgement exposes actual provider bytes only after exact native success and permits continued work',()=>{
 const args=parseReplyStreamArguments({acknowledgement:'I will inspect the requested file.'},'voice',[]);
 const initial={presentation:'voice',purpose:'acknowledgement',projectId:'project',conversationId:'chat',agentId:'agent',messageId:'private',runId:'run',fence:1,streamId:'stream',sequence:0,text:'',state:'open',acceptedAt:'accepted'};
 const stream=new VoiceReplyStream(initial,[],'native-operation',args.acknowledgement);
 assert.equal(stream.snapshot.text,'');assert.equal(stream.finalText(),undefined);
 const receipt={type:'tool_result',id:'native-operation',isError:false,voiceReplyStreamId:'stream',output:''};
 assert.equal(stream.observeWork({...receipt,id:'foreign'}),false);assert.equal(stream.snapshot.text,'');
 const failed=new VoiceReplyStream({...initial},[],'native-operation',args.acknowledgement);
 assert.equal(failed.observeWork({...receipt,isError:true}),true);assert.equal(failed.snapshot.state,'failed');
 assert.equal(failed.observeWork(receipt),false);assert.equal(failed.snapshot.text,'');
 assert.equal(stream.observeWork(receipt,'receipt-time'),true);assert.equal(stream.snapshot.text,args.acknowledgement);
 assert.equal(stream.snapshot.firstTextAt,'receipt-time');assert.equal(stream.snapshot.state,'streaming');
 assert.equal(stream.observeWork({type:'command',command:'inspect file'}),false);assert.equal(stream.receiptAccepted(),true);
 assert.equal(stream.accept({type:'response_text',kind:'complete',phase:'final_answer',providerTurnId:'turn',itemId:'item',text:'Unrelated work log'},'later'),false);
 assert.equal(stream.finalText(),undefined);const sequence=stream.snapshot.sequence;
 assert.equal(stream.observeWork(receipt),false);assert.equal(stream.snapshot.sequence,sequence);
 stream.invalidate('context_changed');assert.equal(stream.receiptAccepted(),false);assert.equal(stream.observeWork(receipt),false);
});
test('tool schema rejects authority borrowing and out-of-scope acknowledgement',()=>{
 for(const [value,presentation] of [[{acknowledgement:'hello'},'text'],[{acknowledgement:'x'.repeat(501)},'voice'],[{publication:{kind:'message',intent:'direct_to_user',recipientAgentIds:['peer']}},'text'],[{publication:{kind:'request_update',requestId:'request',updateKind:'answer'}},'text'],[{publication:{kind:'message',intent:'broadcast'}},'voice']])assert.throws(()=>parseReplyStreamArguments(value,presentation,[]));
});


test('voice source follows only the latest acknowledged injection despite old tasks and calls',()=>{
 const {store,coordination}=fixture();
 const voice={...privateInput,document:undefined,eventId:'call-new'};
 let selected='new-injection',satisfied=false;
 coordination.latestAcknowledgedPromptInjection=()=>({id:selected,kind:'steer'});
 coordination.activationIdsForInjection=id=>id==='new-injection'?['new-call']:['old-call'];
 coordination.activationPayloads=(_agent,ids)=>ids.map(id=>({id,kind:'human_message',promptClass:'human',payload:{communication:id==='new-call'?voice:{...voice,eventId:'call-old'},dispatch:{voiceReply:true}}}));
 coordination.runtimeCommunicationForEvent=id=>({projectId:'project',payload:{communication:{...voice,eventId:id},dispatch:{voiceReply:true,activeRunDelivery:'steer',conversationId:'chat',recipients:[{agentId:'agent'}]}},activations:[{id:id==='call-new'?'new-call':'old-call',agentId:'agent'}]});
 coordination.voiceReplyRunTiming=()=>({runId:'run'});
 coordination.requiredReplyObligationsForRun=()=>[{sourceActivationId:'old-call',state:'satisfied',replyAuthority:{intent:'direct_to_user'}},{sourceActivationId:'new-call',state:satisfied?'satisfied':'pending',replyAuthority:{intent:'direct_to_user'}}];
 assert.equal(replyStreamSource(store,coordination,scope,'voice').messageId,'call-new');
 selected='old-injection';assert.equal(replyStreamSource(store,coordination,scope,'voice'),undefined,'a satisfied earlier call cannot reauthorize');
 selected='new-injection';satisfied=true;assert.equal(replyStreamSource(store,coordination,scope,'voice'),undefined);
});


test('call response identity stays separate from an older task final while a delegated call retains its own final',()=>{
 const route={intent:'direct_to_user'},base={agentId:'agent',replyAuthority:route,state:'pending',deliveryPhase:'final'};
 const task={...base,sourceActivationId:'task'},call={...base,sourceActivationId:'call',state:'satisfied',deliveryPhase:'initial'};
 const coordination={requiredReplyObligationsForRun:()=>[task,call],steeringInjectionIds:()=>['call-injection'],
  promptInjectionForActivation:(_run,id)=>({id:id==='call'?'call-injection':'task-injection'}),
  latestAcknowledgedPromptInjection:()=>({id:'call-injection'}),activationIdsForInjection:()=>['call'],
  activationPayloads:()=>[{id:'call',payload:{dispatch:{voiceReply:true}}}],runtimeCommunication:()=>undefined};
 const answer=requiredReplyRequest(coordination,'run',route),final=requiredReplyRequest(coordination,'run',route,'final');
 assert.deepEqual(answer.sourceActivationIds,['call']);assert.deepEqual(final.sourceActivationIds,['task']);assert.notEqual(final.key,answer.key);
 call.deliveryPhase='final';call.state='pending';
 assert.deepEqual(requiredReplyRequest(coordination,'run',route,'final').sourceActivationIds,['call','task'],'a call that delegates work keeps its tracked final obligation');
});
