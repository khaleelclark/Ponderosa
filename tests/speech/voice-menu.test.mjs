import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {VoicePhraseBuffer,VoiceReplyBuffers,voiceTimingText} from '../../apps/web/src/components/speech/voiceReplyStream.ts';
import {voiceReplyInWindow} from '../../apps/web/src/components/speech/voiceReply.ts';
import {assistantSubmissionError} from '../../apps/web/src/components/chat/composerUtils.ts';
import {speakableMessageText} from '../../apps/web/src/components/speech/speechText.ts';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),React=require('react'),ts=require('typescript');
const mui=new Proxy({useMediaQuery:()=>false},{get:(o,k)=>o[k]??String(k)});
// Exercise actual component closures. Only React scheduling, native speech and transport are controlled.
function fixture(module,imports,globals={}){
 const slots=[],effects=[];let index=0,dirty=false,tree,component,props,uid=0;
 const state=initial=>{const i=index++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;dirty=true;}];};
 const effect=(fn,deps)=>{const i=index++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}};
 const react={...React,useContext:context=>context._fixtureValue??context._currentValue,useState:state,useRef:value=>state(()=>({current:value}))[0],useEffect:effect,useLayoutEffect:effect,useId:()=>state(()=>`voice-${uid++}`)[0],useCallback:(fn,deps)=>react.useMemo(()=>fn,deps),useMemo(fn,deps){const i=index++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))slots[i]={deps,value:fn()};return slots[i].value;},useSyncExternalStore:(_subscribe,snapshot)=>snapshot()};
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/speech/'+module+'.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,console,performance,Date,JSON,setTimeout,clearTimeout,setInterval,clearInterval,...globals,require:name=>name==='react'?react:name==='@mui/material'?mui:name in imports?imports[name]:name.startsWith('@mui/icons-material/')?{__esModule:true,default:name}:require(name)});
 const walk=node=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'&&'props'in node?[node,...walk(node.props.children)]:[];
 const all=(node=tree)=>walk(node);
 const render=()=>{let count=0;do{dirty=false;index=0;tree=component(props);for(const node of all()){if(node.ref&&typeof node.ref==='object'&&!node.ref.current)node.ref.current=node.type==="audio"&&globals.audioElement?globals.audioElement:{focus(){},contains(){return false;},isConnected:true};}for(const run of effects.splice(0))run();assert.ok(++count<30,'component must settle');}while(dirty);return tree;};
 return{exports,mount(fn,p){component=fn;props=p;return render();},render,all,find(predicate){const n=all().find(predicate);assert.ok(Boolean(n),'expected control exists');return n;},update(next){props={...props,...next};return render();},unmount(){for(const slot of slots)slot?.cleanup?.();},async flush(){await new Promise(resolve=>setImmediate(resolve));return render();}};
}
const agent=(id='agent',conversationId='chat')=>({id,projectId:'project',conversationId,title:id,handle:id});
const context={projectId:'project',conversationId:'chat',agents:[agent()],selectedAgentId:'agent',lockAgent:true};
function menuFixture(extra={},callActionsHost=null){
 const body={nodeType:1,isConnected:true},recordingContainer={nodeType:1,contains:()=>false},portals=[];
 const doc={body,activeElement:body};
 const calls=[],dictation={status:'ready',start:()=>calls.push('start'),pause:()=>calls.push('pause'),resume:()=>calls.push('resume'),stop:()=>calls.push('stop')};let readOnly=false,handlers;
 function VoiceConversation(){}
 function VoiceMessageRecorder(){}
 const f=fixture('DictationControls',{'react-dom':{flushSync:fn=>fn(),createPortal:(node,container)=>{portals.push(container);return node;}},'./useDictation':{useDictation:(...args)=>{handlers=args;return dictation;}},'./speechStyles':{},'./VoiceConversation':{VoiceConversation},'./VoiceMessageRecorder':{VoiceMessageRecorder},'../../api/productScope':{isOutputAppPath:()=>false},'../WorkspaceReadOnlyContext':{useWorkspaceReadOnly:()=>readOnly},'../ConversationChromeContext':{ConversationChromeContext:{_fixtureValue:{statusHost:null,callActionsHost}}}},{document:doc,window:{location:{pathname:'/'}}});
 f.mount(f.exports.DictationControls,{disabled:false,voiceContext:context,recordingContainer,onFinalTranscript:words=>calls.push(['words',words]),onSettlingChange:value=>calls.push(['settling',value]),...extra});
 const item=label=>f.find(n=>n.type==='MenuItem'&&f.all(n).some(child=>child.props.primary===label));
 return{...f,doc,calls,dictation,item,VoiceConversation,VoiceMessageRecorder,recordingContainer,portals,handlers:()=>handlers,readOnly(value){readOnly=value;f.render();},open(){f.find(n=>n.props['aria-label']==='Voice Options').props.onClick({currentTarget:{id:'trigger'}});f.render();}};
}
test('Voice options opens a named MUI menu without capture or submission; call keeps the exact workspace owner',()=>{
 const f=menuFixture();f.open();assert.deepEqual(f.calls,[]);
 const menu=f.find(n=>n.type==='Menu');assert.equal(menu.props.open,true);assert.equal(menu.props.MenuListProps['aria-label'],'Voice Options');assert.equal(menu.props.container,f.handlers()[2].current,'menu must not hide its own live dictation surface');
 f.item('Voice Call').props.onClick();f.render();assert.equal(f.find(n=>n.type==='Menu').props.open,false);assert.deepEqual(f.calls,[]);
 const call=f.find(n=>n.type===f.VoiceConversation);assert.equal(call.props.projectId,'project');assert.equal(call.props.conversationId,'chat');assert.equal(call.props.selectedAgentId,'agent');assert.equal(call.props.lockAgent,true);
 assert.equal(call.props.startOnOpen,true);call.props.onClose();f.render();assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.unmount();
});
test('voice recording opens directly from its distinct toolbar action without menu or staging',()=>{
 const attached=[],activity=[],f=menuFixture({onVoiceAttachment:file=>{attached.push(file);},onActiveChange:value=>activity.push(value),maxRecordingBytes:1024});
 const record=f.find(n=>n.props['aria-label']==='Record Voice Message');assert.equal(record.props.disabled,false);
 record.props.onClick();assert.equal(activity.at(-1),true,'pending permission must synchronously block submission before effects');f.render();assert.equal(f.find(n=>n.type==='Menu').props.open,false);assert.equal(f.portals.at(-1),f.recordingContainer,'inline capture must use the explicit owned slot');
 assert.equal(f.all().some(n=>n.type===f.VoiceMessageRecorder),true);assert.deepEqual(attached,[]);assert.deepEqual(f.calls,[]);
 f.find(n=>n.type===f.VoiceMessageRecorder).props.onClose();f.render();assert.equal(activity.at(-1),false,'staging or discard releases capture gating');f.open();
 assert.equal(f.all().some(n=>n.type==='MenuItem'&&f.all(n).some(child=>child.props.primary==='Record Voice Message')),false,'recording must not require a second menu route');
 f.dictation.status='listening';f.render();assert.equal(f.find(n=>n.props['aria-label']==='Record Voice Message').props.disabled,true);
 f.dictation.status='ready';f.render();f.readOnly(true);assert.equal(f.find(n=>n.props['aria-label']==='Record Voice Message').props.disabled,true);f.unmount();
});
test('changing recording owner unmounts its recorder and never revives the previous capture',()=>{
 const f=menuFixture({onVoiceAttachment:()=>undefined});
 f.find(n=>n.props['aria-label']==='Record Voice Message').props.onClick();f.render();
 assert.equal(f.all().some(n=>n.type===f.VoiceMessageRecorder),true);
 f.update({voiceContext:{...context,selectedAgentId:'second',agents:[agent(),agent('second')]}});
 assert.equal(f.all().some(n=>n.type===f.VoiceMessageRecorder),false,'owner change must remove the old recorder during render');
 f.update({voiceContext:context});assert.equal(f.all().some(n=>n.type===f.VoiceMessageRecorder),false,'returning to the old owner must not reopen capture');f.unmount();
});
test('Dictation stays mounted outside the closing menu and retains insertion, settle, pause/resume/stop callbacks',()=>{
 const f=menuFixture();const controllerSurface=f.handlers()[2];f.open();f.item('Dictation').props.onClick();f.render();assert.deepEqual(f.calls,['start']);assert.equal(f.find(n=>n.type==='Menu').props.open,false);assert.equal(f.handlers()[2]===controllerSurface,true,'same recognition controller surface survives closing menu');
 f.handlers()[0]('final words');f.handlers()[1](true);assert.deepEqual(f.calls.slice(1),[['words','final words'],['settling',true]]);
 f.dictation.status='listening';f.render();f.open();assert.equal(f.item('Voice Call').props.disabled,true);f.item('Dictation').props.onClick();f.render();
 f.dictation.status='paused';f.render();f.open();f.item('Dictation').props.onClick();f.render();f.find(n=>n.props['aria-label']==='Stop Voice Dictation').props.onClick();assert.deepEqual(f.calls.slice(-3),['pause','resume','stop']);f.unmount();
});
test('missing/foreign owner, unavailable recognition and read-only scopes do not enable unsafe actions',()=>{
 for(const voiceContext of [undefined,{...context,agents:[agent('other','foreign')]},{...context,selectedAgentId:'foreign'}]){const f=menuFixture({voiceContext});f.open();assert.equal(f.item('Voice Call').props.disabled,true);f.unmount();}
 const f=menuFixture();f.dictation.unavailableReason='Speech recognition unavailable';f.render();f.open();assert.equal(f.item('Dictation').props.disabled,true);assert.equal(f.item('Voice Call').props.disabled,false,'typing in the existing call remains available');
 f.item('Voice Call').props.onClick();f.render();f.readOnly(true);assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);assert.equal(f.find(n=>n.props['aria-label']==='Voice Options').props.disabled,true);f.readOnly(false);assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false,'reenabling a surface must not reopen a call');f.unmount();
});

