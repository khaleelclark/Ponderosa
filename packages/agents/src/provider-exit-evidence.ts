import {readProviderNeverStarted,verifyProviderNeverStarted,requireProviderStartsDrained} from './provider-start-journal.js';
import type Database from 'better-sqlite3';
import type {ProviderExitEvidence,ProviderProcessExitReceipt,ProviderProcessRegistration} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';

type Commit={identity:string;input_json:string;receipt_json:string;receipt_sha256:string};
function read<T>(row:Commit):T {
 if(Buffer.byteLength(row.receipt_json)>4*1024*1024)throw Error('Provider exit evidence exceeds bound');
 const value=JSON.parse(row.receipt_json);
 if(stableJson(value)!==row.receipt_json||payloadHash(value)!==row.receipt_sha256||row.input_json!==row.receipt_json)throw Error('Provider exit evidence integrity failure');
 return value as T;
}

/** Call while the exact generation is still pinned. Empty/missing coverage never proves exit. */
export function readProviderExitEvidence(db:Database.Database,input:{projectId:string;conversationId:string;participants:Array<{agentId:string;runIds:string[]}>;expectedRevision?:string}):ProviderExitEvidence {
 return db.transaction(()=>{
  if(!input.projectId||!input.conversationId||!input.participants.length||input.participants.length>256)throw Error('Exact provider exit scope required');
  const participants=input.participants.map(p=>({agentId:p.agentId,runIds:[...p.runIds].sort()})).sort((a,b)=>a.agentId.localeCompare(b.agentId));
  if(new Set(participants.map(p=>p.agentId)).size!==participants.length)throw Error('Duplicate provider exit participant');
  const chat=db.prepare('SELECT project_id FROM conversations WHERE id=?').get(input.conversationId) as {project_id:string}|undefined;
  const members=db.prepare('SELECT id FROM agents WHERE conversation_id=? AND deleted_at IS NULL ORDER BY id').all(input.conversationId) as Array<{id:string}>;
  if(!chat||chat.project_id!==input.projectId||stableJson(members.map(m=>m.id).sort())!==stableJson(participants.map(p=>p.agentId).sort()))throw Error('Complete live precleanup Chat member inventory required');
  const exits=new Map<string,ProviderExitEvidence['receipts'][number]>();
  const terminalRuns:ProviderExitEvidence['runs']=[];
  const neverStarted:Array<ReturnType<typeof readProviderNeverStarted>>=[];
  let totalRows=0,totalBytes=0;
  for(const participant of participants){
   if(!participant.agentId||participant.runIds.length>4096||new Set(participant.runIds).size!==participant.runIds.length)throw Error('Complete exact Run inventory required');
   requireProviderStartsDrained(db,participant.agentId);
   if(!participant.runIds.length){
    const item=readProviderNeverStarted(db,participant.agentId);
    if(item.receipt.projectId!==input.projectId||item.receipt.conversationId!==input.conversationId)throw Error('Never-started participant scope mismatch');
    neverStarted.push(item);continue;
   }
   const runs=db.prepare('SELECT id,status,fencing_token FROM scheduler_runs WHERE agent_id=? ORDER BY id LIMIT 4097').all(participant.agentId) as Array<{id:string;status:string;fencing_token:number}>;
   if(runs.length>4096||stableJson(runs.map(r=>r.id).sort())!==stableJson(participant.runIds))throw Error('Complete original participant Run inventory required');
   for(const run of runs){if(!['completed','failed','cancelled'].includes(run.status)||!Number.isSafeInteger(run.fencing_token)||run.fencing_token<1)throw Error('Provider Run remains live or unknown');terminalRuns.push({runId:run.id,agentId:participant.agentId,fence:run.fencing_token,status:run.status as 'completed'|'failed'|'cancelled'});}
   if(db.prepare(`SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') LIMIT 1`).get(participant.agentId,participant.agentId))throw Error('Provider participant remains live or unknown');
   // All retained registrations for the original Chat must be included, including readiness/recovery.
   const rows=db.prepare(`SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.agentId')=? AND json_extract(receipt_json,'$.conversationId')=? ORDER BY identity LIMIT 4097`).all(participant.agentId,input.conversationId) as Commit[];
   if(!rows.length||rows.length>4096)throw Error('Provider registration coverage missing or exceeds bound');
   totalRows+=rows.length;totalBytes+=rows.reduce((n,r)=>n+Buffer.byteLength(r.receipt_json),0);
   if(totalRows>4096||totalBytes>16*1024*1024)throw Error('Provider exit inventory exceeds bound');
   const covered=new Set<string>();
   for(const row of rows){
    const registration=read<ProviderProcessRegistration>(row);
    if(registration.schema!=='provider-process-registration.v1'||registration.projectId!==input.projectId||registration.agentId!==participant.agentId||registration.conversationId!==input.conversationId||(registration.runId!==null&&(!participant.runIds.includes(registration.runId)||!Number.isSafeInteger(registration.runFence)||(registration.runFence??0)<1))||(registration.runId===null&&registration.runFence!==null))throw Error('Provider registration scope/Run coverage mismatch');
    const run=registration.runId?db.prepare('SELECT project_id,agent_id,fencing_token,status FROM scheduler_runs WHERE id=?').get(registration.runId) as {project_id:string;agent_id:string;fencing_token:number;status:string}|undefined:undefined;
    // Before cleanup the caller must still bind the original canonical Run and generation.
    if(registration.runId&&(!run||run.project_id!==input.projectId||run.agent_id!==participant.agentId||run.fencing_token<(registration.runFence??Infinity)||!['completed','failed','cancelled'].includes(run.status)))throw Error('Original terminal Run evidence missing or changed');
    const exitRow=db.prepare(`SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-exit' AND identity=?`).get(registration.authorityId) as Commit|undefined;
    if(!exitRow)throw Error('Provider exit has not been observed');
    const receipt=read<ProviderProcessExitReceipt>(exitRow);
    if(receipt.schema!=='provider-process-exit.v1'||receipt.authorityId!==registration.authorityId||receipt.operationId!==`provider-exit:${registration.authorityId}`||receipt.result!=='observed_exited'||!['os-not-alive','close-confirmed'].includes(receipt.observation)||!Number.isFinite(Date.parse(receipt.observedAt)))throw Error('Invalid observed provider exit receipt');
    const retained=receipt.registrations.find(r=>r.identity===row.identity);
    if(!retained||retained.sha256!==row.receipt_sha256||stableJson(retained.registration)!==row.receipt_json)throw Error('Provider exit registration revision mismatch');
    if(registration.runId)covered.add(registration.runId);
    exits.set(exitRow.identity,{identity:exitRow.identity,sha256:exitRow.receipt_sha256,receipt});
   }
   if(participant.runIds.some(id=>!covered.has(id)))throw Error('Run lacks actual registered process exit evidence');
  }
  const evidence={...(neverStarted.length?{schema:'provider-exit-evidence.v2' as const,neverStarted}:{schema:'provider-exit-evidence.v1' as const}),projectId:input.projectId,conversationId:input.conversationId,participants,runs:terminalRuns,receipts:[...exits.values()].sort((a,b)=>a.identity.localeCompare(b.identity))};
  if(Buffer.byteLength(stableJson(evidence))>16*1024*1024)throw Error('Provider exit evidence exceeds bound');
  const revision=payloadHash(evidence);
  if(input.expectedRevision&&input.expectedRevision!==revision)throw Error('Provider exit evidence revision changed');
  verifyRetainedProviderExitEvidence(db,{...evidence,revision});
  return {...evidence,revision};
 })();
}

