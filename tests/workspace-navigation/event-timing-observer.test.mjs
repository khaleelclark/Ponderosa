import {runInNewContext} from 'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import {summarizeTimings,latencyBreakdown,installTimingObserver} from './event-timing-observer.mjs';
let sequence=0;
// Synthetic observations exercise arithmetic and guards only; they do not establish browser delivery guarantees.
const session=(events,totalInteractions)=>{const documentId='document-'+(++sequence),n=totalInteractions??1;return {documentId,namespace:'test/'+documentId,window:{start:0,end:4000,lastFrame:4000,timeOrigin:1700000000000+sequence},lifecycle:[{type:'init',time:0,visibility:'visible'}],health:{registered:true,drained:true,callbacks:1,callbackLedger:[{observedAt:1515,droppedEntriesCount:0}],flushCompletedAt:4001,droppedEntries:0,delivery:{checkpoints:[{at:3901,frame:3900,events:events.length,lcp:2,interactions:totalInteractions??null,droppedEntries:0,lifecycle:1,inputs:n*2,eventCounts:{keydown:n,keyup:n}},{at:4001,frame:4000,events:events.length,lcp:2,interactions:totalInteractions??null,droppedEntries:0,lifecycle:1,inputs:n*2,eventCounts:{keydown:n,keyup:n}}],stable:true,postCapture:{stable:true,checkpoint:{at:4101,frame:4100,events:events.length,lcp:2,interactions:totalInteractions??null,droppedEntries:0,lifecycle:1,inputs:n*2,eventCounts:{keydown:n,keyup:n}}}}},tasks:[{id:'synthetic',start:1400,end:3900,complete:true,nativeStart:0,nativeEnd:totalInteractions,expectedTrustedCounts:{pointerdown:0,pointerup:0,click:0,keydown:n,keyup:n}}],eventCounts:{keydown:n,keyup:n},trustedInputs:Array.from({length:n},(_,i)=>[{type:'keydown',code:'KeyA',time:1500+i*.1},{type:'keyup',code:'KeyA',time:1500+i*.1+.05}]).flat(),events:events.map(e=>({name:'keydown',startTime:1500,processingStart:1501,processingEnd:1502,...e})),lcp:[{startTime:1000},{startTime:2000}],cutoff:{time:1500,handlerObservedAt:1510,validOccurrence:true,reason:'first-trusted-input'},threshold:16,finalized:true,visibility:'visible',countSupport:'performance.interactionCount',totalInteractions,supported:['event','largest-contentful-paint'],errors:[]};};
test('unavailable independent counts stay diagnostic and cannot become an exact p75',()=>{
 const value=summarizeTimings([session([{interactionId:1,duration:32}],undefined)]);assert.equal(value.p75,null);assert.equal(value.qualifiedPopulation,false);assert.equal(value.observedP75,32);assert.equal(value.sessions[0].lcp,1000);
});
test('pooled ranks include established censored groups without fabricating durations',()=>{
 const value=summarizeTimings([session([{interactionId:1,duration:16},{interactionId:1,duration:32}],4),session([{interactionId:1,duration:96},{interactionId:2,duration:128}],4)]);
 assert.equal(value.nInteractions,3);assert.equal(value.totalInteractions,8);assert.equal(value.censored,5);assert.equal(value.p75,32);assert.equal(value.sessions[0].zeroIdEntries,0);
 const below=summarizeTimings([session([{interactionId:1,duration:32}],8)]);assert.equal(below.p75,null);assert.equal(below.p75BelowFloor,true);
});
test('slow zero-ID or malformed Event Timing records make the censored population ambiguous',()=>{
 const slowZero=session([{interactionId:1,duration:32},{interactionId:0,duration:999}],4);
 const result=summarizeTimings([slowZero]);assert.equal(result.qualifiedPopulation,false);
 assert.equal(result.p75,null);assert.equal(result.censored,null);assert.equal(result.sessions[0].ambiguousInteractionId,true);
 for(const interactionId of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  const row=session([{interactionId,duration:32}],1);
  assert.equal(summarizeTimings([row]).qualifiedPopulation,false);
 }
});
test('documented auxiliary zero-ID entries do not invalidate native interaction counts',()=>{
 const names=['pointerover','pointerenter','pointerout','pointerleave','mouseover','mouseenter','mouseout','mouseleave','mousedown','mouseup','beforeinput','input'];
 const row=session([{interactionId:1,duration:32},...names.map(name=>({name,interactionId:0,duration:999}))],1);
 for(const counters of [row.eventCounts,...row.health.delivery.checkpoints.map(c=>c.eventCounts),row.health.delivery.postCapture.checkpoint.eventCounts])Object.assign(counters,{compositionstart:0,compositionupdate:0,compositionend:0});
 const result=summarizeTimings([row]);
 assert.equal(result.qualifiedPopulation,true);assert.equal(result.totalInteractions,1);assert.equal(result.nInteractions,1);
 assert.equal(result.p75,32);assert.equal(result.censored,0);assert.equal(result.sessions[0].zeroIdEntries,names.length);
 assert.equal(row.events.length,names.length+1,'Raw auxiliary evidence remains intact');
});
test('eligible or unknown zero-ID events and malformed auxiliary IDs stay ambiguous',()=>{
 for(const name of ['keydown','keyup','keypress','pointerdown','pointerup','click','unknown-event']){
  const result=summarizeTimings([session([{interactionId:1,duration:32},{name,interactionId:0,duration:999}],2)]);
  assert.equal(result.qualifiedPopulation,false,name);assert.equal(result.p75,null,name);assert.equal(result.sessions[0].ambiguousInteractionId,true,name);
 }
 for(const interactionId of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(summarizeTimings([session([{name:'mouseover',interactionId,duration:32}],1)]).qualifiedPopulation,false);
});
test('zero-ID input needs independent absence of composition; positive IDs stay measured',()=>{
 for(const counters of [{},{compositionstart:1,compositionupdate:0,compositionend:0},{compositionstart:0,compositionupdate:1,compositionend:0},{compositionstart:0,compositionupdate:0,compositionend:1}]){
  const row=session([{interactionId:1,duration:32},{name:'input',interactionId:0,duration:999}],2);Object.assign(row.eventCounts,counters);
  const result=summarizeTimings([row]);assert.equal(result.qualifiedPopulation,false);assert.equal(result.sessions[0].ambiguousInteractionId,true);
 }
 const row=session([{interactionId:1,duration:32},{name:'input',interactionId:2,duration:96}],2);
 const result=summarizeTimings([row]);assert.equal(result.qualifiedPopulation,true);assert.equal(result.nInteractions,2);assert.equal(result.p75,96);
});

test('first zero-drop receipt permits later spec-defined omitted callback fields',()=>{
 const row=session([{interactionId:1,duration:32}],1);
 row.health.callbacks=2;row.health.callbackLedger.push({observedAt:1516,droppedEntriesCount:null});
 assert.equal(summarizeTimings([row]).qualifiedPopulation,true);
 assert.equal(row.health.callbackLedger[1].droppedEntriesCount,null,'Omission stays unknown as a raw field, not a fabricated zero');
 for(const droppedEntriesCount of [null,undefined,-1,1,'0']){
  const bad=structuredClone(row);bad.health.callbackLedger[0].droppedEntriesCount=droppedEntriesCount;
  assert.equal(summarizeTimings([bad]).qualifiedPopulation,false,'First callback needs an explicit zero receipt');
 }
 for(const droppedEntriesCount of [undefined,-1,1,'0']){
  const bad=structuredClone(row);bad.health.callbackLedger[1].droppedEntriesCount=droppedEntriesCount;
  assert.equal(summarizeTimings([bad]).qualifiedPopulation,false,'Later reported drops or malformed fields stay unqualified');
 }
});

test('namespaces, unfinished collectors and missing evidence fail closed',()=>{
 const row=session([{interactionId:1,duration:32}],1);assert.throws(()=>summarizeTimings([{...row,namespace:'same'},{...row,namespace:'same'}]));
 assert.equal(summarizeTimings([{...row,finalized:false}]).qualifiedPopulation,false);
 for(const bad of [session([],0),{...row,lcp:[]},{...row,errors:['failure']},{...row,supported:[]}])assert.throws(()=>summarizeTimings([bad]));
});

test('latency decomposition preserves raw timing and separates queuing, handler and presentation',()=>{
 const value=latencyBreakdown({events:[{interactionId:1,startTime:100,processingStart:120,processingEnd:130,duration:48},{interactionId:0,duration:999}]});assert.equal(value.length,1);assert.equal(value[0].inputDelayMs,20);assert.equal(value[0].handlerMs,10);assert.equal(value[0].presentationRemainderMs,18);assert.equal(value[0].duration,48);
});

test('synthetic zero-drop receipt permits a fully censored population arithmetically',()=>{
 const value=summarizeTimings([session([],41)]);assert.equal(value.totalInteractions,41);assert.equal(value.censored,41);assert.equal(value.nInteractions,0);assert.equal(value.observedP75,null);assert.equal(value.p75,null);assert.equal(value.p75BelowFloor,true);assert.equal(value.qualifiedPopulation,true);
});

test('native counts cannot waive identity, hidden history, dropped entries or window evidence',()=>{
 const row=session([],41);
 for(const change of [{documentId:undefined},{namespace:undefined},{cutoff:undefined},{window:undefined},{health:undefined},{health:{...row.health,droppedEntries:1}},{health:{...row.health,droppedEntries:null}},{lifecycle:[...row.lifecycle,{type:'visibilitychange',time:100,visibility:'hidden'},{type:'visibilitychange',time:200,visibility:'visible'}]},{trustedInputs:[]}])assert.equal(summarizeTimings([{...row,...change}]).qualifiedPopulation,false);
});

test('actual collector uses event occurrence and excludes LCP between delayed input and handler',()=>{
 const listeners={};const context={window:{},crypto:{randomUUID:()=> 'doc'},document:{visibilityState:'visible'},performance:{timeOrigin:1700000000000,now:()=>120},addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn),PerformanceObserver:class {static supportedEntryTypes=['event','largest-contentful-paint'];observe(){}takeRecords(){return [];}},Number};
 runInNewContext(`(${installTimingObserver.toString()})()`,context);
 for(const fn of listeners.pointerdown)fn({isTrusted:true,timeStamp:100,type:'pointerdown'});
 const cutoff=context.window.__uiTiming.cutoff;assert.equal(cutoff.time,100);assert.equal(cutoff.handlerObservedAt,120);
 const row=session([{interactionId:1,duration:32}],1);row.cutoff=cutoff;row.lcp=[{startTime:90},{startTime:110}];assert.equal(summarizeTimings([row]).sessions[0].lcp,90);
});