function callFixture({product='dev',selectedAgentId='agent',agents=[agent()],lockAgent=true,startOnOpen=false}={}){
 const sent=[],spoken=[],events=[],timers=new Map();let id=0,closed=0,observer,stream,playback={status:'idle'},onInactive,queued;
 const dictation={status:'ready',start(){events.push('capture');dictation.status='listening';},abandon(){events.push('abandon');dictation.status='ready';},stop(){dictation.status='stopped';}};
 const detail={conversation:{id:'chat',projectId:'project',...(product==='branches'?{branchId:'branch'}:{})},agents,messages:[]};
 const queryClient={invalidateQueries:async()=>{}};
 const api={getConversation:async()=>detail,getVoiceReplyStatus:async()=>({messageId:'input',runId:'run',runStatus:'running',memoryExposure:{state:'disabled',runId:'run'}}),sendMultiAgentDirectMessage:async(chat,request)=>{sent.push({chat,request});return {messageId:'input',message:{id:'input',communicationEventId:'input',conversationId:chat,role:'user',text:request.text,createdAt:new Date().toISOString()},recipients:[{queued:true}]};},subscribeAgent(_id,_cursor,handlers){stream=handlers;return{close(){events.push('stream-closed');}};},cancelRun:async()=>events.push('cancel-run')};
 class QueryObserver{constructor(_client,options){this.options=options;}subscribe(fn){observer=fn;return()=>events.push('observer-unsubscribed');}destroy(){events.push('observer-destroyed');}}
 const speech={subscribeSpeech:()=>()=>{},speechSnapshot:()=>playback,stopSpeech(){events.push('stop-speech');playback={status:'stopped'};return true;},startSpeech(){},startSpeechQueue(owner,_prefs,_surface,complete,started,before){playback={ownerId:owner,status:'loading'};queued={append(text){spoken.push(text);return true;},finish(){events.push('queue-finished');},stop(){events.push('queue-stopped');},complete,started,before};return queued;}};
 const attempt={VOICE_ATTEMPT_TTL:86400000,restoreVoiceCallAttempt:async()=>({}),retainVoiceCallAttempt:()=>true,settleVoiceCallAttempt:()=>events.push('settled'),voiceCallAttemptCanRetry:async()=>true,prepareVoiceCallAttempt:async(route,text)=>({marker:{route},request:{text,recipients:[{agentId:route.agentId}],voiceReply:true,idempotencyKey:'exact-turn',activeRunDelivery:'steer'}})};
 const f=fixture('VoiceConversation',{'../chat/composerUtils':{assistantSubmissionError},'../../clientId':{createClientId:()=> 'operation'},'@ponderosa/core':{DEFAULT_SPEECH_PREFERENCES:{speed:1}},'@tanstack/react-query':{QueryObserver,useQueryClient:()=>queryClient},'../../api':{api},'../../api/productScope':{productApiPath:path=>product==='branches'?'/api/branches/engine/'+path.slice(5):path,currentProductScope:()=>product},'../../hooks/queries':{useWorkspacePreferences:()=>({})},'../../queryKeys':{queryKeys:{conversations:{detail:()=>['conversation'],detailPrefix:()=>['conversation']}}},'../../conversationMessageReceipt':{publishConversationMessageReceipt:async()=>{}},'./browserSpeech':{dictationUnavailableReason:()=>undefined,speechSynthesisUnavailableReason:()=>undefined},'./speechCoordinator':speech,'./speechSurfaceAccessibility':{monitorSpeechSurfaceAccessibility(_surface,fn){onInactive=fn;return()=>{};}},'./speechText':{speakableMessageText},'./useDictation':{useDictation:()=>dictation},'./voiceReplyStream':{VoicePhraseBuffer,VoiceReplyBuffers,voiceTimingText},'./voiceReply':{voiceReplyInWindow},'./voiceCallAttempt':attempt},{document:{visibilityState:'visible'},window:Object.assign(new EventTarget(),{location:{origin:'https://test.invalid'}}),setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:key=>timers.delete(key),setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)});
 const outer=f.exports.VoiceConversation({...context,agents,selectedAgentId,lockAgent,startOnOpen,open:true,onClose:()=>closed++});const session=React.Children.toArray(outer.props.children)[0];
 f.mount(session.type,session.props);f.find(n=>n.type==='DialogContent').ref({isConnected:true,contains:()=>false});f.render();
 const findButton=name=>f.find(n=>n.type==='Button'&&(n.props.children===name||n.props['aria-label']===name));
 const sendTurn=async()=>{await f.flush();findButton('Transcript').props.onClick();f.render();f.find(n=>n.type==='TextField'&&n.props.label==='Type A Message').props.onChange({target:{value:'A private voice turn'}});f.render();findButton('Send').props.onClick();await f.flush();await f.flush();};
 const canonical=text=>{detail.messages=[{id:'input',conversationId:'chat',role:'user',text:'A private voice turn',deliveryReceipts:[{targetAgentId:'agent',state:'processed',executionId:'run'}]},{id:'answer',conversationId:'chat',role:'assistant',communicationIntent:'user_dm',authorAgentId:'agent',executionId:'run',text,createdAt:new Date().toISOString()}];observer({isSuccess:true,isFetching:false,isFetchedAfterMount:true,data:detail});f.render();};
 return{...f,dictation,events,sent,spoken,detail,sendTurn,canonical,findButton,timers,closed:()=>closed,inactive:()=>onInactive(),stream:()=>stream,queued:()=>queued};
}
for(const product of ['dev','branches'])test(`${product}: opening a call does not capture/send; explicit Start, mute, End and unmount fence local audio`,async()=>{
 const f=callFixture({product});await f.flush();assert.deepEqual(f.sent,[]);assert.equal(f.events.includes('capture'),false);assert.equal(f.findButton('Start Call').props.disabled,false);
 f.findButton('Start Call').props.onClick();f.render();assert.equal(f.events.filter(e=>e==='capture').length,1);
 f.find(n=>n.type==='Button'&&Array.isArray(n.props.children)===false&&n.props['aria-pressed']===false).props.onClick();f.render();assert.equal(f.dictation.status,'ready');assert.equal(f.sent.length,0);f.findButton('End Call').props.onClick();assert.equal(f.closed(),1);f.unmount();assert.equal(f.timers.size,0);assert.equal(f.events.includes('cancel-run'),false);
});
test('Chat chooser uses canonical members; fixed Agent owner has no chooser',async()=>{
 const f=callFixture({agents:[agent(),agent('second')],selectedAgentId:'',lockAgent:false});await f.flush();assert.equal(f.findButton('Start Call').props.disabled,true);const picker=f.find(n=>n.type==='TextField'&&n.props.label==='Call Agent');picker.props.onChange({target:{value:'second'}});f.render();await f.flush();assert.equal(f.findButton('Start Call').props.disabled,false);f.unmount();
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
 const f=menuFixture();f.dictation.status='listening';f.render();const controller=f.handlers()[2];f.update({voiceContext:{...context,selectedAgentId:'second',agents:[agent(),agent('second')]}});assert.equal(f.handlers()[2]===controller,true);assert.deepEqual(f.calls,[]);f.dictation.status='stopped';f.render();f.open();f.item('Voice Call').props.onClick();f.render();assert.equal(f.all().some(n=>n.type===f.VoiceConversation),true);f.update({voiceContext:context});assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.update({voiceContext:{...context,selectedAgentId:'second',agents:[agent(),agent('second')]}});assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.unmount();
});

