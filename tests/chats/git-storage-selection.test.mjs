import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {gitStorageSelectionError} from '../../apps/web/src/components/gitStorageSelections.ts';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript');
const binding={id:'mapping-1',worktreeAgentId:'working',storageAgentId:'storage',relativePath:'.git',role:'common'},agents=new Set(['working','storage']);
test('mapped Git export accepts selected roots and refuses escaping, missing or duplicate associations',()=>{
 assert.equal(gitStorageSelectionError([binding],agents),undefined);
 assert.equal(gitStorageSelectionError([{...binding,relativePath:'.'}],agents),undefined);
 for(const relativePath of ['/outside','../outside','folder/../outside','folder//git','folder\\\\git','C:git'])assert.match(gitStorageSelectionError([{...binding,relativePath}],agents),/relative Git folder/);
 assert.match(gitStorageSelectionError([{...binding,storageAgentId:'not-included'}],agents),/included Agents/);
 assert.match(gitStorageSelectionError([binding,{...binding,id:'mapping-2'}],agents),/distinct/);
 assert.equal(gitStorageSelectionError([{...binding,role:'module'},{...binding,id:'module-2',role:'module',relativePath:'modules/second'}],agents),undefined);
});
test('all real Agent export clients preserve the complete explicit Git binding array',async()=>{
 const exported={},requests=[];
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  exports:exported,require:()=>({productApiPath:path=>path,waitForBackgroundCooldown:async()=>{}}),URL,URLSearchParams,Headers,Map,Set,Error,fetch:async path=>{requests.push(String(path));return new Response('{}',{status:200,headers:{'content-type':'application/json'}});}
 });
 const settings={git:true,harness:false,source:'live'};
 const args=['working','full',true,[],false,true,settings,[binding]];
 await exported.realApi.exportAgent(...args);await exported.realApi.exportAgentText(...args);
 const download=exported.realApi.agentExportDownloadUrl(...args);
 for(const path of [...requests,download]){const url=new URL(path,'http://fixture.local');assert.deepEqual(JSON.parse(url.searchParams.get('gitStorageBindings')),[binding]);assert.equal(url.searchParams.get('organizationWorkingFolders'),'true');}
 assert.equal(new URL(exported.realApi.agentExportDownloadUrl('working','template'),'http://fixture.local').searchParams.has('gitStorageBindings'),false);
});
