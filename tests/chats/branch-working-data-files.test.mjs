import '../shared/web-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {branchWorkingDataDerivedChat,branchWorkingDataFileError} from '../../apps/web/src/components/branches/branchWorkingDataFiles.ts';
const key=ref=>JSON.stringify(['chat-'+ref,ref]);
const pkg={chats:[{ref:'chat-a',agents:[{ref:'a'}]},{ref:'chat-b',agents:[{ref:'b'}]}],workingData:{package:{agents:[{ref:'source-a',workingRootRef:'parent',workingCopyMode:'shared',workingFolder:{}},{ref:'source-b',workingRootRef:'child',workingCopyMode:'shared',workingFolder:{}}],workingRootNesting:[{parentRootRef:'parent',childRootRef:'child',path:'modules/child'}]},owners:{'source-a':{chatRef:'chat-a',agentRef:'a'},'source-b':{chatRef:'chat-b',agentRef:'b'}}}};
test('carrier UI accepts only exact declared nesting, complete roots and new owners',()=>{
 const choices={[key('a')]:{workingRootDestinations:{parent:'/recovery/new'}},[key('b')]:{workingRootDestinations:{child:'/recovery/new/modules/child'}}};
 assert.equal(branchWorkingDataFileError(pkg,choices,new Set()),undefined);
 assert.match(branchWorkingDataFileError(pkg,choices,new Set([key('a')])),/new Agents/);
 assert.match(branchWorkingDataFileError(pkg,{[key('a')]:choices[key('a')]},new Set()),/every captured root/);
 assert.match(branchWorkingDataFileError(pkg,{...choices,[key('b')]:{workingRootDestinations:{child:'/unrelated/new'}}},new Set()),/captured relative location/);
 assert.deepEqual(branchWorkingDataDerivedChat(pkg,'chat-b'),{kind:'contained',sourceChatRef:'chat-a',path:'modules/child'});
});
test('shared source root aliases use the first canonical Chat instead of asking for another folder',()=>{
 const aliases=structuredClone(pkg);aliases.workingData.package.agents[1].workingRootRef='parent';delete aliases.workingData.package.workingRootNesting;
 assert.deepEqual(branchWorkingDataDerivedChat(aliases,'chat-b'),{kind:'shared',sourceChatRef:'chat-a'});
});
