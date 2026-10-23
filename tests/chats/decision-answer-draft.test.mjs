import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as core from '@ponderosa/core';
import * as utils from '../../apps/web/src/components/chat/composerUtils.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const ts = require('typescript');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

// Execute both real hooks with controlled transport, effects and debounce time.
// No second draft/upload implementation: assertions observe the production hooks.
function fixture(overrides = {}) {
  let index=0, dirty=true, current, live=true;
  const slots=[], effects=[], timers=new Map(), calls={get:[],put:[],upload:[],remove:[]};
  const decision={id:'decision-a',agentId:'agent-a'}, scope='agent:agent-a';
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
