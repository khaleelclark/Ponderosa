import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
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

// Native Chrome155 MediaRecorder capture from an owned benign WAV. Its Opus
// payload contains V_ at byte24023; that is compressed audio, not a video track.
const nativeWebm=readFileSync(new URL('../fixtures/native-opus-voice.webm',import.meta.url));
const ebml=(id,data)=>{
 const bytes=Buffer.from(id,'hex');
 const size=data.length<127?Buffer.from([0x80|data.length]):Buffer.from([0x40|(data.length>>8),data.length&255]);
 return Buffer.concat([bytes,size,data]);
};
const track=(type,codec)=>ebml('ae',Buffer.concat([ebml('83',Buffer.from([type])),ebml('86',Buffer.from(codec)),ebml('63a2',Buffer.concat([Buffer.from('OpusHead'),Buffer.alloc(11)]))]));
const webmTracks=tracks=>Buffer.concat([ebml('1a45dfa3',ebml('4282',Buffer.from('webm'))),ebml('18538067',Buffer.concat([ebml('1654ae6b',Buffer.concat(tracks)),ebml('1f43b675',Buffer.from('V_ is opaque compressed payload'))]))]);
test('native Opus WebM permits video-like bytes in compressed audio but validates declared tracks',async()=>{
 assert.equal(createHash('sha256').update(nativeWebm).digest('hex'),'0b580f770ac3e3e480b49abfb86ee7b33a1a043122f2ea11fb0153f921d5cafa');
 assert.equal(nativeWebm.indexOf(Buffer.from('V_')),24023);
 assert.equal(recordingMediaType(nativeWebm),'audio/webm');
 assert.equal((await prepareAssetUpload({name:'voice.webm',declaredType:'audio/webm',body:nativeWebm})).mediaType,'audio/webm');
 assert.equal(recordingMediaType(webmTracks([track(2,'A_OPUS')])),'audio/webm');
 for(const body of [webmTracks([track(1,'V_VP9')]),webmTracks([track(2,'A_OPUS'),track(1,'V_VP9')]),webmTracks([track(2,'A_VORBIS')]),nativeWebm.subarray(0,146),nativeWebm.subarray(0,110),Buffer.concat([ebml('1a45dfa3',ebml('4282',Buffer.from('webm'))),ebml('18538067',Buffer.concat([ebml('1654ae6b',track(2,'A_OPUS')),ebml('1654ae6b',track(1,'V_VP9')),ebml('1f43b675',Buffer.from([1]))]))]),Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from('webm A_OPUS OpusHead')])]){
  assert.equal(recordingMediaType(body),undefined);
  await assert.rejects(prepareAssetUpload({name:'voice.webm',declaredType:'audio/webm',body}));
 }
});
