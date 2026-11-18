import assert from 'node:assert/strict';
import test from 'node:test';
import {Server} from 'node:http';
import {connect} from 'node:net';
import {withMountedCell} from './additive-mounted-ownership.mjs';

for(const failure of ['context setup','page setup','page body','page body + record','cleanup only','record']) {
 test(`mounted ownership: ${failure} preserves primary and closes independent resources`,async t=>{
  const original=()=>{},replacement=()=>{},prototype={deploy:original};
  const primary=Error(failure),closeError=Error('context close'),diagnosticError=Error('screenshot'),releaseError=Error('review release'),connectionsError=Error('connections');
  let server,port,closed=0,released=0,diagnosed=0,reported;
  const listen=Server.prototype.listen;
  t.mock.method(Server.prototype,'listen',function(...args){server=this;return listen.apply(this,args);});
  const context={newPage:async()=>{if(failure==='page setup')throw primary;return {};},close:async()=>{closed++;throw closeError;}};
  const browser={newContext:async()=>{
   assert.equal(prototype.deploy,replacement);assert(server.listening);port=server.address().port;
   const closeConnections=server.closeAllConnections;
   server.closeAllConnections=function(){closeConnections.call(this);throw connectionsError;};
   if(failure==='context setup')throw primary;
   return context;
  }};
  const run=withMountedCell({prototype,deploy:replacement,requestHandler:(_req,res)=>res.end(),browser,contextOptions:{},
   releaseReview:()=>{released++;throw releaseError;},
   run:async()=>{if(failure.startsWith('page body'))throw primary;},
   diagnose:async()=>{diagnosed++;throw diagnosticError;},
   record:async result=>{reported=result;if(failure.includes('record'))throw primary;},
  });
  await assert.rejects(run,error=>{
   if(failure==='context setup'||failure==='page setup'||failure.startsWith('page body'))assert.equal(error,primary,'Exact thrown primary is retained');
   else {assert(error instanceof AggregateError);assert(error.errors.includes(closeError));if(failure.includes('record'))assert(error.errors.includes(primary));}
   return true;
  });
  assert.equal(prototype.deploy,original);assert.equal(server.listening,false);assert.equal(released,1);assert.equal(closed,failure==='context setup'?0:1);
  assert.equal(diagnosed,failure.startsWith('page body')?1:0);
  assert.deepEqual(reported.secondary.map(x=>x.stage),[
   ...(failure.startsWith('page body')?['diagnostic']:[]),'release review',...(failure==='context setup'?[]:['context close']),'close connections',...(failure.includes('record')?['record']:[]),
  ]);
  if(reported.failed)assert.equal(reported.primary,primary);
  await new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();reject(Error('Owned listener survived'));});socket.once('error',error=>{assert.equal(error.code,'ECONNREFUSED');resolve();});});
 });
}

test('mounted ownership: clean success records after restoration',async()=>{
 const original=()=>{},prototype={deploy:original};let closed=0,recorded=0,server;
 await withMountedCell({prototype,deploy:()=>{},requestHandler:(_req,res)=>res.end(),browser:{newContext:async()=>({newPage:async()=>({}),close:async()=>{closed++;}})},contextOptions:{},releaseReview:()=>{},diagnose:()=>assert.fail('No failure diagnosis'),
  run:async resources=>{server=resources.server;assert(server.listening);},
  record:async outcome=>{recorded++;assert.equal(outcome.failed,false);assert.deepEqual(outcome.secondary,[]);assert.equal(prototype.deploy,original);assert.equal(server.listening,false);},
 });
 assert.equal(closed,1);assert.equal(recorded,1);
});
