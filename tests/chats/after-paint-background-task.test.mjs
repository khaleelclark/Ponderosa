import test from 'node:test';
import assert from 'node:assert/strict';
import {afterPaintBackgroundTask} from '../../apps/web/src/afterPaintBackgroundTask.ts';

async function fixture(run,{fallback=false}={}){
 const names=['window','requestAnimationFrame','cancelAnimationFrame','clearTimeout','reportError'],old=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const frames=new Map(),timers=new Map(),tasks=[],errors=[];let id=0;
 Object.assign(globalThis,{requestAnimationFrame:fn=>{const key=++id;frames.set(key,fn);return key;},cancelAnimationFrame:key=>frames.delete(key),clearTimeout:key=>timers.delete(key),reportError:error=>errors.push(error),window:{
  setTimeout:fn=>{const key=++id;timers.set(key,fn);return key;},
  scheduler:fallback?undefined:{postTask(fn,options){return new Promise((resolve,reject)=>{tasks.push({fn,options,run(){try{resolve(fn());}catch(error){reject(error);}}});options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});}},
 }});
 const frame=()=>{const [key,fn]=frames.entries().next().value;frames.delete(key);fn();};
 try{await run({frames,timers,tasks,errors,frame});await new Promise(setImmediate);}
 finally{for(const name of names){const value=old.get(name);if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}}
}
test('shared background callback yields through two animation frames and keeps native background priority',()=>fixture(async f=>{
 let calls=0;const cancel=afterPaintBackgroundTask(()=>calls++);
 assert.equal(calls,0);f.frame();assert.equal(f.tasks.length,0);f.frame();
 assert.equal(calls,0);assert.equal(f.tasks[0].options.priority,'background');f.tasks[0].run();assert.equal(calls,1);cancel();assert.deepEqual(f.errors,[]);
}));
test('cancellation prevents stale callbacks at either frame, native task and timer fallback',async()=>{
 for(const phase of [0,1,2])await fixture(async f=>{
  let calls=0;const cancel=afterPaintBackgroundTask(()=>calls++);
  for(let i=0;i<phase;i++)f.frame();const stale=f.tasks[0]?.fn;cancel();stale?.();
  assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);assert.equal(calls,0);await new Promise(setImmediate);assert.deepEqual(f.errors,[]);
 });
 await fixture(async f=>{let calls=0;const cancel=afterPaintBackgroundTask(()=>calls++);f.frame();f.frame();assert.equal(f.timers.size,1);const stale=[...f.timers.values()][0];cancel();stale();assert.equal(calls,0);assert.equal(f.timers.size,0);},{fallback:true});
});
test('fallback executes once and unexpected native task errors remain visible',async()=>{
 await fixture(async f=>{let calls=0;afterPaintBackgroundTask(()=>calls++);f.frame();f.frame();const [key,fn]=[...f.timers][0];f.timers.delete(key);fn();assert.equal(calls,1);},{fallback:true});
 await fixture(async f=>{const error=Error('Specific background failure');afterPaintBackgroundTask(()=>{throw error;});f.frame();f.frame();f.tasks[0].run();await new Promise(setImmediate);assert.deepEqual(f.errors,[error]);});
});
