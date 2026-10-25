import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {VoicePhraseBuffer,voiceTimingText} from '../../apps/web/src/components/speech/voiceReplyStream.ts';
import {voiceReplyInWindow} from '../../apps/web/src/components/speech/voiceReply.ts';
import {speakableMessageText} from '../../apps/web/src/components/speech/speechText.ts';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),React=require('react'),ts=require('typescript');
const mui=new Proxy({useMediaQuery:()=>false},{get:(o,k)=>o[k]??String(k)});
// Exercise actual component closures. Only React scheduling, native speech and transport are controlled.
function fixture(module,imports,globals={}){
 const slots=[],effects=[];let index=0,dirty=false,tree,component,props,uid=0;
 const state=initial=>{const i=index++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;dirty=true;}];};
 const effect=(fn,deps)=>{const i=index++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}};
 const react={...React,useState:state,useRef:value=>state(()=>({current:value}))[0],useEffect:effect,useLayoutEffect:effect,useId:()=>state(()=>`voice-${uid++}`)[0],useCallback:(fn,deps)=>react.useMemo(()=>fn,deps),useMemo(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))slots[i]={deps,value:fn()};return slots[i].value;},useSyncExternalStore:(_subscribe,snapshot)=>snapshot()};
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/speech/'+module+'.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,console,performance,Date,JSON,setTimeout,clearTimeout,setInterval,clearInterval,...globals,require:name=>name==='react'?react:name==='@mui/material'?mui:name in imports?imports[name]:name.startsWith('@mui/icons-material/')?{__esModule:true,default:name}:require(name)});
 const walk=node=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'&&'props'in node?[node,...walk(node.props.children)]:[];
 const all=(node=tree)=>walk(node);
 const render=()=>{let count=0;do{dirty=false;index=0;tree=component(props);for(const node of all()){if(node.ref&&typeof node.ref==='object'&&!node.ref.current)node.ref.current={focus(){},isConnected:true};}for(const run of effects.splice(0))run();assert.ok(++count<30,'component must settle');}while(dirty);return tree;};
 return{exports,mount(fn,p){component=fn;props=p;return render();},render,all,find(predicate){const n=all().find(predicate);assert.ok(Boolean(n),'expected control exists');return n;},update(next){props={...props,...next};return render();},unmount(){for(const slot of slots)slot?.cleanup?.();},async flush(){await new Promise(resolve=>setImmediate(resolve));return render();}};
}
const agent=(id='agent',conversationId='chat')=>({id,projectId:'project',conversationId,title:id,handle:id});
const context={projectId:'project',conversationId:'chat',agents:[agent()],selectedAgentId:'agent',lockAgent:true};
function menuFixture(extra={}){
 const calls=[],dictation={status:'ready',start:()=>calls.push('start'),pause:()=>calls.push('pause'),resume:()=>calls.push('resume'),stop:()=>calls.push('stop')};let readOnly=false,handlers;
 function VoiceConversation(){}
 const f=fixture('DictationControls',{'./useDictation':{useDictation:(...args)=>{handlers=args;return dictation;}},'./speechStyles':{},'./VoiceConversation':{VoiceConversation},'../WorkspaceReadOnlyContext':{useWorkspaceReadOnly:()=>readOnly}});
 f.mount(f.exports.DictationControls,{disabled:false,voiceContext:context,onFinalTranscript:words=>calls.push(['words',words]),onSettlingChange:value=>calls.push(['settling',value]),...extra});
 const item=label=>f.find(n=>n.type==='MenuItem'&&f.all(n).some(child=>child.props.primary===label));
 return{...f,calls,dictation,item,VoiceConversation,handlers:()=>handlers,readOnly(value){readOnly=value;f.render();},open(){f.find(n=>n.props['aria-label']==='Voice options').props.onClick({currentTarget:{id:'trigger'}});f.render();}};
}
test('Voice options opens a named MUI menu without capture or submission; call keeps the exact workspace owner',()=>{
 const f=menuFixture();f.open();assert.deepEqual(f.calls,[]);
 const menu=f.find(n=>n.type==='Menu');assert.equal(menu.props.open,true);assert.equal(menu.props.MenuListProps['aria-label'],'Voice options');assert.equal(menu.props.container,f.handlers()[2].current,'menu must not hide its own live dictation surface');
 f.item('Voice call').props.onClick();f.render();assert.equal(f.find(n=>n.type==='Menu').props.open,false);assert.deepEqual(f.calls,[]);
 const call=f.find(n=>n.type===f.VoiceConversation);assert.equal(call.props.projectId,'project');assert.equal(call.props.conversationId,'chat');assert.equal(call.props.selectedAgentId,'agent');assert.equal(call.props.lockAgent,true);
 call.props.onClose();f.render();assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.unmount();
});
test('Dictation stays mounted outside the closing menu and retains insertion, settle, pause/resume/stop callbacks',()=>{
 const f=menuFixture();const controllerSurface=f.handlers()[2];f.open();f.item('Dictation').props.onClick();f.render();assert.deepEqual(f.calls,['start']);assert.equal(f.find(n=>n.type==='Menu').props.open,false);assert.equal(f.handlers()[2]===controllerSurface,true,'same recognition controller surface survives closing menu');
 f.handlers()[0]('final words');f.handlers()[1](true);assert.deepEqual(f.calls.slice(1),[['words','final words'],['settling',true]]);
 f.dictation.status='listening';f.render();f.open();assert.equal(f.item('Voice call').props.disabled,true);f.item('Dictation').props.onClick();f.render();
 f.dictation.status='paused';f.render();f.open();f.item('Dictation').props.onClick();f.render();f.find(n=>n.props['aria-label']==='Stop voice dictation').props.onClick();assert.deepEqual(f.calls.slice(-3),['pause','resume','stop']);f.unmount();
});
test('missing/foreign owner, unavailable recognition and read-only scopes do not enable unsafe actions',()=>{
 for(const voiceContext of [undefined,{...context,agents:[agent('other','foreign')]},{...context,selectedAgentId:'foreign'}]){const f=menuFixture({voiceContext});f.open();assert.equal(f.item('Voice call').props.disabled,true);f.unmount();}
 const f=menuFixture();f.dictation.unavailableReason='Speech recognition unavailable';f.render();f.open();assert.equal(f.item('Dictation').props.disabled,true);assert.equal(f.item('Voice call').props.disabled,false,'typing in the existing call remains available');
 f.item('Voice call').props.onClick();f.render();f.readOnly(true);assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);assert.equal(f.find(n=>n.props['aria-label']==='Voice options').props.disabled,true);f.readOnly(false);assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false,'reenabling a surface must not reopen a call');f.unmount();
});