test('recognition permission failure pauses the call; a foreign canonical Chat never enables capture',async()=>{
 const f=callFixture();await f.flush();f.findButton('Start Call').props.onClick();f.render();f.dictation.status='error';f.dictation.error='Microphone permission was denied.';f.render();
 const text=node=>Array.isArray(node)?node.map(text).join(''):React.isValidElement(node)?text(node.props.children):typeof node==='string'?node:'';
 const warning=f.find(n=>n.type==='Alert'&&n.props.severity==='warning');
 assert.match(text(warning),/Microphone access denied\. Allow access in browser settings, then reconnect\./);
 assert.match(text(warning),/Some speech may be missing\. Review Transcript before sending\./);
 const details=f.all(warning).find(n=>n.type==='Box'&&n.props.component==='details');assert.ok(details,'Original permission failure remains available in Details');
 assert.equal(f.all(details).find(n=>n.type==='Typography').props.children,f.dictation.error);
 assert.equal(text(f.find(n=>n.props.role==='status')),'Call interrupted');assert.equal(f.findButton('Reconnect Call').props.disabled,false);
 assert.equal(f.events.includes('stop-speech'),true,'Permission failure stops automatic local playback');
 assert.equal(f.sent.length,0);f.unmount();
 const foreign=callFixture();foreign.detail.conversation.id='foreign';await foreign.flush();assert.equal(foreign.findButton('Reconnect Call').props.disabled,false);assert.equal(foreign.events.includes('capture'),false);assert.equal(foreign.sent.length,0);foreign.unmount();
});

