import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkpointCustodyLifecycle} from '../../apps/server/dist/checkpoint-custody-lifecycle.js';
import {retainedOrphanDiscovery} from '../../apps/server/dist/retained-orphan-discovery.js';
import {lifecycleDiscoveryPage} from '../../apps/server/dist/lifecycle-discovery.js';

const fixture=t=>{const directory=mkdtempSync(path.join(tmpdir(),'retained-discovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;};
const identity=i=>i.toString(16).padStart(64,'0');

test('checkpoint evidence beyond the old thousand-item cutoff remains reachable without mutation',t=>{
 const directory=fixture(t),ids=Array.from({length:1001},(_,i)=>identity(i));
 for(const id of ids)writeFileSync(path.join(directory,`${id}.payload`),'retained original');
 // Multiple files for one capture must not duplicate its selectable identity.
 writeFileSync(path.join(directory,`${ids[0]}.json`),'{}');
 const lifecycle=checkpointCustodyLifecycle(directory,()=>({references:[],blockers:[]}));
 const found=[];let cursor;
 do{const page=lifecycle.list({limit:100,...(cursor?{cursor}:{})});assert.ok(page.items.length<=100);found.push(...page.items);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(found,ids);assert.equal(readdirSync(directory).length,1002);
 assert.equal(readFileSync(path.join(directory,`${ids.at(-1)}.payload`),'utf8'),'retained original');
 const first=lifecycle.list({limit:1});writeFileSync(path.join(directory,`${identity(1002)}.payload`),'new evidence');
 assert.throws(()=>lifecycle.list({cursor:first.nextCursor}),/changed/);
});

test('orphan staging evidence pages past a thousand and metadata drift refuses stale continuation',async t=>{
 const directory=fixture(t),names=Array.from({length:1001},(_,i)=>`orphan-${String(i).padStart(4,'0')}.payload`);
 for(const name of names)writeFileSync(path.join(directory,name),'original bytes');
 const found=[];let cursor;
 do{const page=await retainedOrphanDiscovery(directory,{limit:100,...(cursor?{cursor}:{})});found.push(...page.items);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(found.map(item=>item.name),names);assert.ok(found.every(item=>item.state==='preserved_unresolved'&&item.regular&&item.byteLength===14&&!('identity'in item)));
 const first=await retainedOrphanDiscovery(directory,{limit:1});writeFileSync(path.join(directory,names[1]),'changed evidence preserved');
 await assert.rejects(retainedOrphanDiscovery(directory,{cursor:first.nextCursor}),/changed/);
 assert.equal(readFileSync(path.join(directory,names.at(-1)),'utf8'),'original bytes');
});

test('missing evidence directories are empty and overflow or foreign cursors never become partial success',async t=>{
 const directory=fixture(t),missing=path.join(directory,'not-created');
 assert.equal(checkpointCustodyLifecycle(missing,()=>({references:[],blockers:[]})).list().items.length,0);
 assert.equal((await retainedOrphanDiscovery(missing,{})).items.length,0);
 assert.equal(readdirSync(directory).length,0);
 const entries=Array.from({length:4097},(_,i)=>({key:String(i),value:String(i)}));
 assert.throws(()=>lifecycleDiscoveryPage('custody',entries,{}),/exceeds bound/);
 const first=lifecycleDiscoveryPage('custody',[{key:'a',value:'a'},{key:'b',value:'b'}],{limit:1});
 assert.throws(()=>lifecycleDiscoveryPage('orphans',[{key:'a',value:'a'},{key:'b',value:'b'}],{cursor:first.nextCursor}),/changed/);
 assert.throws(()=>lifecycleDiscoveryPage('custody',[],{limit:101}),/limit/);
 assert.throws(()=>lifecycleDiscoveryPage('custody',[],{unknown:'no'}),/limit/);
});
