import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/nativeDataPreview.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,Blob,atob,Uint8Array,DataView,TextDecoder,DecompressionStream,Error});
const principalAcl=()=>{const bytes=Buffer.alloc(12);bytes.writeUInt32LE(2,0);bytes.writeUInt16LE(2,4);bytes.writeUInt16LE(4,6);bytes.writeUInt32LE(2000,8);return bytes.toString('base64');};
const metadata=(qualifier='linux:source')=>({version:1,sourceQualifier:qualifier,nodes:[{ownerId:'1000',groupId:'100',accessAclBase64:principalAcl(),defaultAclBase64:null}],persistentNodes:[{kind:'fifo',ownerId:'1000',groupId:'100'}]});
const node=(manifest,gzip=false,ref='root')=>({ref,workingRootRef:ref,workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:'original'}],artifacts:[{ref:'original',dataBase64:(gzip?gzipSync(Buffer.from(JSON.stringify(manifest))):Buffer.from(JSON.stringify(manifest))).toString('base64'),...(gzip?{dataEncoding:'gzip'}:{})}]});
test('native summary decodes compressed originals and maps owners, named ACL principals and captured roots',async()=>{
 const manifest={version:1,activation:'inert_review_only',git:{version:1},providerFiles:[{path:'.claude/settings.json'}],filesystemMetadata:metadata(),associationReview:[{capture:{roots:[{rootRef:'root',sourcePath:'/old/root'}]}}]};
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