test('exiting menu items cannot start dictation or open a call after Escape/close',()=>{
 const f=menuFixture();f.open();f.find(n=>n.type==='Menu').props.onClose();f.render();assert.equal(f.item('Dictation').props.disabled,true);assert.equal(f.item('Voice Call').props.disabled,true);f.item('Dictation').props.onClick();f.item('Voice Call').props.onClick();f.render();assert.deepEqual(f.calls,[]);assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);f.unmount();
});

const capture=await import('../../apps/web/src/components/speech/captureCoordinator.ts');
function audioFixture({allowSpeechStop=true,playError}={}){
 const native={paused:true,currentTime:0,duration:NaN,volume:1,muted:false,playbackRate:1,error:null,plays:0,pauses:0,loads:0,
  play(){this.plays++;if(playError)return Promise.reject(new Error(playError));this.paused=false;return Promise.resolve();},
  pause(){this.pauses++;this.paused=true;},load(){this.loads++;}};
 const f=fixture('AudioMessagePlayer',{'./captureCoordinator':capture,'./speechCoordinator':{stopSpeech:()=>allowSpeechStop}},{audioElement:native});
 f.mount(f.exports.AudioMessagePlayer,{src:'/owned/playback?owner=one',downloadUrl:'/owned/download?owner=one',label:'Owned voice message'});
 const media=()=>f.find(n=>n.type==='audio');
 const button=name=>f.find(n=>n.type==='IconButton'&&n.props['aria-label']===name);
 const elapsed=()=>f.find(n=>n.type==='Typography'&&n.props['aria-label']?.startsWith('Elapsed '));
 const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
 return{...f,native,media,button,elapsed,text};
}
test('audio player honestly shows unknown duration without loading the file; native metadata enables seek',()=>{
 const f=audioFixture();assert.equal(f.media().props.hidden,true);assert.equal(f.media().props.preload,'none');assert.equal(f.native.loads,0);assert.equal(f.native.plays,0);
 assert.equal(f.text(f.elapsed()),'0:00 / —:—');assert.match(f.elapsed().props['aria-label'],/Duration Not Yet Available/);
 assert.equal(f.find(n=>n.type==='Slider'&&n.props['aria-label']==='Audio Position').props.disabled,true);
 f.native.duration=125;f.native.currentTime=5;f.media().props.onLoadedMetadata({currentTarget:f.native});f.render();assert.equal(f.text(f.elapsed()),'0:05 / 2:05');
 const seek=f.find(n=>n.type==='Slider'&&n.props['aria-label']==='Audio Position');assert.equal(seek.props.disabled,false);assert.equal(seek.props.max,125);assert.equal(seek.props['aria-valuetext'],'0:05 of 2:05');seek.props.onChange({},61);f.render();assert.equal(f.native.currentTime,61);assert.equal(f.text(f.elapsed()),'1:01 / 2:05');f.unmount();
});
test('audio player uses the real page capture lease and late old pause cannot release a new owner',()=>{
 let priorStopped=0,nextStopped=0;capture.claimPageCapture(()=>priorStopped++);
 const f=audioFixture();f.button('Play Audio').props.onClick();f.media().props.onPlay({currentTarget:f.native});f.media().props.onPlaying();f.render();assert.equal(priorStopped,1);assert.equal(f.native.plays,1);assert.equal(f.button('Pause Audio').props.sx.width,44);assert.equal(f.button('Pause Audio').props.sx.height,44);
 capture.claimPageCapture(()=>nextStopped++);assert.equal(f.native.pauses,1);f.media().props.onPause();f.render();capture.abandonPageCapture();assert.equal(nextStopped,1,'old audio pause must not release the newer capture lease');
 f.native.duration=NaN;f.native.currentTime=2.25;f.media().props.onEnded({currentTarget:f.native});f.render();assert.equal(f.text(f.elapsed()),'0:02 / 0:02','a genuinely observed file end can establish its duration');f.unmount();
});
test('audio playback options retain volume, mute, speed and exact owned download URL',()=>{
 const f=audioFixture();const trigger={id:'owned-playback-options'};f.button('Playback Options').props.onClick({currentTarget:trigger});f.render();
 const popover=f.find(n=>n.type==='Popover');assert.equal(popover.props.open,true);assert.equal(popover.props.PaperProps.role,'dialog');assert.equal(f.button('Playback Options').props['aria-controls'],popover.props.PaperProps.id);
 const volume=f.find(n=>n.type==='Slider'&&n.props['aria-label']==='Audio Volume');volume.props.onChange({},0.35);f.render();assert.equal(f.native.volume,0.35);assert.equal(f.native.muted,false);
 f.button('Mute Audio').props.onClick();f.render();assert.equal(f.native.muted,true);f.button('Unmute Audio').props.onClick();f.render();assert.equal(f.native.muted,false);
 const speed=f.find(n=>n.type==='Button'&&n.props['aria-pressed']!==undefined&&n.props.children[0]===1.5);speed.props.onClick();f.render();assert.equal(f.native.playbackRate,1.5);assert.equal(f.find(n=>n.type==='Button'&&n.props['aria-pressed']===true).props.children[0],1.5);
 const download=f.find(n=>n.type==='Button'&&n.props.children==='Download Audio');assert.equal(download.props.href,'/owned/download?owner=one');assert.equal(download.props.download,true);download.props.onClick();f.render();assert.equal(f.find(n=>n.type==='Popover').props.open,false);f.unmount();
});
test('audio playback errors keep actual causes and Retry resets metadata without autoplay',async()=>{
 const f=audioFixture({playError:'Browser playback permission denied'});f.button('Play Audio').props.onClick();await f.flush();assert.match(f.find(n=>n.type==='Alert').props.children,/Browser playback permission denied/);
 const firstKey=f.media().key;f.find(n=>n.type==='Alert').props.action.props.onClick();f.render();assert.notEqual(f.media().key,firstKey);assert.equal(f.all().some(n=>n.type==='Alert'),false);assert.equal(f.native.plays,1,'Retry must not automatically play');assert.equal(f.text(f.elapsed()),'0:00 / —:—');
 f.native.error={message:'Native decoder rejected the stream',code:3};f.media().props.onError();f.render();assert.match(f.find(n=>n.type==='Alert').props.children,/Native decoder rejected the stream/);f.unmount();
});
test('audio player cannot steal capture when browser speech refuses to stop; source cleanup pauses native audio',()=>{
 let stopped=0;capture.claimPageCapture(()=>stopped++);const f=audioFixture({allowSpeechStop:false});f.native.paused=false;f.media().props.onPlay({currentTarget:f.native});f.render();assert.equal(f.native.paused,true);assert.match(f.find(n=>n.type==='Alert').props.children,/Browser speech could not be stopped/);capture.abandonPageCapture();assert.equal(stopped,1,'vetoed playback must leave the existing lease intact');
 const before=f.native.pauses;f.update({src:'/owned/second'});assert(f.native.pauses>before);f.unmount();
});

