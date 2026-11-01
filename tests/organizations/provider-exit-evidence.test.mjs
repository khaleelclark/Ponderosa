// Deferred source fixtures: synthetic handles, not provider/native exit qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {ProviderProcessAuthority} from '../../apps/server/dist/provider-process-authority.js';
import {readProviderExitEvidence,verifyRetainedProviderExitEvidence} from '../../packages/agents/dist/provider-exit-evidence.js';
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 for(const name of ['0002_provider_process_authority.sql','0022_provider_scope_authority.sql','0040_lifecycle_reconciliation.sql'])db.exec(readFileSync(new URL(`../../packages/agents/src/schema/${name}`,import.meta.url),'utf8'));
 db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT);
 CREATE TABLE agents(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,deleted_at TEXT);
 CREATE TABLE scheduler_runs(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,status TEXT,fencing_token INTEGER);
 INSERT INTO conversations VALUES('chat','project');INSERT INTO agents VALUES('agent','project','chat',NULL);
 INSERT INTO scheduler_runs VALUES('run','project','agent','completed',1);`);
 let alive=true,fail=false;
 const handle={processIdentity:{pid:424242,pgid:424242,birthMarker:'synthetic-birth'},isAlive:()=>alive,close:async()=>{if(fail)throw Error('unobserved');alive=false;}};
 const authority=new ProviderProcessAuthority(db,'worker');
 // Replace only the recovery seam. No OS observation is claimed by these fixtures.
 authority.recover=()=>handle;
 const scope={purpose:'provider Run',projectId:'project',agentId:'agent',runId:'run',runFence:1};
 const input={projectId:'project',conversationId:'chat',participants:[{agentId:'agent',runIds:['run']}]};
 const count=kind=>db.prepare('SELECT count(*) n FROM host_lifecycle_commits WHERE kind=?').get(kind).n;
 return {db,handle,authority,scope,input,count,setFail:value=>{fail=value;},exit:()=>{alive=false;}};
}
test('actual registration/close hooks retain exact immutable evidence and survive owner cleanup',async t=>{
 const f=fixture(t);f.authority.register(f.handle,f.scope);
 assert.throws(()=>f.authority.readExitEvidence(f.input),/live|unknown/);
 f.setFail(true);await assert.rejects(f.authority.terminateAgents(new Set(['agent']),'fixture drain'),/pending/);
 assert.equal(f.count('provider-process-exit'),0);assert.equal(f.authority.count(),1);
 f.setFail(false);await f.authority.terminateAgents(new Set(['agent']),'fixture drain');
 const evidence=f.authority.readExitEvidence(f.input);
 assert.equal(evidence.receipts[0].receipt.result,'observed_exited');
 assert.equal(evidence.receipts[0].receipt.registrations[0].registration.runFence,1);
 assert.deepEqual(f.authority.readExitEvidence({...f.input,expectedRevision:evidence.revision}),evidence);
 assert.throws(()=>f.db.prepare("DELETE FROM host_lifecycle_commits WHERE kind='provider-process-exit'").run(),/immutable/);
 f.db.exec('DELETE FROM scheduler_runs;DELETE FROM agents;DELETE FROM conversations;');
 verifyRetainedProviderExitEvidence(f.db,evidence);
 assert.throws(()=>readProviderExitEvidence(f.db,f.input),/precleanup/);
 const corrupt=structuredClone(evidence);corrupt.receipts[0].receipt.result='operator-says-exited';
 assert.throws(()=>verifyRetainedProviderExitEvidence(f.db,corrupt),/hash/);
});
test('whole Run/member inventory, lifetime rebinding and revision checks fail closed',async t=>{
 const f=fixture(t);f.authority.register(f.handle,f.scope);
 f.db.exec("INSERT INTO scheduler_runs VALUES('run2','project','agent','completed',2)");
 f.authority.register(f.handle,{...f.scope,runId:'run2',runFence:2});
 f.exit();f.authority.pruneExited();
 assert.throws(()=>readProviderExitEvidence(f.db,f.input),/Run inventory/);
 const input={...f.input,participants:[{agentId:'agent',runIds:['run','run2']}]};
 const evidence=readProviderExitEvidence(f.db,input);
 assert.equal(evidence.receipts.length,1);assert.equal(evidence.receipts[0].receipt.registrations.length,2);
 f.db.exec("UPDATE scheduler_runs SET status='cancelled',fencing_token=3 WHERE id='run2'");
 const cancelled=readProviderExitEvidence(f.db,input);assert.equal(cancelled.runs.find(r=>r.runId==='run2').fence,3);
 assert.throws(()=>readProviderExitEvidence(f.db,{...input,expectedRevision:evidence.revision}),/revision/);
 f.db.exec("UPDATE scheduler_runs SET status='outcome_unknown' WHERE id='run2'");
 assert.throws(()=>readProviderExitEvidence(f.db,input),/live|unknown/);
 f.db.exec("UPDATE scheduler_runs SET status='completed' WHERE id='run2';INSERT INTO agents VALUES('other','project','chat',NULL)");
 assert.throws(()=>readProviderExitEvidence(f.db,input),/member inventory/);
 f.db.exec("DELETE FROM agents WHERE id='other'");
 assert.throws(()=>readProviderExitEvidence(f.db,{...input,expectedRevision:'stale'}),/revision/);
});
test('receipt persistence and caught authority-delete failure preserve the hold atomically',async t=>{
 const f=fixture(t);f.authority.register(f.handle,f.scope);f.exit();
 f.db.exec("CREATE TRIGGER reject_exit BEFORE INSERT ON host_lifecycle_commits WHEN NEW.kind='provider-process-exit' BEGIN SELECT RAISE(ABORT,'disk failure');END");
 assert.throws(()=>f.authority.pruneExited(),/disk failure/);assert.equal(f.authority.count(),1);
 assert.equal(f.count('provider-process-exit'),0);
 f.db.exec("DROP TRIGGER reject_exit;CREATE TRIGGER reject_delete BEFORE DELETE ON provider_process_authority BEGIN SELECT RAISE(ABORT,'held');END");
 assert.throws(()=>f.authority.pruneExited(),/held/);assert.equal(f.count('provider-process-exit'),0);
 f.db.exec('DROP TRIGGER reject_delete');f.authority.pruneExited();
 assert.equal(f.authority.count(),0);readProviderExitEvidence(f.db,f.input);
});
test('legacy unregistered authority can drain but cannot manufacture historical coverage',async t=>{
 const f=fixture(t);
 f.db.prepare('INSERT INTO provider_process_authority VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('legacy','old-worker','provider Run','project','agent','run',424242,424242,'legacy-birth',new Date().toISOString(),null);
 f.exit();f.authority.pruneExited();assert.equal(f.count('provider-process-exit'),1);
 assert.throws(()=>readProviderExitEvidence(f.db,f.input),/coverage missing/);
});
test('native Job lifetime requires actual retained handle observation; restart absence is insufficient',async t=>{
 const f=fixture(t),original=Object.getOwnPropertyDescriptor(process,'platform');
 Object.defineProperty(process,'platform',{value:'win32'});
 try{
  const owner={};f.authority.register(f.handle,f.scope,owner);
  assert.throws(()=>readProviderExitEvidence(f.db,f.input),/not been observed/);
  const restarted=new ProviderProcessAuthority(f.db,'new-worker');
  assert.equal(await restarted.recoverPreviousWorkers(),0);
  assert.throws(()=>readProviderExitEvidence(f.db,f.input),/not been observed/);
  f.setFail(true);await assert.rejects(f.authority.terminateAgents(new Set(['agent']),'native fixture'),/pending/);
  f.setFail(false);await f.authority.terminateAgents(new Set(['agent']),'native fixture');
  const evidence=readProviderExitEvidence(f.db,f.input);
  assert.equal(evidence.receipts[0].receipt.registrations[0].registration.process.kind,'native-job');
 }finally{Object.defineProperty(process,'platform',original);}
});
