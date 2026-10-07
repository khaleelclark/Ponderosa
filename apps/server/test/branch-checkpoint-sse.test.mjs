import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {registerStreamRoutes} from '../dist/routes/streams.js';
import {rewriteProductUrl} from '../dist/product-scope.js';

test('published checkpoints from a Branch without a Chat reach the live Branches SSE stream',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'branch-checkpoint-sse-'));
 const store=new AgentStore(dir),workspace=new WorkspaceStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const branch=branches.create('No Chat','no-chat');
 const definition={schema:'ponderosa.branch.v1',name:'No Chat',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 branches.deploy({chatId:'',branchId:branch.id,expectedVersionId:branch.versionId,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 const app=Fastify({rewriteUrl:rewriteProductUrl}),subscribers=new Set(),closures=new Set(),controller=new AbortController();
 const deadline=setTimeout(()=>controller.abort(),5000);
 registerStreamRoutes(app,{store,workspace,serverClosed:()=>false,maxSubscribersPerStream:10,workspaceSubscribers:subscribers,agentSubscriberCount:()=>0,subscribe:()=>()=>{},liveSseClosures:closures,serverMetrics:{openSse:()=>()=>{},sseBackpressure:()=>{}}});
 t.after(async()=>{clearTimeout(deadline);controller.abort();for(const close of closures)close();await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const address=await app.listen({host:'127.0.0.1',port:0});
 const response=await fetch(`${address}/api/branches/engine/workspace/stream?bootstrap=true`,{signal:controller.signal});
 assert.equal(response.status,200);
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 const next=async()=>{
  for(;;){const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);return block;}
   const chunk=await reader.read();assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value,{stream:true});}
 };
 assert.match(await next(),/event: workspace_status/);
 assert.match(await next(),/event: heartbeat/);
 const execution=branches.accept(branch.id,'manual','input');
 const published=[];
 branches.publishAudit(event=>{const envelope=workspace.append(event);published.push(envelope);for(const subscriber of subscribers)subscriber(envelope);});
 assert.ok(published.some(item=>item.event.type==='branch_checkpoint'&&item.event.executionId===execution.id));
 const message=await next();
 assert.match(message,/event: message/);
 assert.match(message,/branch_checkpoint/);
 assert.match(message,new RegExp(execution.id));
 assert.match(message,new RegExp(branch.id));
 branches.advance();
 const lease=branches.claimScript('sse-worker');assert.ok(lease);
 branches.settleScript(lease,{failed:false,output:'done'});
 branches.publishAudit(event=>{const envelope=workspace.append(event);for(const subscriber of subscribers)subscriber(envelope);});
 let sawStep=false;
 for(let i=0;i<20&&!sawStep;i++)sawStep=(await next()).includes('step_settled');
 assert.equal(sawStep,true);
 assert.equal(branches.execution(execution.id).state,'completed');
 const replayCursor=workspace.cursor();
 const map=branches.create('Streamed Map','streamed-map');
 branches.deploy({chatId:'',branchId:map.id,expectedVersionId:map.versionId,idempotencyKey:'map-deploy',definition:{schema:'ponderosa.branch.v1',name:'Streamed Map',trigger:{kind:'manual'},entry:'map',steps:[{id:'work',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:5000}],controls:[{id:'map',kind:'map',joinId:'join',workerId:'work',source:'list',maxItems:2,maxConcurrentItems:2},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],edges:[{id:'item',from:'map',to:'work',on:'selected'},{id:'return',from:'work',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir}}});
 const mapRun=branches.accept(map.id,'map-run','["a","b"]');branches.advance();
 for(let i=0;i<2;i++){const item=branches.claimScript('sse-worker');assert.ok(item);branches.settleScript(item,{failed:false,output:item.input})}
 assert.equal(branches.execution(mapRun.id).state,'completed');
 const mapEvents=[];
 branches.publishAudit(event=>{const envelope=workspace.append(event);mapEvents.push(envelope);for(const subscriber of subscribers)subscriber(envelope)});
 const mapKinds=mapEvents.filter(item=>item.event.type==='branch_checkpoint'&&item.event.executionId===mapRun.id).map(item=>item.event.kind);
 for(const kind of ['map_admitted','map_items_sealed','map_item_started','map_item_completed','join_resolved','result_sealed'])assert.ok(mapKinds.includes(kind),kind);
 assert.equal(new Set(mapEvents.map(item=>item.id)).size,mapEvents.length);
 const replay=await fetch(`${address}/api/branches/engine/workspace/stream?lastEventId=${replayCursor}`,{signal:controller.signal});
 assert.equal(replay.status,200);const replayReader=replay.body.getReader();let replayBuffer='';
 const nextReplay=async()=>{for(;;){const end=replayBuffer.indexOf('\n\n');if(end>=0){const block=replayBuffer.slice(0,end);replayBuffer=replayBuffer.slice(end+2);return block}const chunk=await replayReader.read();assert.equal(chunk.done,false);replayBuffer+=decoder.decode(chunk.value,{stream:true})}};
 assert.match(await nextReplay(),/event: workspace_status/);assert.match(await nextReplay(),/event: heartbeat/);
 const seen=new Set();for(let i=0;i<mapEvents.length&&seen.size<mapEvents.length;i++){const block=await nextReplay();assert.match(block,/"replayed":true/);const id=Number(block.match(/^id: (\d+)/m)?.[1]);assert.ok(id>replayCursor);seen.add(id)}
 assert.equal(seen.size,mapEvents.length);
 await replayReader.cancel();
});
