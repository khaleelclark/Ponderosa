import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
const text=readFileSync(new URL('../../apps/web/src/components/GlobalMemoryTransfer.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const row=(id,text)=>({id,text,metadata:{deprecated:false},stamp:{principal:'source',provenance:{runId:'historical'}}});
const snapshot={schema:'ponderosa.selected-global-memory.v1',sourcePrincipal:'source',signature:'fixture',chunks:[row('fact','Selected content'),row('outside','Unselected content')],conflicts:[row('conflict','Preserved conflict reasoning')]};
function harness(){
 const states=[],requests=[],downloads=[],exports={};let cursor=0,tree;
 const jsx=(type,props)=>({type,props});const ui=Object.fromEntries(['Alert','Button','Checkbox','FormControlLabel','Paper','Stack','Typography'].map(name=>[name,name]));
 // Browser fetch failures and the component share one Error realm.
 const c={exports,Blob,JSON,Error,setTimeout:fn=>fn(),URL:{createObjectURL:()=> 'owned-object-url',revokeObjectURL:()=>{}},document:{createElement:()=>({click(){downloads.push(this.download);}})},requestJson:async(path,init)=>{const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});if(c.fail)throw Error('Controlled transfer error');if(path.endsWith('/preview'))return {snapshot:{...snapshot,chunks:snapshot.chunks.filter(r=>body.selection.chunkIds.includes(r.id)),conflicts:[]},destination:{...snapshot,sourcePrincipal:'destination',chunks:[row('local','Existing destination content')],conflicts:[row('local-conflict','Existing destination disagreement')]},reviewHash:'reviewed'};if(path.endsWith('/import'))return {added:1};if(path.endsWith('/export'))return snapshot;return {snapshot,inventoryHash:'inventory'};}};
 const useState=initial=>{const index=cursor++;if(!(index in states))states[index]=initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];};
 c.require=name=>({'react':{useState},'react/jsx-runtime':{jsx,jsxs:jsx},'@mui/material':ui,'../api/real':{requestJson:(...args)=>c.requestJson(...args)},'./ConfirmationDialogs':{ConfirmDialog:'ConfirmDialog'}}[name]??assert.fail(name));vm.runInNewContext(compiled,c);
 const render=()=>{cursor=0;tree=exports.GlobalMemoryTransfer();return tree;};
 const nodes=()=>{const found=[];function walk(node){if(Array.isArray(node)){node.forEach(walk);return;}if(node&&typeof node==='object'){found.push(node);walk(node.props?.children);}}walk(tree);return found;};
 const button=label=>nodes().find(n=>n.type==='Button'&&(n.props.children===label||Array.isArray(n.props.children)&&n.props.children.includes(label)));
 const dialog=title=>nodes().find(n=>n.type==='ConfirmDialog'&&n.props.title===title);
 const choose=id=>{const label=nodes().find(n=>n.type==='FormControlLabel'&&n.props.label.endsWith(': '+id));label.props.control.props.onChange();render();};
 render();return {c,requests,downloads,render,button,dialog,choose,nodes};
}
test('actual global transfer UI selects nothing implicitly and exports only after explicit review; cancellation and retry retain intent',async()=>{
 const h=harness();assert.equal(h.requests.length,0);await h.button('Choose local records').props.onClick();h.render();assert.equal(h.button('Download selected records').props.disabled,true);h.choose('fact');
 h.button('Download selected records').props.onClick();h.render();assert.equal(h.requests.length,1);assert.equal(h.dialog('Download selected global memory').props.open,true);h.dialog('Download selected global memory').props.onCancel();h.render();assert.equal(h.downloads.length,0);assert.equal(h.requests.length,1);
 h.button('Download selected records').props.onClick();h.render();h.c.fail=true;await h.dialog('Download selected global memory').props.onConfirm();h.render();assert.equal(h.dialog('Download selected global memory').props.open,true);assert.match(h.dialog('Download selected global memory').props.error,/Controlled transfer error/);assert.equal(h.downloads.length,0);
 h.c.fail=false;await h.dialog('Download selected global memory').props.onConfirm();h.render();const req=h.requests.at(-1);assert.deepEqual(req.body,{selection:{chunkIds:['fact'],conflictIds:[]},inventoryHash:'inventory',acknowledge:true});assert.equal(h.downloads.length,1);assert.equal(h.dialog('Download selected global memory').props.open,false);
});
test('actual file import UI reviews source and preserved destination before commit; cancel performs no import',async()=>{
 const h=harness();const input=h.nodes().find(n=>n.type==='input'),file={size:100,text:async()=>JSON.stringify(snapshot)};await input.props.onChange({target:{files:[file],value:'old'}});await new Promise(resolve=>setImmediate(resolve));h.render();assert.equal(h.requests.length,0);h.choose('fact');await h.button('Review selected import').props.onClick();h.render();assert.equal(h.requests.length,1);assert.ok(h.requests[0].path.endsWith('/preview'));const d=h.dialog('Review selected global-memory import');assert.equal(d.props.open,true);const contents=JSON.stringify(d);assert.match(contents,/Selected content/);assert.doesNotMatch(contents,/Unselected content/);assert.match(contents,/Existing destination content/);assert.match(contents,/Existing destination disagreement/);d.props.onCancel();h.render();assert.equal(h.requests.length,1);
 await h.button('Review selected import').props.onClick();h.render();h.c.fail=true;await h.dialog('Review selected global-memory import').props.onConfirm();h.render();assert.equal(h.dialog('Review selected global-memory import').props.open,true);h.c.fail=false;await h.dialog('Review selected global-memory import').props.onConfirm();h.render();const req=h.requests.at(-1);assert.ok(req.path.endsWith('/import'));assert.equal(req.body.reviewHash,'reviewed');assert.equal(req.body.acknowledge,true);assert.deepEqual(req.body.selection,{chunkIds:['fact'],conflictIds:[]});assert.equal(req.body.snapshot.chunks.length,1);assert.equal(h.dialog('Review selected global-memory import').props.open,false);assert.equal(h.downloads.length,0);
});
test('actual transfer file input refuses oversize and malformed rows without request or selection',async()=>{
 const h=harness();for(const file of [{size:16*1024*1024+1,text:async()=>assert.fail('must not read oversized file')},{size:10,text:async()=>JSON.stringify({...snapshot,chunks:[null]})}]){const input=h.nodes().find(n=>n.type==='input');input.props.onChange({target:{files:[file],value:''}});await new Promise(resolve=>setImmediate(resolve));h.render();assert.equal(h.requests.length,0);assert.equal(h.button('Review selected import'),undefined);assert.ok(h.nodes().some(n=>n.type==='Alert'&&n.props.severity==='error'));}
});
test('actual transfer UI disables controls while loading and reports unavailable service without implicit import',async()=>{
 const h=harness();let release;h.c.requestJson=()=>new Promise(resolve=>{release=resolve;});const pending=h.button('Choose local records').props.onClick();h.render();assert.equal(h.button('Choose local records').props.disabled,true);assert.equal(h.button('Choose transfer file').props.disabled,true);release({snapshot,inventoryHash:'inventory'});await pending;h.render();assert.equal(h.button('Choose local records').props.disabled,false);assert.equal(h.downloads.length,0);
 assert.equal(h.c.Error,Error);const unavailable=new Error('Local memory is not configured');assert.ok(unavailable instanceof h.c.Error);h.c.requestJson=async()=>{throw unavailable;};await h.button('Choose local records').props.onClick();h.render();assert.ok(h.nodes().some(n=>n.type==='Alert'&&n.props.children==='Local memory is not configured'));assert.equal(h.downloads.length,0);
});
