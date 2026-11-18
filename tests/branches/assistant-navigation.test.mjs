import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
const {parseBranchRoute,branchRoutePath,retainedBranchDrafts}=await import('../../apps/web/src/branchesRouting.ts');
const {assistantReturnPath,integratedAssistantPath}=await import('../../apps/web/src/assistantRouting.ts');
const {parseRoute}=await import('../../apps/web/src/routing.ts');
const {routeToPath}=await import('../../apps/web/src/routeRegistry.ts');
const {setStandaloneProductScope,setStandaloneWorkspaceOwner,productWorkspacePath,isOutputAppPath,currentProductScope}=await import('../../apps/web/src/api/productScope.ts');

test('Assistant belongs to the Ponderosa route with an exact safe return to the current Core Chat',()=>{
 const source='/projects/project/chats/chat?message=message#reply';
 const route=parseRoute('/assistant','?returnTo='+encodeURIComponent(source));
 assert.equal(route.kind,'assistant');assert.equal(route.returnTo,source);
 assert.equal(routeToPath(route),'/assistant?returnTo='+encodeURIComponent(source));
 for(const invalid of ['https://outside.invalid/','//outside.invalid/','/\\outside.invalid/','/assistant','/apps/agent','/branches?assistant=1'])assert.equal(assistantReturnPath(invalid),undefined,invalid);
 assert.equal(retainedBranchDrafts({tab:'workflow',branchId:'draft'},{tab:'workflow'}).workflow,false,'Leaving a Branch still uses its existing save/discard guard');
});

test('old Branches Assistant links canonicalize to Ponderosa before product scope selection',()=>{
 const source='/projects/project/chats/chat?message=message#reply';
 assert.equal(integratedAssistantPath('/branches','?assistant=1'),'/assistant');
 assert.equal(integratedAssistantPath('/branches','?assistant=1&returnTo='+encodeURIComponent(source)),'/assistant?returnTo='+encodeURIComponent(source));
 for(const unsafe of ['//outside.invalid/','https://outside.invalid/','/apps/agent','/assistant'])assert.equal(integratedAssistantPath('/branches','?assistant=1&returnTo='+encodeURIComponent(unsafe)),'/assistant');
 assert.equal(integratedAssistantPath('/branches','?assistant=1&embedded=1&branch=wrong&workspace=wrong'),'/assistant','legacy entry does not import Branch scope flags');
 assert.equal(integratedAssistantPath('/assistant',''),undefined);
 assert.equal(parseBranchRoute('?assistant=1').assistant,undefined);
 assert.equal(branchRoutePath(parseBranchRoute('?assistant=1')),'/branches');
 assert.equal(isOutputAppPath('/assistant'),false);
 assert.equal(isOutputAppPath('/apps/designated-agent'),true);
});

test('Assistant resource links identify the exact canonical Branch and Chat without opening the old Assistant shell',()=>{
 const previous=globalThis.window;
 try{
  globalThis.window={location:{pathname:'/assistant',search:'?returnTo=%2Fhome'}};
  assert.equal(currentProductScope(),'dev','Core shell stays in the Core API scope');
  setStandaloneProductScope('branches');setStandaloneWorkspaceOwner({branchId:'assistant-branch',chatId:'assistant-chat'});
  const nested='/projects/project/files?agentId=speaker&path=report.md#summary';
  const target=new URL(productWorkspacePath(nested),'http://fixture.invalid');
  assert.equal(target.pathname,'/branches');assert.equal(target.searchParams.get('assistant'),null);
  assert.equal(target.searchParams.get('returnTo'),null);
  assert.equal(target.searchParams.get('branch'),'assistant-branch');
  assert.equal(target.searchParams.get('chat'),'assistant-chat');
  assert.equal(target.searchParams.get('workspace'),nested);
 }finally{setStandaloneWorkspaceOwner(undefined);setStandaloneProductScope(undefined);if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
