import assert from 'node:assert/strict';
import test from 'node:test';
import {CapabilityPolicyStore} from '@ponderosa/agents';
import {openCurrentMemoryDatabase} from '../../packages/agents/dist/state-admission.js';

test('permission audit and policy commit atomically, preserve existing before state, and paginate without gaps',t=>{
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());const store=new CapabilityPolicyStore(db);
 const put=(revision,ids=[])=>store.put({scopeKind:'product',scopeId:'interactive',expectedRevision:revision,restrictedCapabilityIds:ids});
 // Model an existing install: do not invent historical actors or events.
 db.prepare("INSERT INTO capability_policies VALUES ('product','interactive',4,'[\"memory.read\"]','2026-01-01')").run();
 assert.deepEqual(store.history('product','interactive').changes,[]);
 put(4);assert.deepEqual(store.history('product','interactive').changes[0].before,['memory.read']);
 db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON capability_policy_history BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 assert.throws(()=>put(5,['memory.write']),/audit unavailable/);
 assert.equal(store.get('product','interactive').revision,5);assert.equal(store.history('product','interactive').changes.length,1);
 db.exec('DROP TRIGGER reject_history');
 for(let i=5;i<58;i++)put(i);
 const first=store.history('product','interactive'),second=store.history('product','interactive',first.nextBeforeRevision);
 assert.equal(first.changes.length,50);assert.equal(second.changes.length,4);assert.equal(second.nextBeforeRevision,undefined);
 assert.deepEqual([...first.changes,...second.changes].map(c=>c.revision),Array.from({length:54},(_,i)=>58-i));
 assert.ok(first.changes.every(c=>c.actor==='system'),'Internal callers cannot be mislabeled as human Settings');
});
