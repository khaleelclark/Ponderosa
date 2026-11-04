import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {ProviderNeverStartedReceipt} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {requireGenerationExitOpen} from './branch-generation-exit-fence.js';

type Row={identity:string;input_json:string;receipt_json:string;receipt_sha256:string};
const creationAuthorities=new WeakMap<Database.Database,string>();
const CONTRACT='provider-start-admission.v1';
export function enableProviderStartCoverage(db:Database.Database,workerId:string):void {
 if(!workerId)throw Error('Provider start worker required');
 creationAuthorities.set(db,workerId);
}
function commit(db:Database.Database,kind:string,identity:string,value:unknown):{identity:string;sha256:string} {
 const bytes=stableJson(value),sha256=payloadHash(value);
 if(Buffer.byteLength(bytes)>4*1024*1024)throw Error('Provider start journal exceeds bound');
 const prior=db.prepare('SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?').get(kind,identity) as Row|undefined;
 if(prior){if(prior.input_json!==bytes||prior.receipt_json!==bytes||prior.receipt_sha256!==sha256)throw Error('Provider start immutable receipt conflict');}
 else db.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run(kind,identity,bytes,bytes,sha256);
 return {identity,sha256};
}
function retained(db:Database.Database,kind:string,ref:{identity:string;sha256:string}):any {
 const row=db.prepare('SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?').get(kind,ref.identity) as Row|undefined;
 if(!row||Buffer.byteLength(row.receipt_json)>4*1024*1024)throw Error('Provider start receipt missing or exceeds bound');
 const value=JSON.parse(row.receipt_json);
 if(row.receipt_sha256!==ref.sha256||payloadHash(value)!==ref.sha256||stableJson(value)!==row.receipt_json||row.input_json!==row.receipt_json)throw Error('Provider start receipt integrity failure');
 return value;
}
/** Only called inside canonical INSERT transaction, never backfilled on boot/read. */
export function recordProviderStartCoverage(db:Database.Database,scope:{agentId:string;projectId:string;conversationId:string}):void {
 const workerId=creationAuthorities.get(db);if(!workerId)return;
 if(!db.inTransaction)throw Error('Provider start coverage requires creation transaction');
 commit(db,'provider-start-coverage',scope.agentId,{schema:'provider-start-coverage.v1',contract:CONTRACT,...scope,workerId});
}
export function admitProviderStart(db:Database.Database,workerId:string,agentId:string,operation:string,run?:{runId:string;fence:number}):string {
 return db.transaction(()=>{
  const a=db.prepare('SELECT project_id,conversation_id FROM agents WHERE id=? AND deleted_at IS NULL').get(agentId) as {project_id:string;conversation_id:string}|undefined;
  if(!a?.conversation_id||!db.prepare('SELECT 1 FROM conversations WHERE id=? AND project_id=?').get(a.conversation_id,a.project_id))throw Error('Live provider start owner required');
  if(run && (!run.runId || !Number.isSafeInteger(run.fence) || run.fence<1 || !db.prepare("SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=? AND project_id=? AND fencing_token=? AND lease_owner=? AND status IN ('leased','running') AND side_effects_fenced_at IS NULL").get(run.runId,agentId,a.project_id,run.fence,workerId))) throw Error('Provider start Run ownership differs');
  requireGenerationExitOpen(db,agentId,a.conversation_id);
  const generation=db.prepare('SELECT execution_id AS executionId,step_execution_id AS stepExecutionId,generation FROM branch_resources WHERE chat_id=?').get(a.conversation_id)??null;
  const identity=randomUUID();
  commit(db,'provider-start-admission',identity,{schema:CONTRACT,identity,workerId,agentId,projectId:a.project_id,conversationId:a.conversation_id,generation,operation,...(run?{runId:run.runId,runFence:run.fence}:{})});
  return identity;
 }).immediate();
}
/** Settlement never erases admission. Rejected/no-handle opens remain unknown forever. */
export function settleProviderStart(db:Database.Database,identity:string,workerId:string,registrations:string[]):void {
 db.transaction(()=>{
  const row=db.prepare("SELECT receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND identity=?").get(identity) as {sha256:string}|undefined;
  if(!row)throw Error('Provider start admission missing');
  const claim=retained(db,'provider-start-admission',{identity,sha256:row.sha256});
  if(claim.workerId!==workerId||!registrations.length||new Set(registrations).size!==registrations.length||registrations.length>4096)throw Error('Provider start settlement requires exact opened lifetimes');
  for(const authorityId of registrations){
   const registered=db.prepare("SELECT identity,receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=? AND json_extract(receipt_json,'$.agentId')=? AND json_extract(receipt_json,'$.conversationId')=? AND json_extract(receipt_json,'$.workerId')=? LIMIT 4097").all(authorityId,claim.agentId,claim.conversationId,workerId) as Array<{identity:string;sha256:string}>;
   if(registered.length>4096)throw Error('Provider start lifetime registration inventory exceeds bound');
   if(!registered.some(ref=>{const r=retained(db,'provider-process-registration',ref);return r.schema==='provider-process-registration.v1' && ref.identity===authorityId+':'+ref.sha256 && r.authorityId===authorityId && r.projectId===claim.projectId && (!claim.runId || r.runId===claim.runId && r.runFence===claim.runFence);}))throw Error('Provider start lifetime registration missing or Run differs');
  }
  commit(db,'provider-start-settlement',identity,{schema:'provider-start-settlement.v1',claim:{identity,sha256:row.sha256},workerId,registrations:[...registrations].sort()});
 }).immediate();
}
export function holdProviderStart(db:Database.Database,identity:string):void {
 commit(db,'provider-start-unknown',identity,{schema:'provider-start-unknown.v1',identity});
}
export function requireProviderStartsDrained(db:Database.Database,agentId:string):void {
 const claims=db.prepare("SELECT identity,receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=? LIMIT 4097").all(agentId) as Array<{identity:string;sha256:string}>;
 if(claims.length>4096)throw Error('Provider start inventory exceeds bound');
 for(const ref of claims){
  const claim=retained(db,'provider-start-admission',ref);
  if(claim.schema!==CONTRACT||claim.identity!==ref.identity||claim.agentId!==agentId||!claim.workerId||!claim.projectId||!claim.conversationId)throw Error('Provider start claim scope differs');
  if(claim.generation){const f=exactFence(db,agentId,claim.projectId,claim.conversationId);if(stableJson(claim.generation)!==stableJson({executionId:f.input.executionId,stepExecutionId:f.input.stepExecutionId,generation:f.input.generation}))throw Error('Provider start original generation differs');}
  if(db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-start-unknown' AND identity=?").get(ref.identity))throw Error('Provider start remains unknown');
  const row=db.prepare("SELECT receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-settlement' AND identity=?").get(ref.identity) as {sha256:string}|undefined;
  if(!row)throw Error('Provider start remains unsettled or unknown');
  const settled=retained(db,'provider-start-settlement',{identity:ref.identity,sha256:row.sha256});
  if(stableJson(settled.claim)!==stableJson(ref)||settled.workerId!==claim.workerId||!settled.registrations.length||settled.registrations.length>4096||new Set(settled.registrations).size!==settled.registrations.length)throw Error('Provider start settlement differs');
  for(const id of settled.registrations)if(!db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='provider-process-exit' AND identity=? AND json_extract(receipt_json,'$.result')='observed_exited'").get(id))throw Error('Admitted provider lifetime exit remains unobserved');
 }
}
function noActivity(db:Database.Database,agentId:string):void {
 if(db.prepare(`SELECT 1 FROM scheduler_runs WHERE agent_id=? UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL
 SELECT 1 FROM host_lifecycle_commits WHERE kind IN ('provider-start-admission','provider-process-registration') AND json_extract(receipt_json,'$.agentId')=? LIMIT 1`).get(agentId,agentId,agentId))throw Error('Never-started member has admitted or actual activity');
}
function exactFence(db:Database.Database,agentId:string,projectId:string,conversationId:string){
 const rows=db.prepare("SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND json_extract(receipt_json,'$.input.conversationId')=? LIMIT 2").all(conversationId) as Row[];
 if(rows.length!==1)throw Error('Exact permanent generation fence required');
 const row=rows[0]!;if(Buffer.byteLength(row.receipt_json)>4*1024*1024)throw Error('Generation fence exceeds bound');
 const f=JSON.parse(row.receipt_json),i=f.input;
 if(f.schema!=='branch-generation-exit-fence.v1'||stableJson(f)!==row.receipt_json||payloadHash(f)!==row.receipt_sha256||stableJson(i)!==row.input_json||i.projectId!==projectId||i.conversationId!==conversationId||!Array.isArray(i.agentIds)||!i.agentIds.includes(agentId)||new Set(i.agentIds).size!==i.agentIds.length||!i.agentIds.length||i.agentIds.length>256||!Number.isSafeInteger(i.generation)||i.generation<0||row.identity!==payloadHash({executionId:i.executionId,stepExecutionId:i.stepExecutionId,generation:i.generation})||stableJson(f.members.map((m:any)=>m.agent_id).sort())!==stableJson([...i.agentIds].sort()))throw Error('Exact permanent generation fence differs');
 if(f.purpose!==undefined&&f.purpose!=='final-resource')throw Error('Unknown generation fence purpose');
 if(f.purpose==='final-resource'&&(!Number.isSafeInteger(i.generation)||i.generation<0||f.resource?.generation!==i.generation||f.resource.retry_draining!==0||f.resource.execution_id!==i.executionId||f.resource.step_execution_id!==i.stepExecutionId||f.resource.chat_id!==i.conversationId))throw Error('Final generation fence resource differs');
 return {fence:{identity:row.identity,sha256:row.receipt_sha256},input:i};
}
/** Server invokes only after draining runtime producers AND tracked adapter operations. */
export function sealProviderNeverStarted(db:Database.Database,workerId:string,agentIds:readonly string[]):void {
 db.transaction(()=>{
  for(const agentId of agentIds){
   requireProviderStartsDrained(db,agentId);
   const a=db.prepare('SELECT project_id,conversation_id FROM agents WHERE id=? AND deleted_at IS NULL').get(agentId) as {project_id:string;conversation_id:string}|undefined;
   if(!a?.conversation_id)throw Error('Original never-started member unavailable');
   // An actual participant uses observed exits; admissions without a handle stay held above.
   if(db.prepare('SELECT 1 FROM scheduler_runs WHERE agent_id=?').get(agentId))continue;
   noActivity(db,agentId);
   const coverageRow=db.prepare("SELECT receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-start-coverage' AND identity=?").get(agentId) as {sha256:string}|undefined;
   if(!coverageRow)throw Error('Legacy member lacks provider start coverage from creation');
   const coverage={identity:agentId,sha256:coverageRow.sha256},c=retained(db,'provider-start-coverage',coverage);
   if(c.schema!=='provider-start-coverage.v1'||c.contract!==CONTRACT||c.agentId!==agentId||c.projectId!==a.project_id||c.conversationId!==a.conversation_id||!c.workerId)throw Error('Provider start coverage differs');
   const {fence,input}=exactFence(db,agentId,a.project_id,a.conversation_id);
   const prior=db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-never-started' AND identity=?").get(agentId) as {receipt_json:string}|undefined;
   if(prior){verifyProviderNeverStarted(db,JSON.parse(prior.receipt_json));continue;}
   const drain=commit(db,'provider-start-drain',agentId,{schema:'provider-start-drain.v1',agentId,projectId:a.project_id,conversationId:a.conversation_id,workerId,fence,coverage});
   const receipt:ProviderNeverStartedReceipt={schema:'provider-never-started.v1',agentId,projectId:a.project_id,conversationId:a.conversation_id,executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation,fence,coverage,drain};
   commit(db,'provider-never-started',agentId,receipt);
  }
 }).immediate();
}
export function readProviderNeverStarted(db:Database.Database,agentId:string):{identity:string;sha256:string;receipt:ProviderNeverStartedReceipt} {
 const row=db.prepare("SELECT receipt_sha256 AS sha256 FROM host_lifecycle_commits WHERE kind='provider-never-started' AND identity=?").get(agentId) as {sha256:string}|undefined;
 if(!row)throw Error('Complete exact Run inventory required; no fenced-never-started receipt');
 const receipt=retained(db,'provider-never-started',{identity:agentId,sha256:row.sha256}) as ProviderNeverStartedReceipt;
 verifyProviderNeverStarted(db,receipt);
 return {identity:agentId,sha256:row.sha256,receipt};
}
export function verifyProviderNeverStarted(db:Database.Database,r:ProviderNeverStartedReceipt):void {
 if(r.schema!=='provider-never-started.v1'||!r.agentId||!r.projectId||!r.conversationId)throw Error('Invalid never-started receipt');
 const source=retained(db,'provider-never-started',{identity:r.agentId,sha256:payloadHash(r)});
 if(stableJson(source)!==stableJson(r))throw Error('Never-started source differs');
 noActivity(db,r.agentId);
 const c=retained(db,'provider-start-coverage',r.coverage),d=retained(db,'provider-start-drain',r.drain),f=exactFence(db,r.agentId,r.projectId,r.conversationId);
 if(r.coverage.identity!==r.agentId||r.drain.identity!==r.agentId||c.schema!=='provider-start-coverage.v1'||c.contract!==CONTRACT||!c.workerId||c.agentId!==r.agentId||c.projectId!==r.projectId||c.conversationId!==r.conversationId||d.schema!=='provider-start-drain.v1'||!d.workerId||d.agentId!==r.agentId||d.projectId!==r.projectId||d.conversationId!==r.conversationId||stableJson(d.coverage)!==stableJson(r.coverage)||stableJson(d.fence)!==stableJson(r.fence)||stableJson(f.fence)!==stableJson(r.fence)||r.executionId!==f.input.executionId||r.stepExecutionId!==f.input.stepExecutionId||r.generation!==f.input.generation)throw Error('Never-started scope/coverage/fence/drain mismatch');
}

/** Internal original rows retained by a fenced final command, never destination SQL. */
export type FinalProviderStartInventory={kind:'retained-final-resource';rows:Array<Row&{kind:string}>};
const finalStartKinds=['provider-start-coverage','provider-start-admission','provider-start-settlement','provider-start-unknown','provider-start-drain','provider-never-started','branch-generation-exit-fence'];
export function captureFinalProviderStarts(db:Database.Database,scope:{projectId:string;conversationId:string;agentIds:string[]},evidence:import('@ponderosa/core').ProviderExitEvidence):FinalProviderStartInventory {
 if(!db.inTransaction)throw Error('Final start inventory requires owner transaction');
 for(const agent of scope.agentIds)requireProviderStartsDrained(db,agent);
 const rows=db.prepare(`SELECT kind,identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits
  WHERE kind IN (${finalStartKinds.map(()=>'?').join(',')}) AND (
   json_extract(receipt_json,'$.conversationId')=? OR json_extract(receipt_json,'$.input.conversationId')=?
   OR json_extract(receipt_json,'$.agentId') IN (SELECT value FROM json_each(?))
   OR kind IN ('provider-start-settlement','provider-start-unknown') AND identity IN (
    SELECT identity FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId') IN (SELECT value FROM json_each(?))))
  ORDER BY kind,identity LIMIT 4097`).all(...finalStartKinds,scope.conversationId,scope.conversationId,stableJson(scope.agentIds),stableJson(scope.agentIds)) as Array<Row&{kind:string}>;
 const inventory:FinalProviderStartInventory={kind:'retained-final-resource',rows};
 verifyFinalProviderStarts(inventory,scope,evidence);
 return inventory;
}

/** Structural checks only. Native capture supplies a live census; portable completeness remains unsupported. */
export function verifyFinalProviderStarts(source:FinalProviderStartInventory,scope:{projectId:string;conversationId:string;agentIds:string[]},evidence:import('@ponderosa/core').ProviderExitEvidence):void {
 if(source.kind!=='retained-final-resource'||source.rows.length>4096||Buffer.byteLength(stableJson(source))>16*1024*1024)throw Error('Final provider start inventory exceeds bound');
 if(evidence.projectId!==scope.projectId||evidence.conversationId!==scope.conversationId||stableJson(evidence.participants.map(p=>p.agentId).sort())!==stableJson([...scope.agentIds].sort()))throw Error('Final provider scope differs');
 const seen=new Set<string>(),values=new Map<string,any>();
 for(const row of source.rows){
  const key=`${row.kind}:${row.identity}`;
  if(seen.has(key)||!finalStartKinds.includes(row.kind)||Buffer.byteLength(row.receipt_json)>4*1024*1024)throw Error('Final provider start identity differs');
  seen.add(key);const value=JSON.parse(row.receipt_json);
  if(stableJson(value)!==row.receipt_json||payloadHash(value)!==row.receipt_sha256||row.input_json!==(row.kind==='branch-generation-exit-fence'?stableJson(value.input):row.receipt_json))throw Error('Final provider start canonical bytes differ');
  values.set(key,value);
 }
 const get=(kind:string,ref:{identity:string;sha256:string})=>{
  const row=source.rows.find(r=>r.kind===kind&&r.identity===ref.identity);
  if(!row||row.receipt_sha256!==ref.sha256)throw Error('Final provider start proof unavailable');
  return values.get(`${kind}:${ref.identity}`);
 };
 const fences=source.rows.filter(r=>r.kind==='branch-generation-exit-fence');
 if(fences.length!==1)throw Error('Exact final provider fence required');
 const fenceRow=fences[0]!,f=values.get(`branch-generation-exit-fence:${fenceRow.identity}`),i=f.input;
 if(f.schema!=='branch-generation-exit-fence.v1'||f.purpose!=='final-resource'||i.projectId!==scope.projectId||i.conversationId!==scope.conversationId||!Number.isSafeInteger(i.generation)||i.generation<0
  ||f.resource?.generation!==i.generation||f.resource.retry_draining!==0||f.resource.execution_id!==i.executionId||f.resource.step_execution_id!==i.stepExecutionId||f.resource.chat_id!==i.conversationId
  ||fenceRow.identity!==payloadHash({executionId:i.executionId,stepExecutionId:i.stepExecutionId,generation:i.generation})
  ||stableJson(i.agentIds)!==stableJson([...scope.agentIds].sort())||stableJson(f.members.map((m:any)=>m.agent_id).sort())!==stableJson(i.agentIds))throw Error('Final provider fence differs');
 const fence={identity:fenceRow.identity,sha256:fenceRow.receipt_sha256};
 const registrations=evidence.receipts.flatMap(e=>e.receipt.registrations.map(r=>r.registration));
 for(const row of source.rows){
  const value=values.get(`${row.kind}:${row.identity}`);
  if(row.kind==='branch-generation-exit-fence')continue;
  if(row.kind==='provider-start-unknown')throw Error('Final provider start remains unknown');
  if(row.kind==='provider-start-settlement'){
   const claim=value.claim&&source.rows.find(r=>r.kind==='provider-start-admission'&&r.identity===value.claim.identity&&r.identity===row.identity&&r.receipt_sha256===value.claim.sha256);
   if(!claim)throw Error('Orphan final provider settlement');
   continue;
  }
  if(value.projectId!==scope.projectId||value.conversationId!==scope.conversationId||!scope.agentIds.includes(value.agentId))throw Error('Final provider start scope differs');
 }
 for(const agentId of scope.agentIds){
  const coverageRow=source.rows.find(r=>r.kind==='provider-start-coverage'&&r.identity===agentId);
  if(!coverageRow)throw Error('Final provider creation coverage unavailable');
  const coverage={identity:agentId,sha256:coverageRow.receipt_sha256},c=get('provider-start-coverage',coverage);
  if(c.schema!=='provider-start-coverage.v1'||c.contract!==CONTRACT||!c.workerId||c.agentId!==agentId)throw Error('Final provider coverage differs');
  const claims=source.rows.filter(r=>r.kind==='provider-start-admission'&&values.get(`${r.kind}:${r.identity}`).agentId===agentId);
  for(const row of claims){
   const claim=values.get(`${row.kind}:${row.identity}`),ref={identity:row.identity,sha256:row.receipt_sha256};
   if(claim.schema!==CONTRACT||claim.identity!==row.identity||!claim.workerId||!claim.operation||stableJson(claim.generation)!==stableJson({executionId:i.executionId,stepExecutionId:i.stepExecutionId,generation:i.generation}))throw Error('Final provider admission differs');
   const settledRow=source.rows.find(r=>r.kind==='provider-start-settlement'&&r.identity===row.identity);
   if(!settledRow)throw Error('Final provider admission unsettled');
   const settled=values.get(`${settledRow.kind}:${settledRow.identity}`);
   if(settled.schema!=='provider-start-settlement.v1'||stableJson(settled.claim)!==stableJson(ref)||settled.workerId!==claim.workerId||!Array.isArray(settled.registrations)||!settled.registrations.length||settled.registrations.length>4096||new Set(settled.registrations).size!==settled.registrations.length)throw Error('Final provider settlement differs');
   for(const id of settled.registrations)if(!evidence.receipts.some(r=>r.identity===id)||!registrations.some(r=>r.authorityId===id&&r.agentId===agentId&&r.workerId===claim.workerId))throw Error('Final admitted lifetime lacks observed exit');
  }
  const participant=evidence.participants.find(p=>p.agentId===agentId)!;
  if(!participant.runIds.length){
   if(claims.length||registrations.some(r=>r.agentId===agentId)||evidence.runs.some(r=>r.agentId===agentId))throw Error('Final never-started participant has activity');
   const n=evidence.schema==='provider-exit-evidence.v2'?evidence.neverStarted.find(n=>n.identity===agentId):undefined;
   if(!n||stableJson(get('provider-never-started',{identity:agentId,sha256:n.sha256}))!==stableJson(n.receipt))throw Error('Final never-started original receipt missing');
   const r=n.receipt,d=get('provider-start-drain',r.drain);
   if(r.schema!=='provider-never-started.v1'||r.executionId!==i.executionId||r.stepExecutionId!==i.stepExecutionId||r.generation!==i.generation||stableJson(r.fence)!==stableJson(fence)||stableJson(r.coverage)!==stableJson(coverage)||r.drain.identity!==agentId
    ||d.schema!=='provider-start-drain.v1'||!d.workerId||d.agentId!==agentId||stableJson(d.fence)!==stableJson(fence)||stableJson(d.coverage)!==stableJson(coverage))throw Error('Final never-started fence/coverage/drain differs');
  }else if(source.rows.some(r=>r.kind==='provider-never-started'&&r.identity===agentId))throw Error('Final started participant has never-started receipt');
 }
}
