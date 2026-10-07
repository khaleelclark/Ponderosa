import assert from 'node:assert/strict';
import test from 'node:test';
import {splitTriggerGlobText} from '../src/components/triggerSourceValues.js';

test('filesystem trigger globs preserve commas inside each line',()=>{
 assert.deepEqual(splitTriggerGlobText('**/*.{ts,tsx}\nassets/name,with-comma.json\n'),['**/*.{ts,tsx}','assets/name,with-comma.json']);
});
