import assert from 'node:assert/strict';
import test from 'node:test';
import { selectComposerFiles } from '../src/components/chat/composerUtils.js';
import { DEFAULT_ASSET_LIMITS } from '@ponderosa/core';

test('supported phone image extensions work with empty and generic picker MIME without trusting a contradictory declared type',()=>{
 for(const extension of ['JPG','jpeg','png','webp','gif','avif']){
  for(const type of ['', 'application/octet-stream']){
   const file={name:`photo.${extension}`,type,size:100};
   const result=selectComposerFiles([],[file],DEFAULT_ASSET_LIMITS);
   assert.deepEqual(result.accepted,[file]);assert.equal(result.error,undefined);
  }
  assert.equal(selectComposerFiles([],[{name:`photo.${extension}`,type:'application/x-executable',size:100}],DEFAULT_ASSET_LIMITS).accepted.length,0);
 }
 for(const type of ['image/gif','image/avif']) assert.equal(selectComposerFiles([],[{name:`photo.${type.split('/')[1]}`,type,size:100}],DEFAULT_ASSET_LIMITS).accepted.length,1);
});

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
