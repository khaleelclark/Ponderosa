import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import '../shared/web-typescript-loader.mjs';
const {chatInstructionsResolution}=await import('../../apps/web/src/components/ChatInstructionsImportChoice.tsx');

test('import instruction review hashes exact UTF-8 with or without browser Web Crypto',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto'),native=globalThis.crypto;
 const texts=['','Destination 🌲 instructions\nunchanged','a'.repeat(257),'unpaired \ud800 and \u0000'];
 try{
  for(const value of [native,{},undefined]){
   Object.defineProperty(globalThis,'crypto',{value,configurable:true});
   for(const text of texts){
    const expected=createHash('sha256').update(text,'utf8').digest('hex');
    assert.deepEqual(await chatInstructionsResolution('keep_destination',text),{action:'keep_destination',expectedDestinationSha256:expected});
    assert.deepEqual(await chatInstructionsResolution('use_source',text),{action:'use_source',expectedDestinationSha256:expected});
    assert.equal(await chatInstructionsResolution('',text),undefined);
   }
  }
 }finally{if(original)Object.defineProperty(globalThis,'crypto',original);else delete globalThis.crypto;}
});
