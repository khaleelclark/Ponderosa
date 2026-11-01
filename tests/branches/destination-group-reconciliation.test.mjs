// Deferred canonical boundary fixtures. Synthetic custody/observer evidence is not host drain qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {CoordinationV3DestinationReconciliation,groupReconciliationAuthority} from '../../packages/agents/dist/coordination-v3-destination-reconciliation.js';
import {destinationAdmissionHeld} from '../../packages/agents/dist/coordination-v3-destination-staging.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
function fixture(t,mode='full'){
 const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys = ON');
 db.exec(`CREATE TABLE branches(id TEXT PRIMARY KEY);CREATE TABLE branch_executions(id TEXT PRIMARY KEY);
 CREATE TABLE branch_unit_snapshots(id INTEGER PRIMARY KEY);CREATE TABLE conversations(id TEXT);
 CREATE TABLE agents(id TEXT,conversation_id TEXT,deleted_at TEXT);CREATE TABLE scheduler_runs(agent_id TEXT,status TEXT);
 CREATE TABLE agent_activations(agent_id TEXT,state TEXT);
 CREATE TABLE agent_creation_operations(id TEXT,project_id TEXT,conversation_id TEXT,status TEXT);`);
 for(const name of ['0037_coordination_destination_admissions.sql','0038_coordination_destination_retirements.sql','0039_coordination_destination_group_chats.sql'])db.exec(readFileSync(new URL('../../packages/agents/src/schema/'+name,import.meta.url),'utf8'));
 db.exec("INSERT INTO branches VALUES('branch');INSERT INTO branch_executions VALUES('source1'),('source2');INSERT INTO branch_unit_snapshots VALUES(1)");
 const resources=[1,2].map(i=>({custody:{sourceChatId:`old-chat${i}`,agentIds:[`old${i}`],intent:{executionId:`source${i}`,resourceStepId:`source-step${i}`,resourceGeneration:0}},destination:{projectId:'project',conversationId:`fresh-chat${i}`,executionId:'new-owner',resourceStepId:`new-step${i}`,resourceGeneration:0}}));
 const reservation={branchId:'branch',sourceExecutionId:'source1',checkpointId:1,checkpointHash:payloadHash({}),commandKey:'reserve',operatorId:'operator',reconcileEffects:true,custody:resources[0].custody,destination:resources[0].destination,resources};
 const stages=Object.fromEntries([1,2].map(i=>[`old-chat${i}`,{importPlan:{creationOperationId:`import${i}`,projectId:'project',conversationId:`fresh-chat${i}`,agents:[{sourceRef:`old${i}`,agentId:`new${i}`}],artifacts:[]},agentMap:{[`old${i}`]:`new${i}`},artifactMap:{}}]));
 const stage=mode==='full'?{importPlan:stages['old-chat1'].importPlan,imports:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,v.importPlan])),agentMap:{old1:'new1',old2:'new2'},artifactMap:{}}:null;
 db.prepare('INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('group','branch','source1',1,'reserve',payloadHash(reservation),stableJson(reservation),'{}','project','fresh-chat1',stage?'staged':'reserved',stage?stableJson(stage):null,null,'now','now');
 for(const i of [1,2]){
  const prepared=mode!=='empty'&&(mode!=='partial'||i===1);
  db.prepare('INSERT INTO coordination_destination_group_chats VALUES(?,?,?,?,?)').run('group',`old-chat${i}`,`source${i}`,`fresh-chat${i}`,prepared?stableJson(stages[`old-chat${i}`]):null);
  if(prepared){db.prepare('INSERT INTO coordination_destination_members VALUES(?,?,?)').run('group',`old${i}`,`new${i}`);db.prepare('INSERT INTO agent_creation_operations VALUES(?,?,?,?)').run(`import${i}`,'project',`fresh-chat${i}`,'rolled_back');}
 }
 const service=new CoordinationV3DestinationReconciliation(db,true),singular=new CoordinationV3DestinationReconciliation(db);
 let revision='observed-whole-group',references=[];
 const host={inspectGroup:({groupChats})=>{assert.equal(groupChats.length,2);return {revision,references};},requireGroupApproval:()=>{}};
 const authority=groupReconciliationAuthority(host);
 const review=()=>db.transaction(()=>service.review('group','operator',authority))();
 const input=(releaseSourcePins=true)=>({admissionId:'group',commandKey:'retire',operatorId:'operator',expectedReviewHash:review().reviewHash,releaseSourcePins});
 const retire=i=>db.transaction(()=>service.retire(i,authority,'retired'))();
 return {db,service,singular,authority,host,review,input,retire,setRevision:v=>revision=v,setReferences:v=>references=v};
}
test('one group CAS/approval/reference boundary and all-slot rollback, then immutable exhaustive replay',t=>{
 const f=fixture(t),stale=f.input();f.setRevision('changed');assert.throws(()=>f.retire(stale),/review changed/);
 f.setReferences(['second-owner-retained-reference']);assert.throws(()=>f.retire(f.input()),/still referenced/);f.setReferences([]);
 const input=f.input();f.host.requireGroupApproval=()=>f.setRevision('approval-mutated');assert.throws(()=>f.retire(input),/changed reconciliation evidence/);
 f.host.requireGroupApproval=()=>{};
 f.db.exec("CREATE TRIGGER prevent_member_release BEFORE DELETE ON coordination_destination_members BEGIN SELECT RAISE(ABORT,'injected release failure');END");
 f.db.transaction(()=>{assert.throws(()=>f.service.retire(f.input(),f.authority),/injected release failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_group_chats').get().n,2);assert.equal(f.service.read('group'),null);})();
 f.db.exec('DROP TRIGGER prevent_member_release');const exact=f.input(),receipt=f.retire(exact);
 assert.equal(receipt.resources.length,2);assert.equal(receipt.groupChats.length,2);assert.equal(receipt.releasedSourcePins,true);
 assert.deepEqual(f.service.read('group'),receipt);assert.deepEqual(f.retire(exact),receipt);
 for(const table of ['coordination_destination_admissions','coordination_destination_members','coordination_destination_group_chats'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 for(const i of [1,2]){assert.equal(destinationAdmissionHeld(f.db,undefined,`fresh-chat${i}`),true);assert.equal(destinationAdmissionHeld(f.db,`new${i}`),true);}
 assert.throws(()=>f.singular.read('group'),/singular or group/);assert.throws(()=>f.retire({...exact,releaseSourcePins:false}),/conflict/);
 assert.throws(()=>f.db.exec('DELETE FROM coordination_destination_retirements'),/immutable/);
});
test('non-first surviving Agent, runtime and unknown import refuse; preserve-only keeps every pin',t=>{
 const f=fixture(t);assert.throws(()=>f.db.transaction(()=>f.singular.review('group','operator',f.authority))(),/singular or group/);
 f.db.exec("INSERT INTO agents VALUES('new2',NULL,NULL)");assert.throws(()=>f.review(),/canonical deletion/);
 f.db.exec("UPDATE agents SET deleted_at='deleted';INSERT INTO scheduler_runs VALUES('new2','outcome_unknown')");assert.throws(()=>f.review(),/not drained/);
 f.db.exec("DELETE FROM scheduler_runs;UPDATE agent_creation_operations SET status='preparing' WHERE id='import2'");assert.throws(()=>f.review(),/rolled back/);
 f.db.exec("UPDATE agent_creation_operations SET status='rolled_back';INSERT INTO conversations VALUES('fresh-chat2')");assert.throws(()=>f.review(),/canonical deletion/);f.db.exec('DELETE FROM conversations');
 f.setReferences(['still-referenced']);const exact=f.input(false),receipt=f.retire(exact);assert.equal(receipt.releasedSourcePins,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_group_chats').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM coordination_destination_members').get().n,2);
 assert.throws(()=>f.db.exec("DELETE FROM branch_executions WHERE id='source2'"),/FOREIGN KEY/);
 assert.throws(()=>f.retire({...exact,releaseSourcePins:true}),/conflict/);
});
test('partial importer stages and empty reservations retain exhaustive slots; admitted and corrupt evidence refuse',t=>{
 const f=fixture(t,'partial');assert.equal(f.review().stage,null);const receipt=f.retire(f.input());
 assert.ok(receipt.groupChats[0].stage_json);assert.equal(receipt.groupChats[1].stage_json,null);
 assert.equal(destinationAdmissionHeld(f.db,undefined,'fresh-chat2'),true);
 f.db.exec('DROP TRIGGER coordination_destination_retirement_immutable_update');
 f.db.prepare("UPDATE coordination_destination_retirements SET evidence_json='{}'").run();assert.throws(()=>f.service.read('group'));
 const h=fixture(t,'empty');assert.equal(h.retire(h.input()).groupChats.length,2);
 const g=fixture(t,'empty');g.db.exec("UPDATE coordination_destination_admissions SET state='admitted'");assert.throws(()=>g.review(),/unadmitted/);
});
