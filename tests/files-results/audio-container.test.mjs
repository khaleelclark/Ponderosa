import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingMediaType} from '../../apps/server/dist/audio-container.js';
import {prepareAssetUpload} from '../../apps/server/dist/assets.js';

function opusPage(){
  const header=Buffer.alloc(28);header.write('OggS');header[26]=1;header[27]=19;
  const packet=Buffer.alloc(19);packet.write('OpusHead');packet[8]=1;packet[9]=1;
  return Buffer.concat([header,packet]);
}
test('Opus recording retains canonical audio media type and rejects truncated or mislabeled containers',async()=>{
  const body=opusPage();
  assert.equal(recordingMediaType(body),'audio/ogg');
  assert.equal(recordingMediaType(body.subarray(0,-1)),undefined);
  assert.equal(recordingMediaType(Buffer.from('not a recording')),undefined);
  const prepared=await prepareAssetUpload({name:'voice.ogg',declaredType:'audio/ogg; codecs=opus',body});
  assert.equal(prepared.mediaType,'audio/ogg');
  await assert.rejects(prepareAssetUpload({name:'voice.m4a',declaredType:'audio/mp4',body}));
  await assert.rejects(prepareAssetUpload({name:'voice.ogg',declaredType:'audio/ogg',body:body.subarray(0,-1)}));
});