/** Structural proof only; authoritative commit, start and inventory checks remain in the native wrapper. */
function providerExitInventory(evidence:ProviderExitEvidence) {
 if(Buffer.byteLength(stableJson(evidence))>16*1024*1024)throw Error('Retained provider evidence exceeds bound');
 const {revision,...body}=evidence;
 if(!['provider-exit-evidence.v1','provider-exit-evidence.v2'].includes(body.schema)||payloadHash(body)!==revision||(body.schema==='provider-exit-evidence.v1'&&!body.receipts.length))throw Error('Retained provider exit evidence hash mismatch');
 const neverStarted=body.schema==='provider-exit-evidence.v2'?body.neverStarted:[];
 if(!Array.isArray(neverStarted)||neverStarted.length>256||new Set(neverStarted.map(n=>n.identity)).size!==neverStarted.length||(body.schema==='provider-exit-evidence.v2'&&!neverStarted.length))throw Error('Retained never-started inventory invalid');
 for(const item of neverStarted){
  const p=body.participants.find(p=>p.agentId===item.identity);
  if(!p||p.runIds.length||item.identity!==item.receipt.agentId||item.sha256!==payloadHash(item.receipt)||item.receipt.projectId!==body.projectId||item.receipt.conversationId!==body.conversationId)throw Error('Retained never-started participant mismatch');
 }
 if(!body.participants.length||body.participants.length>256||body.participants.some(p=>(!p.runIds.length&&!neverStarted.some(n=>n.identity===p.agentId))||p.runIds.length>4096)||body.runs.length>4096||body.receipts.length>4096)throw Error('Retained provider inventory exceeds bound');
 const expected=new Map(body.participants.flatMap(p=>p.runIds.map(id=>[id,p.agentId] as const)));
 if((!expected.size&&!neverStarted.length)||expected.size!==body.participants.reduce((n,p)=>n+p.runIds.length,0)||new Set(body.participants.map(p=>p.agentId)).size!==body.participants.length||body.runs.length!==expected.size)throw Error('Retained provider Run/member inventory mismatch');
 const runs=new Map(body.runs.map(run=>[run.runId,run]));
 if(runs.size!==expected.size)throw Error('Retained provider Run inventory mismatch');
 for(const [id,agent] of expected){const run=runs.get(id);if(!run||run.agentId!==agent||!Number.isSafeInteger(run.fence)||run.fence<1||!['completed','failed','cancelled'].includes(run.status))throw Error('Retained terminal Run evidence mismatch');}
 const covered=new Set<string>(),identities=new Set<string>(),registrationIds=new Set<string>();
 for(const item of body.receipts){
  const receipt=item.receipt;
  if(identities.has(item.identity)||receipt.schema!=='provider-process-exit.v1'||receipt.authorityId!==item.identity||receipt.operationId!==`provider-exit:${item.identity}`||receipt.result!=='observed_exited'||!['os-not-alive','close-confirmed'].includes(receipt.observation)||!Number.isFinite(Date.parse(receipt.observedAt))||!receipt.registrations.length)throw Error('Retained provider observation mismatch');
  identities.add(item.identity);
  if(item.sha256!==payloadHash(receipt))throw Error('Retained provider exit receipt mismatch');
  for(const registration of item.receipt.registrations){
   if(registrationIds.has(registration.identity)||registrationIds.size>=4096)throw Error('Retained provider registration inventory mismatch');
   registrationIds.add(registration.identity);
   const r=registration.registration,run=r.runId?runs.get(r.runId):undefined;
   if(r.schema!=='provider-process-registration.v1'||r.authorityId!==item.identity||r.projectId!==body.projectId||r.conversationId!==body.conversationId||!body.participants.some(p=>p.agentId===r.agentId&&p.runIds.length)||registration.identity!==`${item.identity}:${payloadHash(r)}`||registration.sha256!==payloadHash(r))throw Error('Retained provider registration scope mismatch');
   if(r.process.kind==='posix'){const p=r.process.identity;if(!Number.isSafeInteger(p.pid)||p.pid<1||!Number.isSafeInteger(p.pgid)||p.pgid<1||!p.birthMarker)throw Error('Retained POSIX identity missing');}
   else if(r.process.kind!=='native-job'||r.process.lifetimeId!==item.identity)throw Error('Retained native lifetime missing');
   if(r.runId){if(!run||run.agentId!==r.agentId||!Number.isSafeInteger(r.runFence)||(r.runFence??0)<1||(r.runFence??Infinity)>run.fence)throw Error('Retained provider Run fence mismatch');covered.add(r.runId);}
   else if(r.runFence!==null)throw Error('Unbound provider fence');
  }
 }
 if([...expected.keys()].some(id=>!covered.has(id)))throw Error('Retained provider Run coverage incomplete');
 return {body,neverStarted,registrationIds};
}