test('audio attachment header keeps the exact filename and protected download URL without a separate download row',()=>{
 function Player(){}
 const f=fixture('../chat/ChatAttachments',{'../speech/AudioMessagePlayer':{AudioMessagePlayer:Player},'../filePreview/FilePreview':{FilePreview:()=>null},'../filePreview/mimeCapabilities':{previewCapability:()=>({kind:'audio'})},'../filePreview/readTextPreview':{readTextPreview:()=>{throw Error('Audio header must not fetch a text preview');}}});
 const name='#Original voice λ; keep full metadata.webm',url='/owned/audio?owner=one&download=1#original';
 f.mount(f.exports.ChatAttachments,{attachments:[{id:'audio',name,mediaType:'audio/webm',downloadUrl:url}]});
 const player=f.find(n=>n.type===Player);assert.equal(player.props.downloadUrl,url);assert.equal(player.props.src,'/owned/audio?owner=one&download=1&playback=audio#original');
 const title=f.find(n=>n.type==='Typography'&&n.props.title===name);assert.equal(title.props.children,name);assert.equal(title.props.noWrap,true);
 assert.equal(f.all().some(n=>n.type==='Button'&&n.props.children==='Download Audio'),false,'download remains one compact player option');
 const local='blob:http://localhost/exact-local-audio';f.update({attachments:[{id:'local',name,mediaType:'audio/webm',downloadUrl:local}]});assert.equal(f.find(n=>n.type===Player).props.src,local,'UI012 captured local audio keeps its exact playable object URL');f.unmount();
});


