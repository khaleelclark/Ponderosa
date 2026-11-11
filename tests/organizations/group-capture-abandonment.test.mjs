// Deferred SOURCE fixture: host journal/package protocol with an injected canonical owner port.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkpointGroupCaptureAbandonment} from '../../apps/server/dist/checkpoint-group-capture-abandonment.js';
import {lifecycleHash} from '../../apps/server/dist/lifecycle-journal.js';
import {stableJson} from '../../packages/agents/dist/index.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,{receipts=1}={}){
 const dataDir=mkdtempSync(path.join(tmpdir(),'group-abandon-')),db=new Database(':memory:');
 t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
 const directory=path.join(dataDir,'checkpoint-package-custody');mkdirSync(directory,{mode:0o700});
 db.exec(`CREATE TABLE branch_executions(id TEXT,state TEXT);CREATE TABLE branch_commands(execution_id TEXT,command_key TEXT,input_hash TEXT,result_json TEXT,created_at TEXT);
 CREATE TABLE scheduler_runs(agent_id TEXT,status TEXT);CREATE TABLE provider_process_authority(agent_id TEXT);CREATE TABLE agent_activations(agent_id TEXT,state TEXT);
 CREATE TABLE agent_creation_operation_members(agent_id TEXT,operation_id TEXT);CREATE TABLE agent_creation_operations(id TEXT,status TEXT);
 CREATE TABLE coordination_cut_restorations(receipt_json TEXT);CREATE TABLE pins(id TEXT);INSERT INTO pins VALUES('0'),('1');`);
 db.exec(readFileSync(new URL('../../packages/agents/src/schema/0040_lifecycle_reconciliation.sql',import.meta.url),'utf8'));
 const sources=[0,1].map(i=>({checkpointId:`capture-${i}`,sourceChatId:`chat-${i}`,agentIds:[`agent-${i}`],intent:{executionId:'owner',resourceStepId:`step-${i}`,resourceGeneration:0,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64),hostCutSha256:'d'.repeat(64)}}));
 const captured=sources.slice(0,receipts).map(source=>({version:1,...source,custodyId:sha(source.checkpointId),boundaryId:'original-boundary',sha256:sha('original bytes'),byteLength:14}));
 for(const [i,source]of sources.entries()){
  const id=sha(source.checkpointId);writeFileSync(path.join(directory,`${id}.payload`),'original bytes');
  writeFileSync(path.join(directory,`${id}.pending.json`),JSON.stringify({...source,state:'failed'}));
  if(captured[i])writeFileSync(path.join(directory,`${id}.json`),JSON.stringify(captured[i]));
 }
 const captureKey='issued-group-capture:'+sha('capture'),value={state:'capturing',sources,receipts:captured,snapshot:{original:true}},bytes=stableJson(value);
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run('owner',captureKey,sha('input'),bytes,'original');
 let references=[],blockers=[],fail=false,unavailable=false,beforePublish=()=>{};
 const owner={inspectGroupCapture(executionId,key){
  if(unavailable)throw Error('owner unavailable');assert.equal(executionId,'owner');assert.equal(key,captureKey);
  return {sources,receipts:captured,captureSha256:lifecycleHash(value),revision:lifecycleHash({references,blockers}),members:[{references,blockers}],state:'capturing'};
 },abandonGroupCapture(input,publish){
  assert.equal(db.inTransaction,true);assert.equal(input.expectedRevision,lifecycleHash({references,blockers}));
  beforePublish();const packageRetirements=publish();db.exec('DELETE FROM pins');if(fail)throw Error('SQL commit failed');return {state:'abandoned',packageRetirements};
 }};
 const api=checkpointGroupCaptureAbandonment(dataDir,db,()=>owner),selection={executionId:'owner',captureKey};
 const approve=()=>({...selection,commandKey:'explicit-approval',reviewSha256:api.review(selection).reviewSha256,preserveEvidence:true});
 return {dataDir,db,directory,sources,api,selection,approve,setReferences:v=>references=v,setBlockers:v=>blockers=v,setFail:v=>fail=v,setUnavailable:v=>unavailable=v,setBeforePublish:v=>beforePublish=v};
}
test('whole-group SQL rollback retains every pin; exact recovery verifies all bytes after owner removal',t=>{
 const f=fixture(t),input=f.approve();f.setFail(true);
 assert.throws(()=>f.api.abandon(input),/SQL commit failed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pins').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM host_lifecycle_commits').get().n,0);
 for(const source of f.sources)assert.equal(existsSync(path.join(f.directory,sha(source.checkpointId)+'.reconciled.json')),true);
 f.setFail(false);const result=f.api.abandon(input);assert.equal(result.packages.length,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pins').get().n,0);
 f.setUnavailable(true);assert.deepEqual(f.api.abandon(input),result);
 assert.throws(()=>f.api.abandon({...input,commandKey:'changed'}),/conflict/);
 const id=sha(f.sources[1].checkpointId);writeFileSync(path.join(result.packages[1].evidenceDirectory,id+'.payload'),'changed');
 assert.throws(()=>f.api.abandon(input),/evidence changed/);
});
test('second-package failure cannot release first-package or uncaptured-member cleanup pins',t=>{
 const f=fixture(t,{receipts:0}),input=f.approve(),second=path.join(f.directory,sha(f.sources[1].checkpointId)+'.payload');
 f.setBeforePublish(()=>writeFileSync(second,'different bytes'));
 assert.throws(()=>f.api.abandon(input),/review required/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pins').get().n,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM host_lifecycle_commits').get().n,0);
 assert.equal(existsSync(path.join(f.directory,sha(f.sources[0].checkpointId)+'.reconciled.json')),true);
 writeFileSync(second,'original bytes');f.setBeforePublish(()=>{});
 const result=f.api.abandon(input);assert.equal(result.packages.length,2);
});
test('stale review, non-first external pin and native hold refuse before package publication',t=>{
 const f=fixture(t),input=f.approve();f.setReferences([{kind:'admission',ownerId:'elsewhere',key:'hold',sha256:'e'.repeat(64)}]);
 assert.throws(()=>f.api.abandon(input),/changed or remains held/);f.setReferences([]);f.setBlockers(['owned_native_exit_unconfirmed']);
 assert.throws(()=>f.api.abandon(f.approve()),/remains held/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pins').get().n,2);
 for(const source of f.sources)assert.equal(existsSync(path.join(f.directory,sha(source.checkpointId)+'.reconciled.json')),false);
});
test('actual captured receipt length and digest must match original package files',t=>{
 const f=fixture(t),id=sha(f.sources[0].checkpointId);writeFileSync(path.join(f.directory,id+'.payload'),'changed');
 assert.throws(()=>f.api.review(f.selection),/receipt or original bytes differ/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pins').get().n,2);
});
