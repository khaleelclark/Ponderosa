// Deferred SOURCE: immutable audit selectors/readback, not provider/package qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {groupJournalAudit,groupJournalDigest} from '../../apps/server/dist/group-journal-audit.js';
import {stableJson,resourceCaptureFrontierHash} from '../../packages/agents/dist/index.js';
const hash=v=>createHash('sha256').update(stableJson(v)).digest('hex');
const custody=id=>createHash('sha256').update(id).digest('hex');
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE branch_commands(execution_id TEXT,command_key TEXT,input_hash TEXT,result_json TEXT);
 CREATE TABLE branch_executions(id TEXT,branch_id TEXT);CREATE TABLE branch_unit_snapshots(id INTEGER,execution_id TEXT,snapshot_json TEXT,content_hash TEXT);
 CREATE TABLE branch_versions(id TEXT,branch_id TEXT,definition_json TEXT,content_hash TEXT);CREATE TABLE branch_bindings(id TEXT,branch_id TEXT,bindings_json TEXT,content_hash TEXT);`);
 return db;
}
function captureFixture(db,retained){
 const selected={execution:[{id:'source',branch_id:'branch',version_id:'version',binding_revision_id:'binding'}],resources:[0,1].map(i=>({step_execution_id:`step-${i}`,chat_id:`chat-${i}`,generation:0,import_operation_json:stableJson({result:{agentIds:[`agent-${i}`]}})}))};
 const cut={schema:'ponderosa.branch.host-dependencies.v1',executionId:'source',restoreAuthority:'fresh_admission_required',nativeState:'not_captured',artifactStorage:'references_only',bindingPin:{sha256:'b'.repeat(64)},...Object.fromEntries(['requests','updates','lateResults','joins','members','suspensions','communications','joinOutcomes','artifactRefs','resources','resourceMembers','resourceContexts','resourceReceipts'].map(key=>[key,[]]))};
 const configuration={limits:{}},audit=[{kind:'original'}];
 const continuation={schema:'ponderosa.branch.issued-resource-continuation.v1',group:true,configuration,bindingHash:'b'.repeat(64),versionHash:'v'.repeat(64),versionId:'version',bindingRevisionId:'binding',frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:hash(cut),audit,auditSha256:hash(audit)};
 const sources=selected.resources.map((r,i)=>({checkpointId:`capture-${i}`,sourceChatId:r.chat_id,agentIds:[`agent-${i}`],intent:{executionId:'source',resourceStepId:r.step_execution_id,resourceGeneration:0,frontierSha256:continuation.frontierSha256,hostCutSha256:hash(cut),bindingSha256:continuation.bindingHash,configurationSha256:hash(configuration)}}));
 const receipts=sources.slice(0,retained?2:1).map(source=>({version:1,...source,custodyId:custody(source.checkpointId),boundaryId:'original',sha256:'c'.repeat(64),byteLength:100}));
 const snapshot={schema:'branch-unit-selected.v2',captureKind:'issued_group',restore_supported:false,selected,hostDependencies:cut,issuedContinuation:continuation};
 const sealed={...snapshot,issuedGroupCustody:receipts};
 const value={state:retained?'retained':'capturing',commandKey:'actual-original-key',reviewHash:hash(snapshot),versionId:'version',snapshot,sources,receipts,...(retained?{checkpointId:7,checkpointHash:hash(sealed)}:{})};
 const row={execution_id:'source',command_key:'issued-group-capture:'+hash(value.commandKey),input_hash:hash({commandKey:value.commandKey}),result_json:stableJson(value)};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?)').run(...Object.values(row));
 const selection={kind:'captures',branchId:'branch',executionId:'source',journalKey:row.command_key,journalSha256:groupJournalDigest(row),custodySha256:hash({sources,receipts}),commandKey:value.commandKey};
 return {selection,value,sealed};
}
for(const retained of [false,true])test(`owner-removed ${retained?'retained':'partial'} capture readback is historical and performs no writes`,t=>{
 const db=fixture(t),{selection,value}=captureFixture(db,retained),api=groupJournalAudit(db,{inspectCoordinationDestinationGroupAudit(){throw Error('not a capture');}}),before=db.prepare('SELECT total_changes() n').get().n;
 const result=api.read(selection);assert.equal(result.sourceOwnerPresent,false);assert.equal(result.currentAuthority,false);assert.equal(result.actionEligible,false);assert.equal(result.held,true);assert.deepEqual(result.capture.receipts,value.receipts);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 assert.throws(()=>api.read({...selection,custodySha256:'0'.repeat(64)}),/custody/);
 assert.throws(()=>api.read({...selection,commandKey:'guessed'}),/command/);
 db.prepare('UPDATE branch_commands SET result_json=?').run(stableJson({...value,state:'unknown'}));assert.throws(()=>api.read(selection),/changed/);
});
test('retained checkpoint present with changed bytes refuses; missing original journal never reconstructs keys',t=>{
 const db=fixture(t),{selection,sealed}=captureFixture(db,true),api=groupJournalAudit(db,{});
 db.prepare('INSERT INTO branch_unit_snapshots VALUES(?,?,?,?)').run(7,'source',stableJson(sealed),hash(sealed));assert.equal(api.read(selection).state,'retained');
 db.prepare('UPDATE branch_unit_snapshots SET content_hash=?').run('0'.repeat(64));assert.throws(()=>api.read(selection),/checkpoint differs/);
 db.exec('DELETE FROM branch_commands');assert.throws(()=>api.read(selection),/unavailable/);
});
test('group admission audit binds exact reservation/full map and retains unknown held states without an action path',t=>{
 const db=fixture(t),resources=[0,1].map(i=>({custody:{custodyId:`custody-${i}`,checkpointId:`source-${i}`,intent:{resourceStepId:`step-${i}`}},destination:{executionId:'target',resourceStepId:`fresh-${i}`}}));
 const reservation={branchId:'branch',sourceExecutionId:'source',checkpointId:7,checkpointHash:'c'.repeat(64),resources},input={commandKey:'original-command',checkpointId:7,expectedHash:reservation.checkpointHash};
 const value={schema:'ponderosa.branch.issued-group-destination.v1',input,reservation,admissionId:'admission',reservationHash:hash(reservation),idMap:{'step-0':'fresh-0','step-1':'fresh-1'}};
 const row={execution_id:'source',command_key:'issued-group-destination:'+hash(input.commandKey),input_hash:hash(input),result_json:stableJson(value)};db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?)').run(...Object.values(row));
 const selection={kind:'admissions',branchId:'branch',executionId:'source',journalKey:row.command_key,journalSha256:groupJournalDigest(row),custodySha256:hash(resources.map(r=>r.custody)),commandKey:input.commandKey,admissionId:'admission',reservationHash:value.reservationHash};
 const api=groupJournalAudit(db,{inspectCoordinationDestinationGroupAudit(){return {reservation,reservationHash:value.reservationHash,state:'staged',sourceIds:['step-0','step-1'],agentMap:{},imports:[{operationId:'pending',status:'outcome_unknown'}],receipt:null,retirement:null,evidenceSha256:'d'.repeat(64)};}});
 const result=api.read(selection);assert.equal(result.imports[0].status,'outcome_unknown');assert.equal(result.actionEligible,false);assert.equal(result.held,true);
 assert.throws(()=>api.read({...selection,admissionId:'wrong'}),/reservation/);
 db.exec("INSERT INTO branch_executions VALUES('target','wrong-branch')");assert.throws(()=>api.read(selection),/owner identity/);
});

// Transport projection seam: canonical immutable validation is exercised by the Branch producer fixture.
test('admitted historical partition audit suppresses all private retained envelopes and performs no writes',t=>{
 const db=fixture(t),resources=[0,1].map(i=>({custody:{custodyId:`custody-${i}`,intent:{resourceStepId:`step-${i}`}},destination:{executionId:'target',resourceStepId:`fresh-${i}`}}));
 const reservation={branchId:'branch',sourceExecutionId:'source',checkpointId:7,checkpointHash:'c'.repeat(64),resources},input={commandKey:'partition-command',checkpointId:7,expectedHash:reservation.checkpointHash};
 const value={schema:'ponderosa.branch.issued-group-destination.v1',input,reservation,admissionId:'real-admission',reservationHash:hash(reservation),idMap:{'step-0':'fresh-0','step-1':'fresh-1'}};
 const row={execution_id:'source',command_key:'issued-group-destination:'+hash(input.commandKey),input_hash:hash(input),result_json:stableJson(value)};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?)').run(...Object.values(row));
 const selection={kind:'admissions',branchId:'branch',executionId:'source',journalKey:row.command_key,journalSha256:groupJournalDigest(row),custodySha256:hash(resources.map(r=>r.custody)),commandKey:input.commandKey,admissionId:value.admissionId,reservationHash:value.reservationHash};
 const entry={historical:true,dispatchable:false,sha256:'d'.repeat(64),selection:{executionId:'old-execution',stepId:'old-step',generation:0,checkpointId:3,checkpointHash:'a'.repeat(64),envelopeSha256:'b'.repeat(64),intakeFence:{identity:'private-fence',sha256:'e'.repeat(64)},discloseTo:['private-source-ref']},destinationAgentIds:['private-destination'],retirement:{resultJson:'PRIVATE_RETIREMENT_BODY'},seal:{identity:{agentIds:['private-original']},envelope:{hostDependencies:{requests:[{payload:'PRIVATE_REQUEST_BODY'}],updates:[{payload:'PRIVATE_UPDATE_BODY'}],communications:[{payload:'PRIVATE_COMMUNICATION_BODY'}]},configuration:'PRIVATE_CONFIGURATION'}}};
 const receipt={owners:[],historicalPartition:[entry]},before=db.prepare('SELECT total_changes() n').get().n;
 const api=groupJournalAudit(db,{inspectCoordinationDestinationGroupAudit(id){assert.equal(id,'real-admission');return {reservation,reservationHash:value.reservationHash,state:'admitted',sourceIds:['step-0','step-1'],agentMap:{},imports:[],receipt,retirement:null,evidenceSha256:'f'.repeat(64)};}});
 const result=api.read(selection),summary=result.receipt.historicalPartition[0],bytes=JSON.stringify(result);
 assert.deepEqual(summary,{historical:true,dispatchable:false,sha256:entry.sha256,executionId:'old-execution',stepId:'old-step',generation:0,checkpointId:3,checkpointHash:'a'.repeat(64),envelopeSha256:'b'.repeat(64),originalAgentCount:1,destinationAgentCount:1,requestCount:1,updateCount:1,communicationCount:1});
 for(const privateKey of ['PRIVATE_','private-source-ref','private-destination','private-original','private-fence','seal','retirementBody','discloseTo'])assert.equal(bytes.includes(privateKey),false,privateKey);
 assert.equal(result.historical,true);assert.equal(result.currentAuthority,false);assert.equal(result.actionEligible,false);assert.equal(result.held,true);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(entry.seal.envelope.configuration,'PRIVATE_CONFIGURATION');
});