/** Immutable native readback after deletion; never substitutes structural proof for live authority. */
export function verifyRetainedProviderExitEvidence(db:Database.Database,evidence:ProviderExitEvidence):void {
 const {body,neverStarted,registrationIds}=providerExitInventory(evidence);
 for(const item of neverStarted)verifyProviderNeverStarted(db,item.receipt);
 for(const p of body.participants)requireProviderStartsDrained(db,p.agentId);
 for(const item of body.receipts){
  const row=db.prepare(`SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-exit' AND identity=?`).get(item.identity) as Commit|undefined;
  if(!row||row.receipt_sha256!==item.sha256||stableJson(read(row))!==stableJson(item.receipt))throw Error('Retained provider exit receipt mismatch');
  for(const registration of item.receipt.registrations){
   const source=db.prepare(`SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND identity=?`).get(registration.identity) as Commit|undefined;
   if(!source||source.receipt_sha256!==registration.sha256||stableJson(read(source))!==stableJson(registration.registration))throw Error('Retained provider registration mismatch');
  }
 }
 for(const p of body.participants){
  const rows=db.prepare("SELECT identity FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.agentId')=? AND json_extract(receipt_json,'$.conversationId')=? LIMIT 4097").all(p.agentId,body.conversationId) as Array<{identity:string}>;
  if(rows.length>4096||rows.some(r=>!registrationIds.has(r.identity)))throw Error('Retained provider registration inventory changed');
 }
}