test('missing, timed out or changing drains remain inconclusive',()=>{
 const row=session([],41),delivery=row.health.delivery;for(const bad of [undefined,{...delivery,stable:false},{...delivery,postCapture:undefined},{...delivery,postCapture:{...delivery.postCapture,stable:false}},{...delivery,postCapture:{...delivery.postCapture,checkpoint:{...delivery.postCapture.checkpoint,events:1}}},{...delivery,postCapture:{...delivery.postCapture,checkpoint:{...delivery.postCapture.checkpoint,frame:null}}}])assert.equal(summarizeTimings([{...row,health:{...row.health,delivery:bad}}]).qualifiedPopulation,false);
});
test('finite entry ordering and conservative quantized completion must fit window',()=>{
 const row=session([{interactionId:1,duration:32}],1);for(const change of [{startTime:undefined},{duration:NaN},{processingStart:1499},{processingEnd:1500},{startTime:3990,processingStart:3991,processingEnd:3992},{duration:0,processingEnd:1520}])assert.equal(summarizeTimings([{...row,events:[{...row.events[0],...change}]}]).qualifiedPopulation,false);
});
test('document identity and time origin cannot be reused under another namespace',()=>{
 const a=session([],1),b=session([],1);assert.throws(()=>summarizeTimings([a,{...a,namespace:'other/'+a.documentId}]),/Duplicate document identity/);assert.throws(()=>summarizeTimings([a,{...b,window:{...b.window,timeOrigin:a.window.timeOrigin}}]),/Duplicate document time origin/);
});
test('incomplete task, keyup counter and native-boundary disagreement stay diagnostic',()=>{
 const row=session([],1);for(const change of [{tasks:[{...row.tasks[0],complete:false}]},{tasks:[{...row.tasks[0],nativeEnd:0}]},{eventCounts:{keydown:1,keyup:0}},{tasks:[{...row.tasks[0],expectedTrustedCounts:{...row.tasks[0].expectedTrustedCounts,keyup:2}}]}])assert.equal(summarizeTimings([{...row,...change}]).qualifiedPopulation,false);
});

