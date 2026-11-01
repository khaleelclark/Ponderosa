import test from 'node:test';import assert from 'node:assert/strict';import {summarizeTimings} from './event-timing-observer.mjs';
const session=events=>({events,lcp:[{startTime:1000}],supported:['event','largest-contentful-paint'],errors:[]});
test('pooled nearest-rank p75 groups duplicate events by interaction within each fresh session',()=>{
 const value=summarizeTimings([session([{interactionId:1,duration:16},{interactionId:1,duration:32},{interactionId:2,duration:64},{interactionId:0,duration:999}]),session([{interactionId:1,duration:96},{interactionId:2,duration:128}])]);assert.equal(value.nInteractions,4);assert.equal(value.p75,96);assert.equal(value.nSessions,2);
});
test('unsupported, empty or failed observers cannot pass as zero latency',()=>{for(const row of [session([]),{...session([{interactionId:1,duration:16}]),lcp:[]},{...session([]),errors:['failure']},{...session([]),supported:[]}])assert.throws(()=>summarizeTimings([row]));});