function recorderFixture({unavailable=false,attachmentError,recordedBytes='actual-controlled-recorded-bytes'}={}){
 const attached=[],events=[],streams=[];let recorder,handlers;const getUserMedia=async()=>{const track={readyState:'live',stop(){this.readyState='ended';events.push('track-stop');}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};streams.push(stream);return stream;};
 const recognition={status:'ready',unavailableReason:unavailable?'Voice dictation is not supported by this browser.':undefined,start(){events.push('recognize');if(!unavailable){this.status='listening';handlers[1](true);}},stop(){events.push('recognition-stop');if(!unavailable)this.status='stopping';},abandon(){events.push('recognition-abandon');handlers?.[1](false);this.status='stopped';}};
 class Recorder{static isTypeSupported=()=>true;state='inactive';mimeType='audio/webm';constructor(){recorder=this;}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([recordedBytes],{type:'audio/webm'})});this.onstop?.();});}}
 const f=fixture('VoiceMessageRecorder',{'./AudioMessagePlayer':{AudioMessagePlayer:()=>null},'./useDictation':{useDictation:(...args)=>{handlers=args;return recognition;}},'./captureCoordinator':capture,'./speechCoordinator':{stopSpeech:()=>true},'./speechSurfaceAccessibility':{monitorSpeechSurfaceAccessibility:()=>()=>{}},'../../reloadSafety':{useUnsavedForm:()=>{}},'./voiceRecording':{recordingExtension:()=> 'webm',recordingMimeType:()=> 'audio/webm'}},{File,Blob,MediaRecorder:Recorder,queueMicrotask,navigator:{mediaDevices:{getUserMedia}},document:{activeElement:{}},URL:{createObjectURL:()=> 'blob:recording',revokeObjectURL(){}}});
 let closed=0;f.mount(f.exports.VoiceMessageRecorder,{maxBytes:1000,onAttach:(file,transcript)=>{attached.push({file,transcript});return attachmentError;},onClose(){closed++;}});
 const finish=()=>{f.find(n=>n.type==='Button'&&n.props.children==='Finish Recording').props.onClick();f.render();};
 return{...f,events,attached,recognition,streams,closed:()=>closed,finish,emit(words){handlers[0](words);f.render();},settle(){recognition.status='stopped';handlers[1](false);f.render();},fail(message){recognition.error=message;handlers[1](false);f.render();},recorder:()=>recorder};
}
test('recorded voice waits for final speech then stages the real audio with editable transcript, without a Send',async()=>{
 const f=recorderFixture();await f.flush();assert.equal(f.events.includes('recognize'),true);f.finish();await f.flush();assert.equal(f.attached.length,0,'recording completion alone is not speech understanding');assert.equal(f.events.includes('track-stop'),false,'keep the admitted input through native finalization');
 f.emit('Use the silver notebook');assert.equal(f.attached.length,0,'wait for recognition end, not an interim settlement assumption');f.settle();assert.equal(f.attached.length,1);assert.equal(f.attached[0].transcript,'Use the silver notebook');assert.equal(await f.attached[0].file.text(),'actual-controlled-recorded-bytes');assert.equal(f.closed(),1);assert.equal(f.events.includes('track-stop'),true);f.unmount();
});
for(const mode of ['unavailable','failed','empty'])test(`recorded voice ${mode} transcription retains audio for explicit review and text fallback`,async()=>{
 const f=recorderFixture({unavailable:mode==='unavailable'});await f.flush();f.finish();await f.flush();if(mode==='failed')f.fail('The browser speech service could not connect.');else if(mode==='empty')f.settle();
 assert.equal(f.attached.length,0);assert.equal(f.closed(),0);assert.equal(f.all().some(n=>n.type==='Alert'),true,'failure/no-speech must be visible');const use=f.find(n=>n.type==='Button'&&n.props.children==='Use Recording');assert.equal(Boolean(use.props.disabled),false);use.props.onClick();assert.equal(f.attached.length,1);assert.equal(f.attached[0].transcript,undefined);f.unmount();
});
test('recorded transcript staging refusal preserves the words and original audio for retry',async()=>{
 const f=recorderFixture({attachmentError:'Draft is busy'});await f.flush();f.emit('Keep these exact words');f.finish();await f.flush();f.settle();assert.equal(f.closed(),0);assert.equal(f.attached.length,1);assert.equal(f.attached[0].transcript,'Keep these exact words');assert(f.all().some(n=>n.type==='Alert'&&n.props.children==='Draft is busy'));f.unmount();
});
test('toolbar inserts a recorded transcript only after the same owned attachment is admitted',()=>{
 let reject=true;const files=[],f=menuFixture({onVoiceAttachment:file=>{files.push(file);return reject?'Draft busy':undefined;}});f.find(n=>n.props['aria-label']==='Record Voice Message').props.onClick();f.render();const recorder=f.find(n=>n.type===f.VoiceMessageRecorder);
 assert.equal(recorder.props.onAttach('recording','Spoken instruction'),'Draft busy');assert.deepEqual(f.calls,[]);reject=false;assert.equal(recorder.props.onAttach('recording','Spoken instruction'),undefined);assert.deepEqual(f.calls,[['words','Spoken instruction']]);f.unmount();
});

