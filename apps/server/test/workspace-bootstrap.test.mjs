import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {registerStreamRoutes} from '../dist/routes/streams.js';

async function open(query,headers={},options={}) {
  const routes=new Map(),subscribers=new Set(),closures=new Set();
  const history=Array.from({length:10000},(_,i)=>({id:i+1,ts:'2026-01-01',event:{type:'notification_changed',action:'read'}}));
  let reads=0,readInput;
  registerStreamRoutes({get:(path,handler)=>routes.set(path,handler)},{
    store:{},workspace:{cursor:()=>10000,instanceId:()=> 'instance',readSince:(cursor,limit)=>{reads++;readInput={cursor,limit};return history.filter(e=>e.id>cursor).slice(0,limit);}},
    serverClosed:()=>false,maxSubscribersPerStream:10,workspaceSubscribers:subscribers,
    agentSubscriberCount:()=>0,subscribe:()=>()=>{},liveSseClosures:closures,
    serverMetrics:{openSse:()=>()=>{},sseBackpressure:()=>{}},
  });
  let output='',destroyed=false,writes=0;const raw=new EventEmitter();
  const response=new EventEmitter();
  response.writeHead=()=>{};
  response.write=text=>{output+=text;writes++;return options.backpressure!==true && !(options.backpressureOnce && writes===1);};
  response.end=()=>{};
  response.destroy=()=>{destroyed=true;};
  const reply={hijack(){},raw:response};
  await routes.get('/api/workspace/stream')({query,headers,raw},reply);
  const messages=()=>output.split('\n\n').map(block=>{const data=block.split('\n').find(line=>line.startsWith('data:'));return data?JSON.parse(data.slice(5)):null;}).filter(Boolean);
  return {messages,get reads(){return reads;},get readInput(){return readInput;},get destroyed(){return destroyed;},emit:e=>{for(const fn of subscribers)fn(e);},drain:()=>response.emit('drain'),close:()=>raw.emit('close'),subscribers};
}
test('fresh bootstrap skips history, advertises baseline, and delivers new events',async()=>{
  const stream=await open({lastEventId:'0',bootstrap:'true'});
  try {
    assert.equal(stream.reads,0);
    assert.deepEqual(stream.messages()[0],{instanceId:'instance',cursor:10000,reset:false,snapshot:true});
    assert.equal(stream.messages().filter(e=>e.id).length,0);
    stream.emit({id:10001,event:{type:'notification_changed',action:'read'}});
    assert.equal(stream.messages().at(-1).id,10001);
    assert.equal(stream.messages().at(-1).replayed,undefined);
  }finally{stream.close();}
  assert.equal(stream.subscribers.size,0);
});
test('valid reconnect replays missed events; Last-Event-ID header takes precedence',async()=>{
  const stream=await open({lastEventId:'0',bootstrap:'true'},{'last-event-id':'9998'});
  try{assert.equal(stream.reads,1);assert.equal(stream.messages()[0].snapshot,undefined);assert.deepEqual(stream.messages().filter(e=>e.id).map(e=>[e.id,e.replayed]),[[9999,true],[10000,true]]);}finally{stream.close();}
});
test('ahead-of-server cursor bootstraps with reset instead of replaying all history',async()=>{
  const stream=await open({lastEventId:'20000',bootstrap:'true'});
  try{assert.equal(stream.reads,0);assert.equal(stream.messages()[0].snapshot,true);assert.equal(stream.messages()[0].reset,true);}finally{stream.close();}
});
test('legacy clients retain replay behavior without opting in',async()=>{
  const stream=await open({lastEventId:'9999'});
  try{assert.equal(stream.reads,1);assert.equal(stream.messages()[0].snapshot,undefined);assert.equal(stream.messages().at(-1).id,10000);}finally{stream.close();}
});
test('stale reconnects advertise reset and replay only the bounded tail',async()=>{
  const stream=await open({lastEventId:'1'});
  try {
    assert.equal(stream.messages()[0].reset,true);
    assert.deepEqual(stream.readInput,{cursor:5000,limit:5000});
    assert.equal(stream.messages().filter(e=>e.id).length,5000);
  }finally{stream.close();}
});
test('temporary backpressure queues frames in order until drain without disconnecting',async()=>{
  const stream=await open({lastEventId:'0',bootstrap:'true'}, {}, {backpressureOnce:true});
  try{
    stream.emit({id:10001,event:{type:'notification_changed',action:'read'}});
    assert.equal(stream.destroyed,false);
    assert.equal(stream.messages().length,1);
    stream.drain();
    assert.equal(stream.messages().at(-1).id,10001);
    assert.equal(stream.destroyed,false);
  }finally{stream.close();}
});
test('a persistently backpressured response is disconnected at the bounded queue limit',async()=>{
  const stream=await open({lastEventId:'9999'}, {}, {backpressure:true});
  for(let i=0;i<1100 && !stream.destroyed;i++)stream.emit({id:10001+i,event:{type:'notification_changed',action:'read'}});
  assert.equal(stream.destroyed,true);
  assert.equal(stream.subscribers.size,0);
});

test('Agent stream also waits for drain and preserves sequence order',async()=>{
  const routes=new Map();
  const listeners=new Set();
  const closures=new Set();
  registerStreamRoutes({get:(path,handler)=>routes.set(path,handler)},{
    store:{getAgent:()=>({id:'agent'}),lastSeqOf:()=>0,readEventsSince:()=>[]},
    workspace:{instanceId:()=> 'instance'},serverClosed:()=>false,maxSubscribersPerStream:10,
    workspaceSubscribers:new Set(),agentSubscriberCount:()=>listeners.size,
    subscribe:(_id,listener)=>{listeners.add(listener);return()=>listeners.delete(listener);},
    liveSseClosures:closures,serverMetrics:{openSse:()=>()=>{},sseBackpressure:()=>{}},
  });
  let output='',writes=0,destroyed=false;
  const response=new EventEmitter();
  response.writeHead=()=>{};
  response.write=frame=>{output+=frame;writes++;return writes!==1;};
  response.end=()=>{};
  response.destroy=()=>{destroyed=true;};
  const raw=new EventEmitter();
  await routes.get('/api/agents/:id/stream')({params:{id:'agent'},query:{lastEventId:'0'},headers:{},raw},{hijack(){},raw:response});
  try{
    for(let seq=1;seq<=2;seq++)for(const listener of listeners)listener({seq,ts:'2026-01-01',event:{type:'status'}});
    assert.equal(output.includes('id: 1'),false);
    assert.equal(destroyed,false);
    response.emit('drain');
    assert(output.indexOf('id: 1')<output.indexOf('id: 2'));
    assert.equal(destroyed,false);
  }finally{raw.emit('close');}
  assert.equal(listeners.size,0);
});