function callFixture({product='dev',selectedAgentId='agent',agents=[agent()],lockAgent=true}={}){
 const sent=[],spoken=[],events=[],timers=new Map();let id=0,closed=0,observer,stream,playback={status:'idle'},onInactive,queued;
 const dictation={status:'ready',start(){events.push('capture');dictation.status='listening';},abandon(){events.push('abandon');dictation.status='ready';},stop(){dictation.status='stopped';}};
 const detail={conversation:{id:'chat',projectId:'project',...(product==='branches'?{branchId:'branch'}:{})},agents,messages:[]};
 const queryClient={invalidateQueries:async()=>{}};
 const api={getConversation:async()=>detail,getVoiceReplyStatus:async()=>({messageId:'input',runId:'run',runStatus:'running',memoryExposure:{state:'disabled',runId:'run'}}),sendMultiAgentDirectMessage:async(chat,request)=>{sent.push({chat,request});return {messageId:'input',message:{id:'input',communicationEventId:'input',conversationId:chat,role:'user',text:request.text,createdAt:new Date().toISOString()},recipients:[{queued:true}]};},subscribeAgent(_id,_cursor,handlers){stream=handlers;return{close(){events.push('stream-closed');}};},cancelRun:async()=>events.push('cancel-run')};
 class QueryObserver{constructor(_client,options){this.options=options;}subscribe(fn){observer=fn;return()=>events.push('observer-unsubscribed');}destroy(){events.push('observer-destroyed');}}
 const speech={subscribeSpeech:()=>()=>{},speechSnapshot:()=>playback,stopSpeech(){events.push('stop-speech');playback={status:'stopped'};return true;},startSpeech(){},startSpeechQueue(owner,_prefs,_surface,complete,started,before){playback={ownerId:owner,status:'loading'};queued={append(text){spoken.push(text);return true;},finish(){events.push('queue-finished');},stop(){events.push('queue-stopped');},complete,started,before};return queued;}};
 const attempt={VOICE_ATTEMPT_TTL:86400000,restoreVoiceCallAttempt:async()=>({}),retainVoiceCallAttempt:()=>true,settleVoiceCallAttempt:()=>events.push('settled'),voiceCallAttemptCanRetry:async()=>true,prepareVoiceCallAttempt:async(route,text)=>({marker:{route},request:{text,recipients:[{agentId:route.agentId}],voiceReply:true,idempotencyKey:'exact-turn',activeRunDelivery:'queue'}})};
 const f=fixture('VoiceConversation',{'../../clientId':{createClientId:()=> 'operation'},'@ponderosa/core':{DEFAULT_SPEECH_PREFERENCES:{speed:1}},'@tanstack/react-query':{QueryObserver,useQueryClient:()=>queryClient},'../../api':{api},'../../api/productScope':{productApiPath:path=>product==='branches'?'/api/branches/engine/'+path.slice(5):path,currentProductScope:()=>product},'../../hooks/queries':{useWorkspacePreferences:()=>({})},'../../queryKeys':{queryKeys:{conversations:{detail:()=>['conversation'],detailPrefix:()=>['conversation']}}},'../../conversationMessageReceipt':{publishConversationMessageReceipt:async()=>{}},'./browserSpeech':{dictationUnavailableReason:()=>undefined,speechSynthesisUnavailableReason:()=>undefined},'./speechCoordinator':speech,'./speechSurfaceAccessibility':{monitorSpeechSurfaceAccessibility(_surface,fn){onInactive=fn;return()=>{};}},'./speechText':{speakableMessageText},'./useDictation':{useDictation:()=>dictation},'./voiceReplyStream':{VoicePhraseBuffer,voiceTimingText},'./voiceReply':{voiceReplyInWindow},'./voiceCallAttempt':attempt},{window:Object.assign(new EventTarget(),{location:{origin:'https://test.invalid'}}),setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:key=>timers.delete(key),setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)});
 const outer=f.exports.VoiceConversation({...context,agents,selectedAgentId,lockAgent,open:true,onClose:()=>closed++});const session=React.Children.toArray(outer.props.children)[0];
 f.mount(session.type,session.props);f.find(n=>n.type==='DialogContent').ref({isConnected:true,contains:()=>false});f.render();
 const findButton=name=>f.find(n=>n.type==='Button'&&n.props.children===name);
 const sendTurn=async()=>{await f.flush();findButton('Transcript & typing').props.onClick();f.render();f.find(n=>n.type==='TextField'&&n.props.label==='Your next turn').props.onChange({target:{value:'A private voice turn'}});f.render();findButton('Send turn').props.onClick();await f.flush();await f.flush();};
 const canonical=text=>{detail.messages=[{id:'input',conversationId:'chat',role:'user',text:'A private voice turn',deliveryReceipts:[{targetAgentId:'agent',state:'processed',executionId:'run'}]},{id:'answer',conversationId:'chat',role:'assistant',communicationIntent:'user_dm',authorAgentId:'agent',executionId:'run',text,createdAt:new Date().toISOString()}];observer({isSuccess:true,isFetching:false,isFetchedAfterMount:true,data:detail});f.render();};
 return{...f,dictation,events,sent,spoken,detail,sendTurn,canonical,findButton,timers,closed:()=>closed,inactive:()=>onInactive(),stream:()=>stream,queued:()=>queued};
}
for(const product of ['dev','branches'])test(`${product}: opening a call does not capture/send; explicit Start, mute, End and unmount fence local audio`,async()=>{
 const f=callFixture({product});await f.flush();assert.deepEqual(f.sent,[]);assert.equal(f.events.includes('capture'),false);assert.equal(f.findButton('Start call').props.disabled,false);
 f.findButton('Start call').props.onClick();f.render();assert.equal(f.events.filter(e=>e==='capture').length,1);
 f.find(n=>n.type==='Button'&&Array.isArray(n.props.children)===false&&n.props['aria-pressed']===false).props.onClick();f.render();assert.equal(f.dictation.status,'ready');assert.equal(f.sent.length,0);f.findButton('End call').props.onClick();assert.equal(f.closed(),1);f.unmount();assert.equal(f.timers.size,0);assert.equal(f.events.includes('cancel-run'),false);
});
test('Chat chooser uses canonical members; fixed Agent owner has no chooser',async()=>{
 const f=callFixture({agents:[agent(),agent('second')],selectedAgentId:'',lockAgent:false});await f.flush();assert.equal(f.findButton('Start call').props.disabled,true);const picker=f.find(n=>n.type==='TextField'&&n.props.label==='Call Agent');picker.props.onChange({target:{value:'second'}});f.render();await f.flush();assert.equal(f.findButton('Start call').props.disabled,false);f.unmount();
 const locked=callFixture();await locked.flush();assert.equal(locked.all().some(n=>n.props.label==='Call Agent'),false);locked.unmount();
});
for(const streaming of [false,true])test(`${streaming?'streamed':'non-streaming canonical'} reply speaks only its exact remaining text once`,async()=>{
 const f=callFixture();await f.sendTurn();assert.equal(f.sent.length,1);assert.equal(f.sent[0].chat,'chat');assert.equal(f.sent[0].request.recipients[0].agentId,'agent');assert.equal(f.sent[0].request.voiceReply,true);
 if(streaming){const reply={projectId:'project',conversationId:'chat',messageId:'input',agentId:'agent',runId:'run',fence:1,streamId:'s',itemId:'i',providerTurnId:'p',sequence:1,text:'First sentence. ',state:'streaming'};f.stream().onEvent({agentId:'agent',event:{type:'voice_reply',reply}});f.render();f.stream().onEvent({agentId:'agent',event:{type:'voice_reply',reply}});f.render();assert.deepEqual(f.spoken,['First sentence.']);}
 const emit=f.stream().onEvent;f.canonical('First sentence. Canonical tail.');assert.deepEqual(f.spoken,streaming?['First sentence.','Canonical tail.']:['First sentence. Canonical tail.']);f.canonical('First sentence. Canonical tail.');assert.equal(f.spoken.length,streaming?2:1);f.unmount();emit({agentId:'agent',event:{type:'voice_reply',reply:{text:'late'}}});assert.equal(f.spoken.length,streaming?2:1);assert.equal(f.timers.size,0);assert.equal(f.events.includes('cancel-run'),false);
});
test('background and unmount close observations and ignore late streaming callbacks without cancelling accepted work',async()=>{
 const f=callFixture();await f.sendTurn();const emit=f.stream().onEvent;f.inactive();f.render();assert.equal(f.events.includes('stream-closed'),true);assert.equal(f.timers.size,0);emit({agentId:'agent',event:{type:'voice_reply',reply:{text:'late'}}});assert.deepEqual(f.spoken,[]);assert.equal(f.events.includes('cancel-run'),false);f.unmount();
});