test('recognition ending before recording does not silently stage an incomplete transcript',async()=>{
 const f=recorderFixture();await f.flush();f.emit('Only the beginning');f.settle();assert(f.all().some(n=>n.type==='Alert'&&String(n.props.children).includes('Transcription stopped before recording finished')));f.finish();await f.flush();f.settle();assert.equal(f.attached.length,0,'partial recognition requires explicit review');f.unmount();
});

test('empty recording abandons recognition and releases the admitted track instead of waiting forever',async()=>{
 const f=recorderFixture({recordedBytes:''});await f.flush();f.finish();await f.flush();assert.equal(f.attached.length,0);assert.equal(f.events.includes('track-stop'),true);assert(f.all().some(n=>n.type==='Alert'&&String(n.props.children).includes('No audio was captured')));f.unmount();
});
test('discard abandons pending recognition and never stages its retained audio',async()=>{
 const f=recorderFixture();await f.flush();f.find(n=>n.type==='Button'&&n.props.children==='Discard').props.onClick();assert.equal(f.closed(),1);f.unmount();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.attached.length,0);assert.equal(f.events.includes('track-stop'),true);
});

test('re-record during finalization cannot replace the admitted stream or leave an old capture live',async()=>{
 const f=recorderFixture();await f.flush();f.finish();await f.flush();const again=f.find(n=>n.type==='Button'&&n.props.children==='Record Again');assert.equal(again.props.disabled,true,'wait for final recognition before replacing recording');again.props.onClick();await f.flush();assert.equal(f.streams.length,1,'the callback itself must fence disabled re-record');assert.equal(f.streams[0].getAudioTracks()[0].readyState,'live');f.settle();assert.equal(f.streams[0].getAudioTracks()[0].readyState,'ended');f.unmount();
});
test('explicit re-record retires the prior capture before admitting a fresh live stream',async()=>{
 const f=recorderFixture({unavailable:true});await f.flush();f.finish();await f.flush();assert.equal(f.streams[0].getAudioTracks()[0].readyState,'ended');f.find(n=>n.type==='Button'&&n.props.children==='Record Again').props.onClick();await f.flush();assert.equal(f.streams.length,2);assert.equal(f.streams[1].getAudioTracks()[0].readyState,'live','old lease release must not stop the replacement');f.unmount();assert.equal(f.streams[1].getAudioTracks()[0].readyState,'ended');
});


