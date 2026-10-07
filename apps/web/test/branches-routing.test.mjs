import assert from 'node:assert/strict';
import test from 'node:test';
import {branchRoutePath,parseBranchRoute,retainedBranchDrafts} from '../src/branchesRouting.js';

test('same-Branch inspection retains editor drafts, global panels and other Branches do not',()=>{
 const workflow={branchId:'b',tab:'workflow'};
 assert.deepEqual(retainedBranchDrafts(workflow,{branchId:'b',tab:'executions',executionId:'run'}),{workflow:true,editor:true});
 assert.deepEqual(retainedBranchDrafts(workflow,{branchId:'b',tab:'settings',global:'profile'}),{workflow:true,editor:false});
 assert.deepEqual(retainedBranchDrafts(workflow,{branchId:'other',tab:'workflow'}),{workflow:false,editor:false});
});

test('legacy Branch and Execution links keep their targets',()=>{
 assert.deepEqual(parseBranchRoute('?branch=b'),{branchId:'b',tab:'workflow'});
 assert.deepEqual(parseBranchRoute('?execution=e'),{executionId:'e',tab:'executions'});
});
test('Branch tabs and full workspace destinations survive a shared URL',()=>{
 for(const workspace of [
  {kind:'agent',projectId:'p/one',agentId:'a/α',view:'technical',technicalFocusId:'request:one'},
  {kind:'conversation',projectId:'p',conversationId:'c',view:'collaboration',focusMessageId:'event:1'},
  {kind:'browser',projectId:'p',agentId:'a',runId:'r',conversationId:'c'},
 ]){
  const route={branchId:'workflow/α',tab:'chats',chatId:'c',workspace};
  const parsed=parseBranchRoute(new URL(branchRoutePath(route),'http://localhost').search);
  assert.equal(parsed.branchId,route.branchId);assert.equal(parsed.tab,'chats');assert.equal(parsed.chatId,'c');
  assert.equal(parsed.workspace.kind,workspace.kind);assert.equal(parsed.workspace.projectId,workspace.projectId);
  for(const key of ['agentId','focusMessageId','technicalFocusId','runId'])if(key in workspace)assert.equal(parsed.workspace[key],workspace[key]);
 }
});
test('global settings and execution filters are durable; unrelated paths are rejected',()=>{
 const route={tab:'executions',branchId:'b',executionId:'e',executionFilter:'failed',global:'profile'};
 assert.deepEqual(parseBranchRoute(new URL(branchRoutePath(route),'http://localhost').search),route);
 assert.deepEqual(parseBranchRoute('?tab=garbage&settings=unknown&workspace=https://evil.test'),{tab:'workflow'});
 assert.equal(parseBranchRoute('?workspace=%2Fprojects%2F%25%2Fagents%2Fa').workspace,undefined);
});
