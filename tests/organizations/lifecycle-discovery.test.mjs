// Deferred discovery fixtures: read-only metadata authority, not provider/native or UI qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {lifecycleDiscovery} from '../../apps/server/dist/lifecycle-discovery.js';
import {lifecycleHash} from '../../apps/server/dist/lifecycle-journal.js';
import {stableJson} from '../../packages/agents/dist/index.js';
function fixture(t){
 const db=new Database(':memory:'),dataDir=mkdtempSync(path.join(tmpdir(),'lifecycle-discovery-'));
 t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
 db.exec(`CREATE TABLE projects(id TEXT);CREATE TABLE project_deletion_receipts(project_id TEXT);
 CREATE TABLE conversations(id TEXT,project_id TEXT);CREATE TABLE conversation_deletion_receipts(conversation_id TEXT,project_id TEXT);
 CREATE TABLE branch_executions(id TEXT,branch_id TEXT);CREATE TABLE branch_commands(execution_id TEXT,command_key TEXT,input_hash TEXT,result_json TEXT);
 CREATE TABLE coordination_destination_admissions(id TEXT,branch_id TEXT,source_execution_id TEXT,checkpoint_id INTEGER,project_id TEXT,conversation_id TEXT,reservation_hash TEXT,reservation_json TEXT,snapshot_json TEXT,state TEXT);
 CREATE TABLE coordination_destination_retirements(admission_id TEXT,evidence_json TEXT);
 CREATE TABLE coordination_destination_group_chats(admission_id TEXT,source_chat_id TEXT,source_execution_id TEXT,conversation_id TEXT);`);
 const directory=path.join(dataDir,'agent-import-operations');mkdirSync(directory);
 let disposed=false;
 const api=lifecycleDiscovery({db,dataDir,validateImport(value,id){assert.equal(value.id,id);assert.ok(value.projectId&&value.conversationId&&value.payloadHash);return value;},owner:()=>({captureDisposed:()=>disposed}),readRetirement:id=>({admissionId:id,operatorId:'local-operator',reviewHash:'f'.repeat(64)})});
 return {db,directory,api,setDisposed:v=>disposed=v};
}
const operation=(id,chat='deleted-chat')=>({id,projectId:'project',conversationId:chat,product:'dev',requestId:`request-${id}`,payloadHash:'a'.repeat(64),status:'failed',phase:'failed',sourceLabel:'import',createdAt:'now',updatedAt:'now'});
test('imports paginate exact current/deleted owners, flag unverified evidence and refuse stale cursor without writes',t=>{
 const {db,directory,api}=fixture(t);
 db.exec("INSERT INTO project_deletion_receipts VALUES('project');INSERT INTO conversation_deletion_receipts VALUES('deleted-chat','project')");
 const ids=[1,2,3].map(i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
 db.exec("INSERT INTO projects VALUES('current-project');INSERT INTO conversations VALUES('current-chat','current-project')");
 for(const id of ids)writeFileSync(path.join(directory,id+'.json'),JSON.stringify(id===ids[2]?{...operation(id,'current-chat'),projectId:'current-project'}:operation(id)));
 writeFileSync(path.join(directory,'unknown.json.corrupt'),'private malformed retained evidence');
 const before=readdirSync(directory),first=api.imports({limit:2});
 assert.equal(first.items.length,2);assert.equal(first.unverifiedEvidenceCount,1);assert.equal(first.items[0].owner.project,'deletion_receipt');assert.equal(first.items[0].evidenceOrigin,'journal');
 const last=api.imports({limit:2,cursor:first.nextCursor});assert.equal(last.items[0].operationId,ids[2]);assert.equal(last.items[0].owner.project,'current');assert.equal(last.items[0].owner.conversation,'current');assert.equal(last.nextCursor,undefined);
 const file=path.join(directory,ids[0]+'.json');writeFileSync(file,JSON.stringify({...operation(ids[0]),phase:'queued'}));
 assert.throws(()=>api.imports({cursor:first.nextCursor}),/changed/);assert.deepEqual(readdirSync(directory),before);
 assert.equal(readFileSync(path.join(directory,'unknown.json.corrupt'),'utf8'),'private malformed retained evidence');
 db.exec("INSERT INTO conversations VALUES('deleted-chat','other-project')");assert.throws(()=>api.imports({}),/ownership differs/);
});
test('retained lifecycle import identities remain discoverable without live owner or active journal',t=>{
 const {directory,api}=fixture(t),id='00000000-0000-4000-8000-000000000001',op=operation(id);
 const input={commandKey:'retain',reviewSha256:'f'.repeat(64)},receipt={operationId:id,operatorId:'local-operator',commandKey:'retain',reviewSha256:input.reviewSha256,state:'preserved_unresolved'};
 const file=path.join(directory,id+'.lifecycle.json');writeFileSync(file,JSON.stringify({input,receipt,operation:op}));
 const entry=api.imports({}).items[0];assert.equal(entry.operationId,id);assert.equal(entry.owner.project,'retained_only');assert.equal(entry.evidenceOrigin,'retained_lifecycle');assert.equal(entry.lifecycleState,'preserved_unresolved');
 writeFileSync(path.join(directory,id+'.json'),JSON.stringify({...op,projectId:'other'}));assert.throws(()=>api.imports({}),/ownership changed/);
 writeFileSync(file,'{"private":"unterminated');assert.throws(()=>api.imports({}),error=>!error.message.includes('unterminated')&&/metadata/.test(error.message));
});
function admission(index){
 const reservation={operatorId:'local-operator',branchId:'branch',sourceExecutionId:'removed-source',checkpointId:index,checkpointHash:lifecycleHash({}),custody:{sourceChatId:'original'},destination:{projectId:'project',conversationId:`destination-${index}`,executionId:'fresh-owner',resourceStepId:'fresh-step'}};
 return {id:`admission-${String(index).padStart(3,'0')}`,branch_id:'branch',source_execution_id:'removed-source',checkpoint_id:index,project_id:'project',conversation_id:reservation.destination.conversationId,reservation_hash:lifecycleHash(reservation),reservation_json:stableJson(reservation),snapshot_json:'{}',state:'reserved'};
}
test('destination discovery exceeds old fifty-item scope and reads immutable retired source identity',t=>{
 const {db,api}=fixture(t);for(let i=1;i<=55;i++){const row=admission(i);db.prepare('INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));}
 const found=[];let cursor;do{const page=api.destinations({limit:20,...(cursor?{cursor}:{})});found.push(...page.items);cursor=page.nextCursor;}while(cursor);
 assert.equal(found.length,55);assert.equal(new Set(found.map(item=>item.admissionId)).size,55);assert.equal(found[0].sourceOwner,'retained_only');
 const row=admission(56),reservation=JSON.parse(row.reservation_json);db.prepare('INSERT INTO coordination_destination_retirements VALUES(?,?)').run(row.id,stableJson({row,review:{reservation,reviewHash:'f'.repeat(64)}}));
 assert.equal(api.destinations({limit:100}).items.at(-1).state,'retired');
 db.exec("INSERT INTO branch_executions VALUES('removed-source','wrong-branch')");assert.throws(()=>api.destinations({}),/Source owner/);
});
test('unsealed source and exact capture key are discoverable independently of destination cleanup, with hash tamper refusal',t=>{
 const {db,api,setDisposed}=fixture(t),source={checkpointId:'original-package-id',sourceChatId:'source-chat',agentIds:['original-agent'],intent:{executionId:'source-owner',resourceStepId:'step',resourceGeneration:0,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)}};
 const capture={schema:'branch-resource-capture.v1',state:'capturing',source},bytes=stableJson(capture);
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?)').run('source-owner','resource-capture:actual-creation-key',lifecycleHash(source),bytes);
 const entry=api.captures({}).items[0];assert.deepEqual(entry.source,source);assert.equal(entry.captureKey,'resource-capture:actual-creation-key');assert.equal(entry.sourceOwner,'retained_only');
 assert.equal(db.prepare('SELECT result_json FROM branch_commands').get().result_json,bytes);
 setDisposed(true);assert.equal(api.captures({}).items.length,0);setDisposed(false);
 assert.throws(()=>api.captures({limit:0}),/limit/);
 db.exec("UPDATE branch_commands SET input_hash='changed'");assert.throws(()=>api.captures({}),/hash differs/);
});

test('current group discovery requires every original slot and keeps group identity explicit',t=>{
 const {db,api}=fixture(t),row=admission(1),reservation=JSON.parse(row.reservation_json);
 const resources=[0,1].map(i=>({custody:{sourceChatId:`source-chat-${i}`,intent:{executionId:`source-${i}`}},destination:{projectId:'project',conversationId:`fresh-${i}`,executionId:'fresh-owner',resourceStepId:`step-${i}`}}));
 Object.assign(reservation,{resources,...resources[0]});Object.assign(row,{conversation_id:'fresh-0',reservation_hash:lifecycleHash(reservation),reservation_json:stableJson(reservation)});
 db.prepare('INSERT INTO coordination_destination_admissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
 db.prepare('INSERT INTO coordination_destination_group_chats VALUES(?,?,?,?)').run(row.id,'source-chat-0','source-0','fresh-0');
 assert.throws(()=>api.destinations({}),/slot inventory/);
 db.prepare('INSERT INTO coordination_destination_group_chats VALUES(?,?,?,?)').run(row.id,'source-chat-1','source-1','fresh-1');
 const entry=api.destinations({}).items[0];assert.equal(entry.group,true);assert.equal(entry.destinations.length,2);assert.deepEqual(entry.destinations.map(d=>d.conversationId),['fresh-0','fresh-1']);
});