test('explicit handset opening starts eligible capture once; ordinary mounts and missing owner do not',async()=>{
 const f=callFixture({startOnOpen:true});await f.flush();f.render();await f.flush();
 assert.equal(f.events.filter(e=>e==='capture').length,1);
 for(let i=0;i<3;i++)f.render();assert.equal(f.events.filter(e=>e==='capture').length,1);
 f.inactive();f.render();await f.flush();assert.equal(f.events.filter(e=>e==='capture').length,1,'foreground interruption requires a deliberate reconnect');f.unmount();
 const invalid=callFixture({startOnOpen:true,agents:[agent(),agent('second')],selectedAgentId:'',lockAgent:false});await invalid.flush();assert.equal(invalid.events.includes('capture'),false);invalid.unmount();
});


test('contact header reuses the guarded call action, hides its menu duplicate, and restores only its invoker',()=>{
 const host={nodeType:1},f=menuFixture({},host);
 assert.equal(f.portals.includes(host),true);
 let focuses=0;const handset={isConnected:true,focus(){focuses++;f.doc.activeElement=handset;}};
 const button=f.find(n=>n.type==='IconButton'&&n.props['aria-label']==='Call');
 assert.equal(button.props.sx.width,44);assert.equal(button.props.disabled,false);
 f.open();assert.equal(f.all().some(n=>n.type==='MenuItem'&&f.all(n).some(child=>child.props.primary==='Voice Call')),false);
 button.props.onClick({currentTarget:handset});f.render();const call=f.find(n=>n.type===f.VoiceConversation);
 assert.equal(call.props.startOnOpen,true);assert.equal(call.props.selectedAgentId,'agent');
 f.doc.activeElement={isConnected:true,closest:()=>({})};call.props.onClose();f.doc.activeElement=f.doc.body;f.render();assert.equal(focuses,1,'End returns focus to the real header handset');
 f.find(n=>n.type==='IconButton'&&n.props['aria-label']==='Call').props.onClick({currentTarget:handset});f.render();
 const newer={isConnected:true};f.doc.activeElement=newer;f.find(n=>n.type===f.VoiceConversation).props.onClose();f.render();assert.equal(focuses,1,'closing must not steal focus from a newer interaction');assert.equal(f.doc.activeElement,newer);
 f.readOnly(true);assert.equal(f.find(n=>n.type==='IconButton'&&n.props['aria-label']==='Call').props.disabled,true);f.unmount();
});
test('header handset cannot open while native capture or recording is active, or from a foreign owner',()=>{
 const f=menuFixture({onVoiceAttachment:()=>undefined},{nodeType:1});const open=()=>f.find(n=>n.type==='IconButton'&&n.props['aria-label']==='Call');
 f.dictation.status='starting';f.render();assert.equal(open().props.disabled,true);open().props.onClick({currentTarget:{}});f.render();assert.equal(f.all().some(n=>n.type===f.VoiceConversation),false);
 f.dictation.status='ready';f.render();f.find(n=>n.props['aria-label']==='Record Voice Message').props.onClick();f.render();assert.equal(open().props.disabled,true);
 f.find(n=>n.type===f.VoiceMessageRecorder).props.onClose();f.render();f.update({voiceContext:{...context,selectedAgentId:'foreign'}});assert.equal(open().props.disabled,true);f.unmount();
});
