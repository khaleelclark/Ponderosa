import {runInNewContext} from 'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import {summarizeTimings,latencyBreakdown,installTimingObserver} from './event-timing-observer.mjs';
let sequence=0;
const session=(events,totalInteractions)=>{const documentId='document-'+(++sequence);return {documentId,namespace:'test/'+documentId,window:{start:0,end:2500,lastPresentation:2500,timeOrigin:1700000000000},lifecycle:[{type:'init',time:0,visibility:'visible'}],health:{registered:true,drained:true,callbacks:1,droppedEntries:0},eventCounts:{keydown:1},trustedInputs:[{type:'keydown',time:1500}],events,lcp:[{startTime:1000},{startTime:2000}],cutoff:{time:1500,handlerObservedAt:1510,validOccurrence:true,reason:'first-trusted-input'},threshold:16,finalized:true,visibility:'visible',countSupport:'performance.interactionCount',totalInteractions,supported:['event','largest-contentful-paint'],errors:[]};};
test('unavailable independent counts stay diagnostic and cannot become an exact p75',()=>{
 const value=summarizeTimings([session([{interactionId:1,duration:32}],undefined)]);assert.equal(value.p75,null);assert.equal(value.qualifiedPopulation,false);assert.equal(value.observedP75,32);assert.equal(value.sessions[0].lcp,1000);
});
test('pooled ranks include established censored groups without fabricating durations',()=>{
 const value=summarizeTimings([session([{interactionId:1,duration:16},{interactionId:1,duration:32},{interactionId:0,duration:999}],4),session([{interactionId:1,duration:96},{interactionId:2,duration:128}],4)]);
 assert.equal(value.nInteractions,3);assert.equal(value.totalInteractions,8);assert.equal(value.censored,5);assert.equal(value.p75,32);assert.equal(value.sessions[0].zeroIdEntries,1);
 const below=summarizeTimings([session([{interactionId:1,duration:32}],8)]);assert.equal(below.p75,null);assert.equal(below.p75BelowFloor,true);
});
test('namespaces, unfinished collectors and missing evidence fail closed',()=>{
 const row=session([{interactionId:1,duration:32}],1);assert.throws(()=>summarizeTimings([{...row,namespace:'same'},{...row,namespace:'same'}]));
 assert.equal(summarizeTimings([{...row,finalized:false}]).qualifiedPopulation,false);
 for(const bad of [session([],0),{...row,lcp:[]},{...row,errors:['failure']},{...row,supported:[]}])assert.throws(()=>summarizeTimings([bad]));
});

test('latency decomposition preserves raw timing and separates queuing, handler and presentation',()=>{
 const value=latencyBreakdown({events:[{interactionId:1,startTime:100,processingStart:120,processingEnd:130,duration:48},{interactionId:0,duration:999}]});assert.equal(value.length,1);assert.equal(value[0].inputDelayMs,20);assert.equal(value[0].handlerMs,10);assert.equal(value[0].presentationRemainderMs,18);assert.equal(value[0].duration,48);
});

test('native positive count with healthy finalized collector may consist entirely of subfloor interactions',()=>{
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
