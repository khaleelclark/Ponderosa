import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {branchPackageTarget,branchPackageFileError,mergeBranchImportResults} from '../../apps/web/src/components/branches/branchPackageFiles.ts';
const node=(ref,mode='shared')=>({ref,workingCopyMode:mode,workingRootRef:ref,workingFolder:{directories:[],excludedPaths:[]}});
const pkg={chats:[{ref:'chat',agents:[{ref:'root',definition:{agents:[node('folder')]}},{ref:'child',managerRef:'root',definition:{agents:[node('copy','separate_git')]}}]}]};
const root=branchPackageTarget('chat','root'),child=branchPackageTarget('chat','child');
const destinations={[root]:{workingRootDestinations:{folder:'/recovery/root'}},[child]:{workingRootDestinations:{copy:'/recovery/copy'}}};
test('workflow target identities and complete recovery mappings are exact',()=>{
 assert.notEqual(branchPackageTarget('a,b','c'),branchPackageTarget('a','b,c'));
 assert.equal(branchPackageFileError(pkg,destinations,new Set()),undefined);
 assert.match(branchPackageFileError(pkg,{},new Set()),/every included working root/);
 assert.match(branchPackageFileError(pkg,{...destinations,[child]:{workingRootDestinations:{copy:'/recovery/root/nested'}}},new Set()),/cannot nest/);
 assert.match(branchPackageFileError(pkg,destinations,new Set([root])),/Existing Agents/);
});
test('existing live activation preserves Separate-only admission',()=>{
 assert.equal(branchPackageFileError(pkg,{[child]:{...destinations[child],workingFilesActivation:{}}},new Set([root])),undefined);
 assert.match(branchPackageFileError(pkg,{[root]:{...destinations[root],workingFilesActivation:{}}},new Set([child])),/Shared live activation/);
});
test('group receipts deduplicate Settings without fabricating Agent identities',()=>{
 const receipt={workingRoots:[{ref:'shared',destination:'/recovery/shared',agentIds:['new-root','new-child']}],liveWorkingRoots:[{ref:'shared',path:'/managed/new',agentIds:['new-root','new-child']}],accessSettingsToReview:[{agentId:'new-child',conversationId:'new-chat',source:{restrictedCapabilityIds:[],readGlobalMemory:true}}]};
 const merged=mergeBranchImportResults({root:receipt,child:structuredClone(receipt)});
 assert.equal(merged.workingRoots.length,1);assert.equal(merged.liveWorkingRoots.length,1);assert.equal(merged.accessSettingsToReview.length,1);
 assert.equal(merged.accessSettingsToReview[0].agentId,'new-child');
 assert.throws(()=>mergeBranchImportResults({root:receipt,child:{accessSettingsToReview:[{...receipt.accessSettingsToReview[0],source:{restrictedCapabilityIds:[],readGlobalMemory:false}}]}}),/Conflicting/);
});
test('group discovery accepts only root-owned choices then requires canonical composed mappings',()=>{
 const discovery={[root]:{workingFilesDestination:'/recovery/discovery',newManagedChatFolderName:'Restored',workingFilesActivation:{}}};
 assert.equal(branchPackageFileError(pkg,discovery,new Set()),undefined);
 const inventory={[root]:['composed-shared','composed-separate']};
 assert.match(branchPackageFileError(pkg,discovery,new Set(),inventory),/discard previous root mappings/);
 const grouped={[root]:{newManagedChatFolderName:'Restored',workingFilesActivation:{},workingRootDestinations:{'composed-shared':'/recovery/shared','composed-separate':'/recovery/separate'}}};
 assert.equal(branchPackageFileError(pkg,grouped,new Set(),inventory),undefined);
 assert.match(branchPackageFileError(pkg,{...grouped,[child]:destinations[child]},new Set(),inventory),/Grouped children/);
 assert.match(branchPackageFileError(pkg,grouped,new Set([child]),inventory),/Existing Agents/);
 assert.match(branchPackageFileError(pkg,grouped,new Set(),{[root]:['changed-ref']}),/discard previous root mappings/);
 const forest=structuredClone(pkg);delete forest.chats[0].agents[1].managerRef;
 assert.equal(branchPackageFileError(forest,grouped,new Set(),inventory),undefined);
});
