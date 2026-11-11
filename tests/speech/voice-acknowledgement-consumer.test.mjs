// Deferred source regression; not executed for this source-only handoff.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {VoiceReplyBuffers} from '../../apps/web/src/components/speech/voiceReplyStream.ts';
const ack={projectId:'project',conversationId:'chat',messageId:'input',agentId:'agent',runId:'run',fence:4,steeringInjectionId:'steering',streamId:'ack',sequence:0,text:'',state:'open',purpose:'acknowledgement',acceptedAt:'now',publication:{kind:'message',intent:'direct_to_user'}};
const receipt={...ack,state:'streaming',sequence:1,itemId:'native-operation',providerTurnId:'run',text:'I will inspect the file'};
const answer={...ack,purpose:'answer',streamId:'answer',sequence:1,state:'streaming',itemId:'final-item',providerTurnId:'run',text:'The file contains three entries. '};
test('native acknowledgement speaks once, including its short tail, without becoming the answer prefix',()=>{
 const buffers=new VoiceReplyBuffers();
 assert.deepEqual(buffers.accept(ack).phrases,[]);
 assert.deepEqual(buffers.accept(receipt),{purpose:'acknowledgement',phrases:['I will inspect the file']});
 assert.deepEqual(buffers.accept(receipt).phrases,[]);
 assert.deepEqual(buffers.accept({...receipt,sequence:2}).phrases,[]);
 assert.equal(buffers.answer.spokenPrefix,'');
 assert.deepEqual(buffers.accept(answer).phrases,['The file contains three entries.']);
 assert.deepEqual(buffers.accept({...receipt,sequence:3}).phrases,[]);
 assert.deepEqual(buffers.answer.finish('The file contains three entries. Verified.'),['Verified.']);
});
test('changed receipt, Run/fence/steering/publication and second answer stream fail closed',()=>{
 for(const patch of [{itemId:'foreign'},{providerTurnId:'foreign'},{text:'Changed text'},{fence:5},{steeringInjectionId:'new'},{runId:'other'},{publication:{kind:'message',intent:'broadcast'}}]){
  const buffers=new VoiceReplyBuffers();buffers.accept(receipt);
  assert.throws(()=>buffers.accept({...receipt,sequence:2,...patch}));
 }
 const buffers=new VoiceReplyBuffers();buffers.accept(receipt);buffers.accept(answer);
 assert.throws(()=>buffers.accept({...answer,streamId:'replacement',sequence:2}));
 assert.throws(()=>buffers.accept({...receipt,streamId:'second-ack',sequence:3}));
});
test('reconnect may miss acknowledgement receipt; final stream still has its own prefix',()=>{
 const buffers=new VoiceReplyBuffers();buffers.accept(ack);
 assert.deepEqual(buffers.accept(answer).phrases,['The file contains three entries.']);
 assert.deepEqual(buffers.accept(receipt).phrases,[]);
});
