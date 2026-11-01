import test from 'node:test';import assert from 'node:assert/strict';import {summarizeTimings,latencyBreakdown} from './event-timing-observer.mjs';
const session=(events,totalInteractions)=>({events,lcp:[{startTime:1000},{startTime:2000}],cutoff:{time:1500,reason:'first-trusted-input'},threshold:16,finalized:true,visibility:'visible',countSupport:'performance.interactionCount',totalInteractions,supported:['event','largest-contentful-paint'],errors:[]});
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
