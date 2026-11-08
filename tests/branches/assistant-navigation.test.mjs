import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {parseBranchRoute,branchRoutePath,assistantReturnPath,retainedBranchDrafts}=await import('../../apps/web/src/branchesRouting.ts');
const {setStandaloneWorkspaceOwner,productWorkspacePath}=await import('../../apps/web/src/api/productScope.ts');

test('Assistant is a main-workspace route with an exact safe return to the current Core Chat',()=>{
 const source='/projects/project/chats/chat?focusMessage=message#reply';
 const route=parseBranchRoute('?assistant=1&returnTo='+encodeURIComponent(source));
 assert.equal(route.assistant,true);assert.equal(route.assistantReturnTo,source);
 assert.deepEqual(parseBranchRoute(branchRoutePath(route).split('?')[1]),route);
 for(const invalid of ['https://outside.invalid/','//outside.invalid/','/\\outside.invalid/','/assistant','/apps/agent','/branches?assistant=1'])assert.equal(assistantReturnPath(invalid),undefined,invalid);
 assert.equal(retainedBranchDrafts({tab:'workflow',branchId:'draft'},{tab:'chats',assistant:true}).workflow,false,'Opening Assistant uses the existing workflow save/discard guard');
});

test('Assistant file links leave the Assistant surface with exact canonical Branch and Chat owner',()=>{
 const previous=globalThis.window;
 try{
  globalThis.window={location:{pathname:'/branches',search:'?assistant=1&returnTo=%2Fhome'}};
  setStandaloneWorkspaceOwner({branchId:'assistant-branch',chatId:'assistant-chat'});
  const nested='/projects/project/files?agentId=speaker&path=report.md#summary';
  const target=new URL(productWorkspacePath(nested),'http://fixture.invalid');
  assert.equal(target.pathname,'/branches');assert.equal(target.searchParams.get('assistant'),null);
  assert.equal(target.searchParams.get('returnTo'),null);
  assert.equal(target.searchParams.get('branch'),'assistant-branch');assert.equal(target.searchParams.get('chat'),'assistant-chat');
  assert.equal(target.searchParams.get('workspace'),nested);
 }finally{setStandaloneWorkspaceOwner(undefined);if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
