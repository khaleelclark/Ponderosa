import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
import * as core from '@ponderosa/core';
const { decisionChoice } = await import('../../apps/web/src/components/ConversationView.helpers.ts');
import { decisionResponseChoice, decisionResponseVerb } from '../../apps/web/src/components/decisions/decisionResponse.ts';
import * as utils from '../../apps/web/src/components/chat/composerUtils.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

// Execute both real hooks with controlled transport, effects and debounce time.
// No second draft/upload implementation: assertions observe the production hooks.
function fixture(overrides = {}, fields = {}) {
  let index=0, dirty=true, current, live=true;
  const slots=[], effects=[], timers=new Map(), calls={get:[],put:[],upload:[],remove:[]};
  const decision={id:'decision-a',agentId:'agent-a',...fields}, scope='agent:agent-a';
  let canonical={conversationId:scope,ownerId:decision.id,revision:0,text:'',attachmentIds:[],attachments:[]};
  const react={
    useState(initial) { const i=index++; if(!slots[i]) { const slot={value:typeof initial==='function'?initial():initial};slot.set=value=>{slot.value=typeof value==='function'?value(slot.value):value;dirty=true;};slots[i]=slot;}return [slots[i].value,slots[i].set]; },
    useRef(initial) {return react.useState(()=>({current:initial}))[0];},
    useReducer(reducer,initial) { const [value,set]=react.useState(initial);const ref=react.useRef();ref.current??=action=>set(old=>reducer(old,action));return [value,ref.current]; },
    useCallback(fn,deps) {const ref=react.useRef();if(!ref.current||deps.some((v,i)=>v!==ref.current.deps[i]))ref.current={fn,deps};return ref.current.fn;},
    useEffect(fn,deps) {const i=index++,old=slots[i];if(!old||deps.some((v,i)=>v!==old.deps[i])) {slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const metadata=(id,file)=>({id,ownerId:decision.id,conversationId:scope,name:file.name,mediaType:file.type,size:file.size});
  const api={
    getAssetLimits:async()=>core.DEFAULT_ASSET_LIMITS,
    getConversationDraft:async(...args)=>{calls.get.push(args);return structuredClone(canonical);},
    putConversationDraft:async(...args)=>{calls.put.push(args);canonical={...canonical,...args[1],revision:canonical.revision+1};return structuredClone(canonical);},
    uploadDraftAttachment:async(...args)=>{calls.upload.push(args);return metadata('upload-'+calls.upload.length,args[2]);},
    deleteDraftAttachment:async(...args)=>{calls.remove.push(args);},
    downloadDraftAttachment:async file=>new File(['restored bytes'],file.name,{type:file.mediaType}),
    ...overrides,
  };
  function load(relative,imports) {const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/'+relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Error,crypto,AbortSignal,window:{queueMicrotask},setTimeout:fn=>{const key={};timers.set(key,fn);return key;},clearTimeout:key=>timers.delete(key),require:name=>imports[name]??require(name)});return exports;}
  const common={react,'../../api':{api},'@ponderosa/core':core};
  const uploader=load('components/chat/useComposerDraftAttachments.ts',{...common,'./composerUtils':utils});
  const {useDecisionAnswerDraft}=load('components/decisions/useDecisionAnswerDraft.ts',{...common,'@tanstack/react-query':{useQuery:()=>({data:core.DEFAULT_ASSET_LIMITS})},'../../queryKeys':{queryKeys:{assetLimits:{all:[]}}},'../chat/composerUtils':utils,'../chat/useComposerDraftAttachments':uploader});
  const render=()=>{if(!live)return;index=0;dirty=false;current=useDecisionAnswerDraft(decision,true);while(effects.length)effects.shift()();};
  const flush=async()=>{for(let i=0;i<15;i++){if(dirty)render();await Promise.resolve();}return current;};
  return {calls,api,metadata,scope,decision,get value(){return current;},setCanonical(value){canonical={...canonical,...value};},async start(){render();return flush();},flush,async debounce(){await flush();const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());return flush();},unmount(){live=false;slots.forEach(slot=>slot?.cleanup?.());timers.clear();}};
}

test('Decision draft loads only its stable owner and restores original attachment IDs/order',async()=>{
  const f=fixture();f.setCanonical({revision:7,text:'Saved answer',attachmentIds:['two','one'],attachments:[f.metadata('two',new File(['2'],'two.txt',{type:'text/plain'})),f.metadata('one',new File(['1'],'one.txt',{type:'text/plain'}))]});
  await f.start();assert.equal(f.value.ready,true);assert.equal(f.value.text,'Saved answer');assert.deepEqual([...f.value.attachmentIds],['two','one']);assert.equal(f.value.uploadsComplete,true);assert.equal(f.calls.get.length,1);assert.deepEqual(f.calls.get[0].slice(0,2),[f.scope,f.decision.id]);await f.debounce();assert.equal(f.calls.put.length,0);f.unmount();
});
test('Decision answer waits for all uploads; repeated File identity is queued once and late removal cannot reappear',async()=>{
  const pending=deferred(),f=fixture({uploadDraftAttachment:async(...args)=>{f.calls.upload.push(args);return pending.promise;}});await f.start();
  const file=new File(['evidence'],'one.txt',{type:'text/plain'});f.value.uploads.addFiles([file,file]);await f.flush();assert.equal(f.calls.upload.length,1);assert.equal(f.value.uploadsComplete,false);assert.equal(f.value.attachments.files.length,1);
  f.value.uploads.removeFile(0);await f.flush();pending.resolve(f.metadata('late',file));await f.flush();assert.equal(f.value.attachments.files.length,0);assert.deepEqual([...f.value.attachmentIds],[]);assert.deepEqual(f.calls.remove,[[f.scope,f.decision.id,'late']]);f.unmount();
});
test('an upload completing after unmount cleans its original Decision owner only',async()=>{
  const pending=deferred(),f=fixture({uploadDraftAttachment:async()=>pending.promise});await f.start();const file=new File(['bytes'],'late.txt',{type:'text/plain'});f.value.uploads.addFiles([file]);await f.flush();f.unmount();pending.resolve(f.metadata('orphan',file));await f.flush();assert.deepEqual(f.calls.remove,[[f.scope,f.decision.id,'orphan']]);
});
test('lost successful draft write is confirmed once without replacing newer local typing',async()=>{
  const pending=deferred(),f=fixture({putConversationDraft:async(...args)=>{f.calls.put.push(args);f.setCanonical({...args[1],revision:1});return pending.promise;}});await f.start();f.value.setText('First');await f.debounce();f.value.setText('Newer');await f.flush();pending.reject(Error('response lost'));await f.flush();assert.equal(f.value.text,'Newer');assert.equal(f.value.saveError,undefined);assert.equal(f.calls.get.length,2);
  f.api.putConversationDraft=async(...args)=>{f.calls.put.push(args);return {revision:2};};await f.debounce();assert.equal(f.calls.put[1][1].text,'Newer');assert.equal(f.calls.put[1][1].expectedRevision,1);f.unmount();
});
test('a different-window conflict retains local text and IDs without guessing a newer CAS revision',async()=>{
  const f=fixture({putConversationDraft:async(...args)=>{f.calls.put.push(args);f.setCanonical({revision:9,text:'Other window'});throw Error('conflict');}});await f.start();f.value.setText('Local');await f.debounce();assert.equal(f.value.text,'Local');assert.match(f.value.saveError,/could not be confirmed/);f.value.retry();await f.debounce();assert.equal(f.calls.put.length,2);assert.ok(f.calls.put.every(call=>call[1].expectedRevision===0));f.unmount();
});
test('failed load and mismatched attachment ownership block editing rather than silently losing evidence',async()=>{
  const f=fixture({getConversationDraft:async()=>{throw Error('offline');}});await f.start();assert.equal(f.value.ready,false);assert.equal(f.value.loadError,'offline');f.unmount();
  const bad=fixture();bad.setCanonical({attachmentIds:['foreign'],attachments:[{id:'foreign',ownerId:'another-decision'}]});await bad.start();assert.equal(bad.value.ready,false);assert.match(bad.value.loadError,/could not be verified/);assert.equal(bad.calls.put.length,0);bad.unmount();
});

test('Chat and All Messages retain attachment-only answers through their shared timeline choice',()=>{
  const decision={mode:'text',options:[],response:{attachments:[{id:'evidence'}]}};
  assert.equal(decisionChoice(decision),'Attached evidence');assert.equal(decisionResponseChoice(decision),'Attached evidence');assert.equal(decisionResponseVerb(decision),'Answered');
  assert.equal(decisionChoice({...decision,response:{text:'Full answer',attachments:[{id:'evidence'}]}}),'Full answer');
});

const questions=[{id:'one',question:'First full question',mode:'text',options:[],allowOther:true},{id:'two',question:'Second full question',mode:'choice',options:[{id:'north',label:'North'}],allowOther:true},{id:'three',question:'Third full question',mode:'text',options:[],allowOther:true}];
test('UI019 uploads stay with their original question across navigation and late completion',async()=>{
 const first=deferred(),second=deferred();let n=0;
 const f=fixture({uploadDraftAttachment:async()=>++n===1?first.promise:second.promise},{questions});await f.start();
 f.value.setAnswer({questionId:'one',status:'answered',text:'First answer'});f.value.addFiles([new File(['a'],'one.txt',{type:'text/plain'})],'one');await f.flush();
 f.value.setAnswer({questionId:'two',status:'answered',optionId:'north'});f.value.addFiles([new File(['b'],'two.txt',{type:'text/plain'})],'two');await f.flush();
 first.resolve(f.metadata('first-id',new File(['a'],'one.txt',{type:'text/plain'})));await f.flush();second.resolve(f.metadata('second-id',new File(['b'],'two.txt',{type:'text/plain'})));await f.flush();
 f.value.setAnswer({questionId:'three',status:'skipped'});await f.debounce();
 const answers=f.calls.put.at(-1)[1].decisionAnswers;
 assert.equal(answers[0].text,'First answer');assert.deepEqual([...answers[0].attachmentIds],['first-id']);assert.deepEqual([...answers[1].attachmentIds],['second-id']);assert.equal(answers[1].optionId,undefined,'File evidence is an alternative answer, never an implicit choice');assert.equal(answers[2].status,'skipped');
 assert.deepEqual([...f.value.attachmentIds],['first-id','second-id']);f.unmount();
});
test('UI019 one in-progress answer set restores stable question/file IDs without borrowing the Chat draft',async()=>{
 const f=fixture({}, {questions});const answers=[{questionId:'one',status:'answered',text:'Retained one',attachmentIds:['file-a']},{questionId:'two',status:'answered',optionId:'north',attachmentIds:[]},{questionId:'three',status:'skipped'}];
 f.setCanonical({revision:9,decisionAnswers:answers,attachmentIds:['file-a'],attachments:[f.metadata('file-a',new File(['bytes'],'one.txt',{type:'text/plain'}))]});await f.start();
 assert.equal(f.value.ready,true);assert.deepEqual([...f.value.answers[0].attachmentIds],['file-a']);assert.equal(f.value.answers[1].optionId,'north');assert.equal(f.value.answers[2].status,'skipped');assert.equal(f.value.questionByFile.get(f.value.attachments.files[0]),'one');await f.debounce();assert.equal(f.calls.put.length,0);f.unmount();
});
test('UI019 complete answer validation rejects missing/duplicate/foreign IDs, mixed skips and reused files',()=>{
 const good=[{questionId:'one',status:'answered',text:'One'},{questionId:'two',status:'answered',optionId:'north'},{questionId:'three',status:'skipped'}];
 assert.equal(core.decisionAnswersError(questions,good),undefined);
 for(const value of [null,[],good.slice(0,2),[good[0],good[0],good[2]],[{...good[0],questionId:'foreign'},good[1],good[2]],[good[0],{...good[1],text:'Mixed'},good[2]],[good[0],good[1],{...good[2],text:'Not a skip'}],[{...good[0],text:''},good[1],good[2]],[{...good[0],attachmentIds:['file']},{questionId:'two',status:'answered',attachmentIds:['file']},good[2]],[{...good[0],attachmentIds:['file','file']},good[1],good[2]]])assert.ok(core.decisionAnswersError(questions,value));
 assert.equal(core.decisionAnswersError(questions,[{questionId:'one',status:'answered',text:''}],true),undefined,'Partial draft is not a submitted answer');
});

test('UI019 every Decision dialog owns clicks instead of navigating its notification parent',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),roots=[];
 const react={useId:()=> 'test-dialog',useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:initial=>({current:initial}),useEffect(){}};
 const mui=Object.fromEntries(['Alert','Box','Button','DialogActions','DialogContent','DialogTitle','Stack','TextField','Typography'].map(name=>[name,({children})=>React.createElement('div',null,children)]));
 mui.Dialog=props=>{roots.push(props);return React.createElement('section',null,props.children);};
 function load(name,imports){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/decisions/'+name,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:specifier=>imports[specifier]??require(specifier)});return exports;}
 const stubDraft={text:'Retained answer',setText(){},attachments:{files:[]},uploads:{uploadStates:new Map()},ready:true,limits:core.DEFAULT_ASSET_LIMITS,attachmentIds:[],uploadsComplete:true,questionByFile:new Map()};
 const common={react,'@mui/material':mui,'@ponderosa/core':core};
 const {DecisionResponseDialog}=load('DecisionResponseDialog.tsx',{...common,'@tanstack/react-query':{useQuery:()=>({})},'../../api':{api:{}},'../../queryKeys':{queryKeys:{decisions:{all:[]}}},'../../decisions':{validateDecisionResponse:()=>({text:'answer'})},'./DecisionQuestionContent':{DecisionQuestionContent:()=>null},'../chat/ComposerAttachment':{ComposerAttachment:()=>null},'../chat/composerUtils':utils,'../chat/folderAttachments':{},'./useDecisionAnswerDraft':{useDecisionAnswerDraft:()=>stubDraft},'../../conversationRouting':{fileSelectionFingerprint:()=>[]}});
 const base={id:'d',mode:'text',question:'Full question',options:[],status:'pending',allowOther:true};
 const check=element=>{roots.length=0;renderToStaticMarkup(element);assert.equal(roots.length,1);let stopped=false,navigated=0;roots[0].onClick?.({stopPropagation(){stopped=true;}});if(!stopped)navigated++;assert.equal(navigated,0,'A child dialog click must not reach the notification navigation action');};
 for(const decision of [base,{...base,question:undefined},{...base,status:'resolved'}])check(React.createElement(DecisionResponseDialog,{decision,open:true,onClose(){},onRespond(){}}));
 const {DecisionResponseMessage}=load('DecisionResponseMessage.tsx',{...common,'../chat/ChatMessageFrame':{ChatMessageFrame:({message})=>message.body},'../chat/ChatMessages':{AgentMention:()=>null},'../chat/ChatAttachments':{ChatAttachments:()=>null},'./DecisionQuestionContent':{DecisionQuestionContent:()=>null},'./decisionResponse':{decisionResponseChoice:()=> 'Answer',decisionResponseSummary:()=> 'Answered',decisionResponseVerb:()=> 'Answered'}});
 check(React.createElement(DecisionResponseMessage,{event:{id:'e',createdAt:'now',decision:{...base,response:{text:'Answer'}},recipientAgent:null}}));
});
