import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import sharp from 'sharp';
import { createServer } from '../dist/app.js';
import { prepareAssetUpload } from '../dist/assets.js';

test('preview encoding remains lossless and bounded', async () => {
  const pixels=Buffer.alloc(512*384*3);
  for(let i=0;i<pixels.length;i++) pixels[i]=(i*17)%251;
  const body=await sharp(pixels,{raw:{width:512,height:384,channels:3}}).jpeg().toBuffer();
  const prepared=await prepareAssetUpload({body,name:'sample.jpg',declaredType:'image/jpeg'});
  const old=await sharp(body).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
  assert.deepEqual(await sharp(prepared.preview).raw().toBuffer(), await sharp(old).raw().toBuffer());
  assert.equal(prepared.width,512);assert.equal(prepared.height,384);
  await assert.rejects(prepareAssetUpload({body:Buffer.concat([body,Buffer.from('trailing')]),name:'sample.jpg',declaredType:'image/jpeg'}));
});

test('sending and replay use exact saved messages without full runtime or chat reads', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'ponderosa-chat-receipt-'));
  const store=new AgentStore(dataDir);
  const hostPath=join(dataDir,'source');await mkdir(hostPath);
  const p=store.createProject({label:'Disposable',hostPath,defaultEngine:'codex'});
  const chat=store.createConversation(p.id,{title:'Receipt test'});
  const app=createServer({dataDir,store,engines:[],logger:false});
  t.after(async()=>{app.prepareForShutdown();await app.close();await rm(dataDir,{recursive:true,force:true});});
  await app.ready();
  let broadReads=0;
  const original=CoordinationV3Store.prototype.runtimeCommunications;
  CoordinationV3Store.prototype.runtimeCommunications=function(...args){broadReads++;return original.apply(this,args);};
  t.after(()=>{CoordinationV3Store.prototype.runtimeCommunications=original;});
  let fullChatReads=0;
  const getMessages=store.getConversationMessages.bind(store);
  store.getConversationMessages=(...args)=>{fullChatReads++;return getMessages(...args);};
  const send=()=>app.inject({method:'POST',url:`/api/conversations/${chat.id}/messages`,payload:{text:'#broadcast Plain content',idempotencyKey:'same-attempt'}});
  const response=await send();assert.equal(response.statusCode,200,response.body);
  const message=response.json();assert.equal(message.conversationId,chat.id);assert.ok(message.id);
  const replay=await send();assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().id,message.id);
  assert.equal(broadReads,0,'runtime reads');assert.equal(fullChatReads,0,'chat reads');
  assert.equal(store.getProjectedConversationMessages(chat.id).length,1);
});
