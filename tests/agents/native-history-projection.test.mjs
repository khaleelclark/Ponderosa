// Deferred closed-boundary checks, written only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNativeHistory,projectNativeRewind } from '../../apps/server/dist/native-history-projection.js';
test('provider getters and unexpected fields never become history authority',()=>{
  let touched=false;
  assert.throws(()=>projectNativeHistory({get sessionId(){touched=true;return 's';}}));
  assert.equal(touched,false);
  assert.throws(()=>projectNativeRewind({sessionId:'s',messageId:'m',dryRun:false,outcome:'completed',canRewind:true,sourceWork:'completed'}));
  assert.throws(()=>projectNativeHistory({sessionId:'s',fileRewindSupported:true,transcriptForkSupported:true,checkpoints:[{sessionId:'other',messageId:'m'}],forkPoints:[]}));
});
