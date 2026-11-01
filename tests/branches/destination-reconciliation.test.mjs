// Deferred source fixture: exercises the canonical retirement boundary, not Branch end-to-end drain.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {CoordinationV3DestinationReconciliation} from '../../packages/agents/dist/coordination-v3-destination-reconciliation.js';
import {destinationAdmissionHeld} from '../../packages/agents/dist/coordination-v3-destination-staging.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE branches(id TEXT PRIMARY KEY); CREATE TABLE branch_executions(id TEXT PRIMARY KEY);
 CREATE TABLE branch_unit_snapshots(id INTEGER PRIMARY KEY); CREATE TABLE conversations(id TEXT);
 CREATE TABLE agents(id TEXT,conversation_id TEXT); CREATE TABLE scheduler_runs(agent_id TEXT,status TEXT);
 CREATE TABLE agent_activations(agent_id TEXT,state TEXT);
 CREATE TABLE agent_creation_operations(id TEXT,conversation_id TEXT,status TEXT);`);
 for(const name of ['0037_coordination_destination_admissions.sql','0038_coordination_destination_retirements.sql','0039_coordination_destination_group_chats.sql'])
  db.exec(readFileSync(new URL('../../packages/agents/src/schema/'+name,import.meta.url),'utf8'));
 db.exec("INSERT INTO branches VALUES('b'); INSERT INTO branch_executions VALUES('source'); INSERT INTO branch_unit_snapshots VALUES(1)");
 const reservation={destination:{conversationId:'fresh'},branchId:'b'};
 db.prepare(`INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('admission','b','source',1,'reserve',payloadHash(reservation),stableJson(reservation),'{}','project','fresh','reserved',null,null,'now','now');
 db.prepare('INSERT INTO coordination_destination_members VALUES(?,?,?)').run('admission','old','new');
 const service=new CoordinationV3DestinationReconciliation(db);
 let revision='observed-exit-and-owner-v1',references=[];
 const authority={inspect:()=>({revision,references}),requireApproval:()=>{}};
 const review=()=>db.transaction(()=>service.review('admission','operator',authority))();
 const input=()=>({admissionId:'admission',commandKey:'retire',operatorId:'operator',expectedReviewHash:review().reviewHash,releaseSourcePins:true});
 const retire=i=>db.transaction(()=>service.retire(i,authority,'retired'))();
 return {db,service,authority,review,input,retire,setRevision:v=>revision=v,setReferences:v=>references=v};
}
test('review CAS, unresolved reference refusal, immutable receipt replay and retired identity hold',t=>{
 const f=fixture(t),stale=f.input();f.setRevision('changed');
 assert.throws(()=>f.retire(stale),/review changed/);
 f.setReferences(['branch-owner-command']);assert.throws(()=>f.retire(f.input()),/still referenced/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_admissions').get().n,1);
 f.setReferences([]);const input=f.input(),receipt=f.retire(input);
 assert.equal(receipt.releasedSourcePins,true);assert.deepEqual(f.retire(input),receipt);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_admissions').get().n,0);
 assert.equal(destinationAdmissionHeld(f.db,'new'),true);
 assert.equal(destinationAdmissionHeld(f.db,undefined,'fresh'),true);
 assert.throws(()=>f.retire({...input,commandKey:'other'}),/conflict/);
 assert.throws(()=>f.db.exec('DELETE FROM coordination_destination_retirements'),/immutable/);
});
test('unknown import and surviving identities preserve pins; approval mutation rolls back',t=>{
 const f=fixture(t);
 f.db.exec("INSERT INTO agent_creation_operations VALUES('import','fresh','preparing')");
 assert.throws(()=>f.review(),/rolled back/);
 f.db.exec("UPDATE agent_creation_operations SET status='rolled_back'; INSERT INTO conversations VALUES('fresh')");
 assert.throws(()=>f.review(),/canonical deletion/);
 f.db.exec('DELETE FROM conversations');const input=f.input();
 f.authority.requireApproval=()=>f.setRevision('approval-changed-evidence');
 assert.throws(()=>f.retire(input),/changed reconciliation evidence/);
 assert.equal(f.service.read('admission'),null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_members').get().n,1);
});
