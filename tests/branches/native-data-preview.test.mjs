import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),exports={};
const pathChoices={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/portablePathChoices.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:pathChoices});
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/nativeDataPreview.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{if(name==='./portablePathChoices')return pathChoices;throw Error('Unexpected preview dependency '+name);},Blob,atob,Uint8Array,DataView,TextDecoder,DecompressionStream,Error});
const principalAcl=()=>{const bytes=Buffer.alloc(12);bytes.writeUInt32LE(2,0);bytes.writeUInt16LE(2,4);bytes.writeUInt16LE(4,6);bytes.writeUInt32LE(2000,8);return bytes.toString('base64');};
const metadata=(qualifier='linux:source')=>({version:1,sourceQualifier:qualifier,nodes:[{ownerId:'1000',groupId:'100',accessAclBase64:principalAcl(),defaultAclBase64:null}],persistentNodes:[{kind:'fifo',ownerId:'1000',groupId:'100'}]});
const node=(manifest,gzip=false,ref='root')=>({ref,workingRootRef:ref,workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:'original'}],artifacts:[{ref:'original',dataBase64:(gzip?gzipSync(Buffer.from(JSON.stringify(manifest))):Buffer.from(JSON.stringify(manifest))).toString('base64'),...(gzip?{dataEncoding:'gzip'}:{})}]});
test('native summary decodes compressed originals and maps owners, named ACL principals and captured roots',async()=>{
 const manifest={version:1,activation:'inert_review_only',selection:{git:true,harness:true},git:{version:1},providerFiles:[{path:'.claude/settings.json'}],filesystemMetadata:metadata(),associationReview:[{capture:{roots:[{rootRef:'root',sourcePath:'/old/root'}]}}]};
 const summary=await exports.nativeDataPreview([node(manifest,true)]);
 assert.equal(summary.git,true);assert.equal(summary.harness,true);assert.equal(summary.metadata.fifoCount,1);assert.equal(summary.metadata.unsupportedNodes,0);
 assert.deepEqual(JSON.parse(JSON.stringify(summary.metadata.principals)),[{kind:'group',sourceId:'100'},{kind:'user',sourceId:'1000'},{kind:'user',sourceId:'2000'}]);
 assert.deepEqual(JSON.parse(JSON.stringify(summary.sourceRoots)),[{rootRef:'root',sourcePath:'/old/root'}]);
});
test('unsupported/mixed source metadata remains an explicit warning and never produces activation-ready metadata',async()=>{
 const make=qualifier=>({version:1,activation:'inert_review_only',filesystemMetadata:metadata(qualifier)});
 const mixed=await exports.nativeDataPreview([node(make('one')),node(make('two'),false,'other')]);assert.equal(mixed.metadata,undefined);assert.match(mixed.warning,/different source owner namespaces/);
 const invalid=await exports.nativeDataPreview([node({version:99,activation:'inert_review_only'})]);assert.equal(invalid.metadata,undefined);assert.match(invalid.warning,/unsupported/);
});

test('native choices require canonical path maps and explicit complete noncollapsing permission maps',()=>{
 const component=exports;
 const summary={git:true,harness:false,sourceRoots:[],metadata:{sourceQualifier:'source',rootRefs:['root'],principals:[{kind:'user',sourceId:'1000'},{kind:'user',sourceId:'2000'}],fifoCount:1,unsupportedNodes:0}};
 const metadata={sourceQualifier:'source',destinationQualifier:'destination',rootRefs:['root'],replaceInheritedUserAndPosixAcl:true,fifo:true,principalMappings:[{sourceQualifier:'source',kind:'user',sourceId:'1000',destinationId:'1000'},{sourceQualifier:'source',kind:'user',sourceId:'2000',destinationId:'2000'}]};
 assert.equal(component.nativeImportChoiceError({reviewedMetadataActivation:metadata},summary),undefined);
 assert.match(component.nativeImportChoiceError({reviewedMetadataActivation:{...metadata,fifo:false}},summary),/confirm/);
 assert.match(component.nativeImportChoiceError({reviewedMetadataActivation:{...metadata,principalMappings:metadata.principalMappings.map(mapping=>({...mapping,destinationId:'1000'}))}},summary),/distinct/);
 assert.match(component.nativeImportChoiceError({reviewedUserDataActivation:{git:true,harness:false,gitPathMappings:[{source:'/old/../other',destination:'/new'}]}},summary),/Map/);
 assert.equal(component.nativeImportChoiceError({reviewedUserDataActivation:{git:true,harness:false,gitPathMappings:[{source:'/old/root',destination:'/new/root'}]}},summary),undefined);
});