test('changing only a resolved call recipient preserves ordinary dictation but retires the old call',()=>{
 const f=menuFixture();f.dictation.status='listening';f.render();const controller=f.handlers()[2];f.update({voiceContext:{...context,selectedAgentId:'second',agents:[agent(),agent('second')]}});assert.equal(f.handlers()[2]===controller,true);assert.deepEqual(f.calls,[]);f.dictation.status='stopped';f.render();f.open();f.item('Voice call').props.onClick();f.render();assert.equal(f.all().some(n=>n.type===f.VoiceConversation),true);f.update({voiceContext:context});assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.update({voiceContext:{...context,selectedAgentId:'second',agents:[agent(),agent('second')]}});assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.unmount();
});

test('recognition permission failure pauses the call; a foreign canonical Chat never enables capture',async()=>{
 const f=callFixture();await f.flush();f.findButton('Start call').props.onClick();f.render();f.dictation.status='error';f.dictation.error='Microphone permission was denied.';f.render();assert.equal(f.all().some(n=>n.type==='Alert'&&n.props.children==='Microphone permission was denied.'),true);assert.equal(f.sent.length,0);f.unmount();
 const foreign=callFixture();foreign.detail.conversation.id='foreign';await foreign.flush();assert.equal(foreign.findButton('Resume call').props.disabled,false);assert.equal(foreign.events.includes('capture'),false);assert.equal(foreign.sent.length,0);foreign.unmount();
});