export type FinalProviderExitInventory={kind:'retained-final-resource';commits:Array<Commit&{kind:string}>;runs:Array<{id:string;agent_id:string;project_id:string;fencing_token:number;status:string}>};
export function captureFinalProviderExits(db:Database.Database,evidence:ProviderExitEvidence):FinalProviderExitInventory {
 if(!db.inTransaction)throw Error('Final provider exit census requires owner transaction');
 verifyRetainedProviderExitEvidence(db,evidence);
 const agents=stableJson(evidence.participants.map(p=>p.agentId));
 const commits=db.prepare(`SELECT kind,identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE
  kind='provider-process-registration' AND json_extract(receipt_json,'$.agentId') IN (SELECT value FROM json_each(?))
  OR kind='provider-process-exit' AND identity IN (SELECT value FROM json_each(?)) ORDER BY kind,identity LIMIT 4097`).all(agents,stableJson(evidence.receipts.map(r=>r.identity))) as Array<Commit&{kind:string}>;
 const runs=db.prepare('SELECT id,agent_id,project_id,fencing_token,status FROM scheduler_runs WHERE agent_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 4097').all(agents) as FinalProviderExitInventory['runs'];
 const inventory:FinalProviderExitInventory={kind:'retained-final-resource',commits,runs};
 verifyFinalProviderExits(inventory,evidence);return inventory;
}
/** Structural inventory comparison only; enclosing portable command/fact hashes do not prove completeness. */
export function verifyFinalProviderExits(source:FinalProviderExitInventory,evidence:ProviderExitEvidence):void {
 const {body,registrationIds}=providerExitInventory(evidence);
 if(source.kind!=='retained-final-resource'||source.commits.length>4096||source.runs.length>4096||Buffer.byteLength(stableJson(source))>16*1024*1024)throw Error('Final provider census exceeds bound');
 const expected=new Map(body.runs.map(r=>[r.runId,r]));
 if(source.runs.length!==expected.size||new Set(source.runs.map(r=>r.id)).size!==expected.size)throw Error('Final original Run census differs');
 for(const r of source.runs){const e=expected.get(r.id);if(!e||r.agent_id!==e.agentId||r.project_id!==body.projectId||r.fencing_token!==e.fence||r.status!==e.status)throw Error('Final original terminal Run differs');}
 const seen=new Set<string>();
 for(const row of source.commits){
  const key=`${row.kind}:${row.identity}`;
  if(seen.has(key))throw Error('Final provider commit aliases');seen.add(key);
  const value=read(row);
  if(row.kind==='provider-process-exit'){
   const item=body.receipts.find(r=>r.identity===row.identity);
   if(!item||row.receipt_sha256!==item.sha256||stableJson(value)!==stableJson(item.receipt))throw Error('Final observed exit commit differs');
  }else if(row.kind==='provider-process-registration'){
   const item=body.receipts.flatMap(r=>r.receipt.registrations).find(r=>r.identity===row.identity);
   if(!item||row.receipt_sha256!==item.sha256||stableJson(value)!==stableJson(item.registration))throw Error('Final complete registration census differs');
  }else throw Error('Unknown final provider commit kind');
 }
 if(body.receipts.some(r=>!seen.has(`provider-process-exit:${r.identity}`))||[...registrationIds].some(id=>!seen.has(`provider-process-registration:${id}`)))throw Error('Final provider commit coverage incomplete');
}
