import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeTextSize} from '../../apps/web/src/textSize.ts';

test('stored appearance accepts supported readable sizes and recovers malformed storage',()=>{
 for(const value of [100,115,130,150,175,200])assert.equal(normalizeTextSize(String(value)),value);
 for(const value of [null,undefined,'',0,-50,Infinity,'calc(100% * 2)','broken',300])assert.equal(normalizeTextSize(value),100);
});
