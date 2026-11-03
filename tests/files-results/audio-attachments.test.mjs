import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAssetUpload } from '../../apps/server/dist/assets.js';
import { withFixture, fixtureTestOptions as options } from '../shared/fixture.mjs';

const box=(type,bytes)=>{const header=Buffer.alloc(8);header.writeUInt32BE(bytes.length+8);header.write(type,4);return Buffer.concat([header,bytes]);};
const opus=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(22),Buffer.from([1,19]),Buffer.from('OpusHead'),Buffer.alloc(11)]);
const webm=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d]),Buffer.alloc(8),Buffer.from('A_OPUS'),Buffer.from('OpusHead')]);
const handler=Buffer.alloc(24);handler.write('soun',8);
const mp4=Buffer.concat([box('ftyp',Buffer.from('M4A     ')),box('moov',Buffer.concat([box('trak',box('mdia',box('hdlr',handler))),box('stsd',Buffer.from('mp4a'))])),box('mdat',Buffer.from([1]))]);
for(const [mediaType,name,body] of [['audio/ogg','recording.ogg',opus],['audio/webm','recording.webm',webm],['audio/mp4','recording.m4a',mp4]]) {
 test(`recorded ${mediaType} retains canonical playback type`,async()=>{
  const asset=await prepareAssetUpload({body,name,declaredType:`${mediaType};codecs=opus`});
  assert.equal(asset.mediaType,mediaType);
  await assert.rejects(prepareAssetUpload({body,name:'wrong.png',declaredType:mediaType}));
  await assert.rejects(prepareAssetUpload({body:Buffer.from('not audio'),name,declaredType:mediaType}));
  await assert.rejects(prepareAssetUpload({body,name,declaredType:'image/png'}));
 });
}


test('verified audio downloads support browser ranges without changing ordinary downloads or owner scope',options,t=>withFixture(t,async f=>{
 const chat=await f.createChat('Voice playback'),other=await f.createChat('Other owner');
 const agent=await f.createAgent(chat,'Speaker');
 const headers={'content-type':'application/octet-stream','x-ponderosa-filename':'voice.ogg','x-ponderosa-media-type':'audio/ogg'};
 for(const [owner,path] of [['agent',"/api/agents/"+agent.id],['chat',"/api/conversations/"+chat.id]]){
  const asset=f.ok(await f.api('POST',path+'/attachments',opus,headers));
  const url=path+'/assets/'+asset.id+'/download';
  const full=await f.api('GET',url);
  assert.equal(full.status,200,owner);assert.deepEqual(full.rawBody,opus);
  assert.match(full.headers['content-disposition'],/^attachment/);
  assert.match(full.headers['content-type'],/^application\/octet-stream/);
  const inline=await f.api('GET',url+'?playback=audio',undefined,{range:'bytes=0-1'});
  assert.equal(inline.status,206);assert.deepEqual(inline.rawBody,opus.subarray(0,2));
  assert.equal(inline.headers['content-range'],'bytes 0-1/'+opus.length);
  assert.equal(inline.headers['content-type'],'audio/ogg');assert.equal(inline.headers['content-disposition'],'inline');
  assert.equal(inline.headers['x-content-type-options'],'nosniff');
  for(const [range,start,end] of [['bytes=2-',2,opus.length],['bytes=-4',opus.length-4,opus.length],['bytes=0-99999',0,opus.length]]){
   const res=await f.api('GET',url+'?playback=audio',undefined,{range});
   assert.equal(res.status,206);assert.deepEqual(res.rawBody,opus.subarray(start,end));
  }
  const unsat=await f.api('GET',url,undefined,{range:'bytes='+opus.length+'-'});
  assert.equal(unsat.status,416);assert.equal(unsat.headers['content-range'],'bytes */'+opus.length);
  for(const range of ['bytes=0-1,3-4','bytes=5-3','nonsense','bytes='+('9'.repeat(129))+'-']){
   const res=await f.api('GET',url,undefined,{range});assert.equal(res.status,200);assert.deepEqual(res.rawBody,opus);
  }
  const ifRange=await f.api('GET',url,undefined,{range:'bytes=0-1','if-range':'"unknown"'});
  assert.equal(ifRange.status,200);assert.deepEqual(ifRange.rawBody,opus);
  assert.equal((await f.api('GET','/api/conversations/'+other.id+'/assets/'+asset.id+'/download?playback=audio',undefined,{range:'bytes=0-1'})).status,404);
 }
 const text=f.ok(await f.api('POST','/api/conversations/'+chat.id+'/attachments',Buffer.from('not audio'),{'content-type':'application/octet-stream','x-ponderosa-filename':'note.txt','x-ponderosa-media-type':'text/plain'}));
 assert.equal((await f.api('GET','/api/conversations/'+chat.id+'/assets/'+text.id+'/download?playback=audio')).status,404);
}));