test('callback and drain health timestamps must be finite and ordered',()=>{
 const row=session([],1);for(const health of [{...row.health,callbacks:Infinity},{...row.health,callbackLedger:[{observedAt:NaN,droppedEntriesCount:0}]},{...row.health,callbackLedger:[]},{...row.health,flushCompletedAt:3999},{...row.health,delivery:{...row.health.delivery,postCapture:{stable:true,checkpoint:{...row.health.delivery.postCapture.checkpoint,at:NaN}}}}])assert.equal(summarizeTimings([{...row,health}]).qualifiedPopulation,false);
});

test('missing input completion and changed native counters remain inconclusive',()=>{
 const row=session([{interactionId:1,duration:32}],1);
 for(const change of [{trustedInputs:[{type:'keydown',time:1500}]},{health:{...row.health,delivery:{...row.health.delivery,postCapture:{stable:true,checkpoint:{...row.health.delivery.postCapture.checkpoint,interactions:2}}}}}])assert.equal(summarizeTimings([{...row,...change}]).qualifiedPopulation,false);
});

test('collector records post-capture late entries instead of calling the drains stable',async()=>{
 const observers=[],listeners={};let clock=100;
 const context={window:{},crypto:{randomUUID:()=> 'doc'},document:{visibilityState:'visible'},
  performance:{timeOrigin:1700000000000,now:()=>++clock,interactionCount:1,eventCounts:new Map([['keydown',1],['keyup',1]])},
  addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn),
  PerformanceObserver:class {static supportedEntryTypes=['event','largest-contentful-paint'];constructor(cb){this.cb=cb;observers.push(this);}observe(){}takeRecords(){return [];}},
  Number,JSON,setTimeout,clearTimeout,requestAnimationFrame:fn=>setImmediate(()=>fn(++clock)),
  requestIdleCallback:fn=>setImmediate(()=>fn({didTimeout:false}))};
 runInNewContext(`(${installTimingObserver.toString()})()`,context);
 observers[0].cb({getEntries:()=>[]},null,{droppedEntriesCount:0});
 await context.window.__finalizeUiTiming();
 assert.equal(context.window.__uiTiming.health.delivery.stable,true);
 observers[0].cb({getEntries:()=>[{name:'keydown',startTime:100,duration:32,processingStart:101,processingEnd:102,interactionId:1}]},null,{droppedEntriesCount:0});
 await context.window.__verifyUiTiming();
 assert.equal(context.window.__uiTiming.health.delivery.postCapture.stable,false);
 assert.equal(context.window.__uiTiming.events.length,1);
});

test('no event callback cannot establish a zero-drop receipt for subfloor interactions',()=>{
 const row=session([],41);row.health.callbacks=0;row.health.callbackLedger=[];row.health.droppedEntries=null;
 for(const checkpoint of [...row.health.delivery.checkpoints,row.health.delivery.postCapture.checkpoint])checkpoint.droppedEntries=null;
 const value=summarizeTimings([row]);assert.equal(value.qualifiedPopulation,false);assert.equal(value.p75BelowFloor,false);assert.equal(value.censored,null);
});

test('missing keyboard or pointer identity cannot count as a completed input pair',()=>{
 const row=session([],1);
 for(const trustedInputs of [[{type:'keydown',time:1500},{type:'keyup',time:1500.05}],
  [{type:'pointerdown',time:1500},{type:'pointerup',time:1500.05}]]){
  const candidate={...row,trustedInputs,eventCounts:{keydown:1,keyup:1,pointerdown:1,pointerup:1}};
  assert.equal(summarizeTimings([candidate]).sessions[0].paired,false);
 }
});
