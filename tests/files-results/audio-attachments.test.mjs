import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAssetUpload } from '../../apps/server/dist/assets.js';

const box=(type,bytes)=>{const header=Buffer.alloc(8);header.writeUInt32BE(bytes.length+8);header.write(type,4);return Buffer.concat([header,bytes]);};
const opus=Buffer.concat([Buffer.from('OggS'),Buffer.alloc(22),Buffer.from([1,19]),Buffer.from('OpusHead'),Buffer.alloc(11)]);
const webm=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d]),Buffer.alloc(8),Buffer.from('A_OPUS'),Buffer.from('OpusHead')]);
const handler=Buffer.alloc(24);handler.write('soun',8);
const mp4=Buffer.concat([box('ftyp',Buffer.from('M4A     ')),box('moov',box('trak',box('mdia',box('hdlr',handler)),box('stsd',Buffer.from('mp4a')))),box('mdat',Buffer.from([1]))]);
for(const [mediaType,name,body] of [['audio/ogg','recording.ogg',opus],['audio/webm','recording.webm',webm],['audio/mp4','recording.m4a',mp4]]) {
 test(`recorded ${mediaType} retains canonical playback type`,async()=>{
  const asset=await prepareAssetUpload({body,name,declaredType:`${mediaType};codecs=opus`});
  assert.equal(asset.mediaType,mediaType);
  await assert.rejects(prepareAssetUpload({body,name:'wrong.png',declaredType:mediaType}));
  await assert.rejects(prepareAssetUpload({body:Buffer.from('not audio'),name,declaredType:mediaType}));
  await assert.rejects(prepareAssetUpload({body,name,declaredType:'image/png'}));
 });
}
