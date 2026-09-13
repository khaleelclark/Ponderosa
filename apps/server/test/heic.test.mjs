import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { WorkspaceStore } from '@ponderosa/agents';
import { AssetStore } from '../dist/assets.js';
import { DraftService, registerDraftRoutes } from '../dist/routes/drafts.js';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareAssetUpload } from '../dist/assets.js';
import { decodeHeic, isHeicContainer } from '../dist/heic.js';
import { runtimeAttachmentName } from '../dist/routes/agent-run-preparation.js';

const body=await readFile(new URL('./fixtures/heic/colors.heic',import.meta.url));
test('HEIC orientation is applied by the decoder',async()=>{
 const rotated=await readFile(new URL('./fixtures/heic/rotated.heic',import.meta.url));
 const prepared=await prepareAssetUpload({body:rotated,name:'rotated.heic'});
 assert.equal(prepared.width,48);assert.equal(prepared.height,64);
});
test('HEIC and HEIF uploads retain original identity and produce a usable PNG', async()=>{
 for(const [name,declaredType] of [['phone.HEIC','image/heic'],['phone.heif','image/heif'],['phone.heic','application/octet-stream']]){
  const prepared=await prepareAssetUpload({body,name,declaredType});
  assert.equal(prepared.mediaType,'image/heic');assert.equal(prepared.name,name);
  assert.equal(prepared.sha256,createHash('sha256').update(body).digest('hex'));
  assert.equal(prepared.width,64);assert.equal(prepared.height,48);
  assert.equal(runtimeAttachmentName({id:'asset',name,mediaType:'image/heic'}),'asset-phone.png');
  const {data,info}=await sharp(prepared.preview).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,64);assert.equal(info.height,48);
  const pixel=(x,y)=>[...data.subarray((y*64+x)*info.channels,(y*64+x)*info.channels+3)];
  assert.ok(pixel(8,8)[0]>220&&pixel(8,8)[1]>220,'top-left yellow preserved');
  assert.ok(pixel(56,40)[2]>220&&pixel(56,40)[0]<30,'bottom-right blue preserved');
 }
});
test('HEIC admission fails closed for mismatch, truncation, trailing data and excessive dimensions', async()=>{
 assert.equal(isHeicContainer(body),true);
 for(const invalid of [body.subarray(0,30),body.subarray(0,-5),Buffer.concat([body,Buffer.from('trailing')])]){
  await assert.rejects(prepareAssetUpload({body:invalid,name:'bad.heic',declaredType:'image/heic'}));
 }
 await assert.rejects(prepareAssetUpload({body,name:'fake.jpg',declaredType:'image/jpeg'}));
 await assert.rejects(prepareAssetUpload({body,name:'fake.heic',declaredType:'image/png'}));
 await assert.rejects(decodeHeic(body,100),'dimensions enforced before pixel display');
});
test('four concurrent HEIC uploads finish without blocking the event loop', async()=>{
 let ticks=0;const timer=setInterval(()=>ticks++,5);
 try { await Promise.all(Array.from({length:4},()=>prepareAssetUpload({body,name:'photo.heic',declaredType:'image/heic'}))); }
 finally {clearInterval(timer);}
 assert.ok(ticks>0,'server remains responsive during synchronous HEVC decoding');
});

test('durable draft HEIC upload downloads original and promotes its validated PNG',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ponderosa-heic-draft-'));
 const assets=new AssetStore(directory);
 const workspace=new WorkspaceStore(directory);
 const drafts=new DraftService(directory,{getAgent:()=>undefined,getConversation:()=>({id:'chat-a'})},workspace,assets);
 const app=Fastify();
 app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
 registerDraftRoutes(app,drafts,workspace,8,()=>undefined);
 try {
  const upload=await app.inject({method:'POST',url:'/api/conversations/chat-a/draft-attachments',headers:{'content-type':'application/octet-stream','x-ponderosa-draft-owner':'browser-one','x-ponderosa-filename':'phone.heic','x-ponderosa-media-type':'image/heic'},payload:body});
  assert.equal(upload.statusCode,201,upload.body);
  const attachment=upload.json();
  assert.equal(attachment.mediaType,'image/heic');
  const download=await app.inject({method:'GET',url:attachment.downloadUrl});
  assert.equal(download.statusCode,200);assert.deepEqual(download.rawPayload,body);
  const otherOwner=await app.inject({method:'GET',url:attachment.downloadUrl.replace('browser-one','browser-two')});
  assert.equal(otherOwner.statusCode,404);
  const restored=await drafts.prepared('chat-a','browser-one',attachment.id);
  assert.ok(restored);
  const staged=await assets.stage({projectId:'project-a',agentId:'agent-a',body:restored.body,prepared:restored.prepared});
  assert.deepEqual((await assets.content('project-a','agent-a',staged.id,false)).body,body);
  assert.equal((await sharp((await assets.content('project-a','agent-a',staged.id,true)).body).metadata()).format,'png');
 } finally {await app.close();assets.close();await rm(directory,{recursive:true,force:true});}
});
