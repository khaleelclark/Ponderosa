import assert from 'node:assert/strict';
import test from 'node:test';
import { selectComposerFiles } from '../src/components/chat/composerUtils.js';
import { DEFAULT_ASSET_LIMITS } from '@ponderosa/core';

test('HEIC and HEIF work with declared, empty and generic browser MIME types',()=>{
 for(const [name,type] of [['photo.HEIC','image/heic'],['photo.heif','image/heif'],['photo.heic',''],['photo.HEIF','application/octet-stream']]){
  const file={name,type,size:100};
  const result=selectComposerFiles([],[file],DEFAULT_ASSET_LIMITS);
  assert.deepEqual(result.accepted,[file]);assert.equal(result.error,undefined);
 }
 const oversized={name:'huge.heic',type:'image/heic',size:DEFAULT_ASSET_LIMITS.maxFileBytes+1};
 assert.equal(selectComposerFiles([],[oversized],DEFAULT_ASSET_LIMITS).accepted.length,0);
 const spoofed={name:'photo.heic',type:'application/x-executable',size:100};
 assert.equal(selectComposerFiles([],[spoofed],DEFAULT_ASSET_LIMITS).accepted.length,0);
});