test('Git-only originals never offer harness activation and explicit harness selection is required',async()=>{
 const make=selection=>({version:1,activation:'inert_review_only',selection,git:{version:1},providerFiles:[{path:'.git/hooks/post-checkout'},{path:'.git/info/exclude'}],providerDirectories:[]});
 const onlyGit=await exports.nativeDataPreview([node(make({git:true,harness:false}))]);assert.equal(onlyGit.git,true);assert.equal(onlyGit.harness,false);
 const claimedHarness=await exports.nativeDataPreview([node(make({git:true,harness:true}))]);assert.equal(claimedHarness.harness,false);
 const absentSelection=await exports.nativeDataPreview([node({...make(undefined),providerFiles:[{path:'.claude/settings.json'}]})]);assert.equal(absentSelection.harness,false);
});
test('grouped metadata uses only canonical metadata-bearing roots and is unavailable until review',()=>{
 const summary={git:false,harness:false,sourceRoots:[],metadata:{sourceQualifier:'source',rootRefs:['raw-owner'],principals:[],fifoCount:0,unsupportedNodes:0}};
 const selected=exports.nativePreviewForGroupedRoots(summary,['canonical-metadata']);
 assert.deepEqual([...selected.metadata.rootRefs],['canonical-metadata']);assert.equal(selected.metadata.rootRefs.includes('canonical-storage-only'),false);
 const pending=exports.nativePreviewForGroupedRoots(summary,undefined);assert.deepEqual([...pending.metadata.rootRefs],[]);assert.match(pending.warning,/Review/);
 assert.deepEqual(summary.metadata.rootRefs,['raw-owner']);
});

test('Branch native preview follows package object replacement even when export labels and timestamps match',async()=>{
 const hooks=[],dependencies=[],cleanups=[],effects=[];let index=0;
 const react={useState(initial){const slot=index++;if(!(slot in hooks))hooks[slot]=initial;return [hooks[slot],value=>{hooks[slot]=value}];},useEffect(effect,next){const slot=index++;if(!dependencies[slot]||next.some((value,i)=>value!==dependencies[slot][i])){dependencies[slot]=next;effects.push(()=>{cleanups[slot]?.();cleanups[slot]=effect();});}}};
 const native={nativeDataPreview:async nodes=>({git:false,harness:false,sourceRoots:[],metadata:{sourceQualifier:nodes[0].source,rootRefs:['root'],principals:[],fifoCount:0,unsupportedNodes:0}}),nativePreviewForGroupedRoots:exports.nativePreviewForGroupedRoots};
 const component={},source=readFileSync(new URL('../../apps/web/src/components/branches/BranchImportFiles.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText+'\nexports.reviewNative=BranchNativeData;',{
  exports:component,require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}:name==='../nativeDataPreview'?native:name==='../NativePortableDataChoices'?{NativePortableImportChoices:'native-controls'}:{}
 });
 const first={exportedAt:'same',sourceLabel:'same',rootRef:'same',agents:[{source:'old'}]},second={...first,agents:[{source:'new'}]};
 const render=pkg=>{index=0;const node=component.reviewNative({packages:[pkg],sourceIdentity:pkg,grouped:false,value:{},onChange(){},disabled:false});for(const effect of effects.splice(0))effect();return node;};
 assert.equal(render(first).props.summary,undefined);await new Promise(setImmediate);
 assert.equal(render(first).props.summary.metadata.sourceQualifier,'old');
 assert.equal(render(second).props.summary,undefined,'old permissions disappear in the replacement render');
 await new Promise(setImmediate);assert.equal(render(second).props.summary.metadata.sourceQualifier,'new');
 for(const cleanup of cleanups)cleanup?.();
});


test('native mapping choices accept Windows drive and UNC provenance with current-host destination syntax',()=>{
 const choose=(source,destination)=>({reviewedUserDataActivation:{git:true,harness:false,gitPathMappings:[{source,destination}]}});
 assert.equal(exports.nativeImportChoiceError(choose('C:/Projects/Repo','/new/repo')),undefined);
 assert.equal(exports.nativeImportChoiceError(choose('//server/share/config','/new/config')),undefined);
 assert.equal(exports.nativeImportChoiceError(choose('//server/share/','/new/share')),undefined);
 assert.equal(exports.nativeImportChoiceError(choose('/old/repo',String.raw`C:\Recovery\Repo`)),undefined);
 assert.equal(pathChoices.sourcePathInput(String.raw`c:\Projects\Repo`),'C:/Projects/Repo');
 assert.equal(pathChoices.sourcePathInput(String.raw`\\server\share\config`),'//server/share/config');
 for(const source of ['C:relative','C:/old/../other','//server','//server/../folder',String.raw`\\?\C:\old`])assert.match(exports.nativeImportChoiceError(choose(source,'/new/repo')),/Map/);
 for(const destination of ['relative','C:relative','/new/../other','//server'])assert.match(exports.nativeImportChoiceError(choose('C:/old',destination)),/Map/);
});
