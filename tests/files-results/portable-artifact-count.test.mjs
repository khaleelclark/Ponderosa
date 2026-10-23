import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {portableBase64ByteLength,decodePortableArtifact} from '../../apps/server/dist/agent-package-codec.js';
import {MANAGED_ARTIFACT_MAX_BYTES} from '@ponderosa/agents';

test('package preview sizes agree with actual artifact decoding across padding and chunk boundaries',async()=>{
 for(const size of [0,1,2,3,4,5,6,31,196607,196608,196609,393217]){
  const bytes=randomBytes(size),encoded=bytes.toString('base64');
  for(const value of new Set([encoded,encoded.replace(/=+$/u,'')])){
   assert.equal(portableBase64ByteLength(value),size);
   assert.deepEqual((await decodePortableArtifact(value)).data,bytes);
  }
 }
});

test('preview and import agree at the managed-file ceiling including base64 rounding',async()=>{
 for(const extra of [0,1,2,3]){
  const size=MANAGED_ARTIFACT_MAX_BYTES+extra,encoded=Buffer.alloc(size).toString('base64');
  for(const value of new Set([encoded,encoded.replace(/=+$/u,'')])){
   if(extra===0){assert.equal(portableBase64ByteLength(value),size);assert.equal((await decodePortableArtifact(value)).data.length,size)}
   else{assert.throws(()=>portableBase64ByteLength(value),/64 MiB/);await assert.rejects(decodePortableArtifact(value),/64 MiB/)}
  }
 }
});

test('preview validation rejects illegal padding, alphabet and nonzero unused bits before displaying a size',async()=>{
 for(const value of ['A','AB','ABC','AAB','AAAAAB','AAB=','AA===','AA A','AA\n','AAAA-','A=AA','====']){
  assert.throws(()=>portableBase64ByteLength(value),/invalid base64/);
  await assert.rejects(decodePortableArtifact(value),/invalid base64/);
 }
});
