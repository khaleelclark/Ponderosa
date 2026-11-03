import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {readAgentPackageClipboard} from '../../apps/web/src/agent-package-clipboard.ts';
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

test('all real Agent export clients preserve complete Git bindings in POST bodies and native downloads',async()=>{
 const exported={},requests=[],anchors=[];
 const document={createElement:()=>({dataset:{},style:{},click(){anchors.push(this)},remove(){}}),body:{append(){}}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  exports:exported,require:()=>({productApiPath:path=>path,readAgentPackageClipboard,waitForBackgroundCooldown:async()=>{},createClientId:()=> 'fixture-request-'+requests.length}),URL,URLSearchParams,Headers,Map,Set,Error,
  window:{location:{href:'http://fixture.local/',origin:'http://fixture.local'}},document,
  fetch:async(path,init)=>{if(!init?.body)return new Response('{"schema":"ponderosa.agent-package.v1"}',{status:200,headers:{'content-type':'application/json'}});requests.push({path:String(path),init});const input=JSON.parse(init.body);return new Response(JSON.stringify(input.download?{downloadUrl:'/api/package-exports/'+'a'.repeat(48),expiresAt:new Date(Date.now()+60000).toISOString(),byteLength:123}:{}),{status:200,headers:{'content-type':'application/json'}});}
 });
 const settings={git:true,harness:false,source:'live'},args=['working','full',true,[],false,true,settings,[binding]];
 await exported.realApi.exportAgent(...args);await exported.realApi.exportAgentText(...args);
 await exported.realApi.downloadAgentPackage('working','complete.json','full',true,[],false,true,settings,[binding]);
 for(const request of requests){assert.equal(request.init.method,'POST');assert.equal(new URL(request.path,'http://fixture.local').search,'');const body=JSON.parse(request.init.body);assert.deepEqual(body.gitStorageBindings,[binding]);assert.equal(body.organizationWorkingFolders,true);}
 assert.equal(anchors.length,1);assert.equal(anchors[0].download,'complete.json');assert.equal(anchors[0].href,'http://fixture.local/api/package-exports/'+'a'.repeat(48));
 await exported.realApi.downloadAgentPackage('working','template.json','template');
 assert.equal(Object.hasOwn(JSON.parse(requests.at(-1).init.body),'gitStorageBindings'),false);
});
