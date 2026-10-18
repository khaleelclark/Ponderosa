import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {v5Identity,pineconeDecisionResponseAllowed,servePineconeProduct,closePineconeService} from '../../../experiments/pinecone-shadow/pinecone-product-proxy.ts';
const decision=(extra={})=>({...v5Identity,id:'decision',status:'pending',mode:'choice',allowOther:true,options:[{id:'existing',label:'Existing connection'}],...extra});
test('only existing speaker ordinary choices/text may pass the preview policy',()=>{
 assert(pineconeDecisionResponseAllowed(decision(),{optionId:'existing'}));
 assert(pineconeDecisionResponseAllowed(decision(),{text:'pick either one'}));
 for(const changed of [{agentId:'other'},{projectId:'other'},{conversationId:'other'},{mode:'approval'},{runtimeAction:{}},{approvalScope:{kind:'saved_browser'}},{status:'cancelled'}])assert.equal(pineconeDecisionResponseAllowed(decision(changed),{text:'yes'}),false);
 for(const body of [{optionId:'missing'},{text:'yes',content:{credential:'no'}},{text:'yes',optionId:'existing'},{text:'yes',optionId:3},{text:4},{},null])assert.equal(pineconeDecisionResponseAllowed(decision(),body),false);
 assert.equal(pineconeDecisionResponseAllowed(decision({allowOther:false}),{text:'yes'}),false);
});
test('only an identical resolved response can replay; never a changed choice or new activation identity',()=>{
 assert(pineconeDecisionResponseAllowed(decision({status:'resolved',response:{optionId:'existing'}}),{optionId:'existing'}));
 assert.equal(pineconeDecisionResponseAllowed(decision({status:'resolved',response:{text:'earlier'}}),{text:'changed'}),false);
});
test('own consumer route and assets preserve V3/V4 routes and existing CSP',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pinecone-static-'));
 try{
  await writeFile(path.join(dir,'index.html'),'<title>Pinecone product</title>');await mkdir(path.join(dir,'static'));await writeFile(path.join(dir,'static/app.js'),'consumer');
  const request=async url=>{const result={};const response={writeHead(status,headers){Object.assign(result,{status,headers})},end(body){result.body=body?.toString()}};result.handled=await servePineconeProduct({method:'GET',url},response,dir);return result};
  assert.equal((await request('/pinecone')).body,'<title>Pinecone product</title>');
  assert.equal((await request('/')).headers.location,'/pinecone');
  assert.equal((await request('/branches?branch='+v5Identity.branchId+'&tab=pinecone')).headers.location,'/pinecone');
  for(const id of ['0356095a-8d73-4249-b39d-883b978ae119','592f4798-cd48-445a-91f2-9f9a86b1c135'])assert.equal((await request('/branches?branch='+id+'&tab=pinecone')).handled,false);
  const asset=await request('/pinecone/static/app.js');assert.equal(asset.status,200);assert.equal(asset.headers['content-security-policy'].includes("connect-src 'self'"),true);
  assert.equal((await request('/pinecone/static/%2e%2e%2f%2e%2e%2fsecret')).status,404);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('shutdown releases event streams before waiting for frontend close',async()=>{
 const order=[];let prepared=false;
 await closePineconeService({close(done){assert(prepared,'frontend would wait forever on live event streams');order.push('frontend');done()}},{prepareForShutdown(){prepared=true;order.push('prepare')},async close(){order.push('backend')}});
 assert.deepEqual(order,['prepare','frontend','backend']);
});
