import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileCapabilityDraft} from '../src/components/capabilityPolicyDraft.js';

test('dirty capability drafts keep the revision they were based on',()=>{
 const edited={restricted:['shell'],baseline:[],revision:1};
 const current={revision:2,restrictedCapabilityIds:['network']};
 assert.deepEqual(reconcileCapabilityDraft(edited,current),edited);
 assert.deepEqual(reconcileCapabilityDraft({restricted:[],baseline:[],revision:1},current),{restricted:['network'],baseline:['network'],revision:2});
});
