import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../../apps/web/src/components/contextRecoveryStorage.ts',import.meta.url),'utf8');
function fixture(storage){
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,localStorage:storage,Error});
 return exports;
}
test('recovery needs durable exact key write/readback before mutation',()=>{
 const entries=new Map(),f=fixture({getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value)});
 assert.equal(f.readRecoveryKey('agent').key,undefined);f.writeRecoveryKey('agent','original');
 assert.equal(f.readRecoveryKey('agent').key,'original');f.writeRecoveryKey('agent','');
 assert.equal(f.readRecoveryKey('agent').key,undefined);
});
test('denied storage reads and quota/readback failures never masquerade as saved identities',()=>{
 const denied=fixture({getItem(){throw Error('denied')},setItem(){throw Error('quota')}});
 assert.match(denied.readRecoveryKey('agent').error,/unavailable/);
 assert.throws(()=>denied.writeRecoveryKey('agent','original'),/No recovery was requested/);
 const mismatch=fixture({getItem(){return null},setItem(){}});
 assert.throws(()=>mismatch.writeRecoveryKey('agent','original'),/verified/);
 assert.throws(()=>mismatch.writeRecoveryKey('agent',''),/Dismissal returned/);
 assert.equal(mismatch.readRecoveryKey('agent').key,undefined);
});
test('recovery persists the same operation key with its frozen boundary and product scope',()=>{
 const entries=new Map(),f=fixture({getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value)});
 const boundary={providerSessionId:'session',sourceRunId:'source',toolContractHash:'a'.repeat(64),sourceFence:7};
 f.writeRecoveryKey('agent','same-key',{boundary,productPath:'/api/branches/engine/agents/agent/context-recoveries'});
 const restored=f.readRecoveryKey('agent');assert.equal(restored.key,'same-key');assert.equal(restored.boundary.sourceFence,7);assert.match(restored.productPath,/branches/);
 entries.set('agent','{"key":"same-key","boundary":{}}');assert.match(f.readRecoveryKey('agent').error,/unavailable/);
});
