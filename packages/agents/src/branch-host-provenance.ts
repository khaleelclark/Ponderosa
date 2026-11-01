import type Database from 'better-sqlite3';
import type {BranchHostCut} from './branch-host-cut.js';
import {retainedBranchHostGraph} from './branch-tree-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
export type HostProvenance={restorations:{row:Row;sha256:string}[];origins:{row:Row;sha256:string}[]};

/** Structural destination identity only; historical actors/payloads remain original evidence. */
export function restoredScopeValue(map:Row,key:string,value:unknown):unknown {
 const destination=map.destination;
 if(!destination)return value;
 if(key==='project_id')return destination.projectId;
 if(key==='conversation_id')return destination.conversationId;
 if(['requester_agent_id','recipient_agent_id','owner_agent_id'].includes(key)){
  if(value===null)return null;
  const id=destination.agentMap?.[String(value)];if(typeof id!=='string'||!id)throw Error('Historical destination participant mapping unavailable');return id;
 }
 return value;
}
export function retainedRestorationSnapshot(db:Database.Database,receipt:Row):Row|undefined {
 const saved=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(receipt.checkpoint_id,receipt.source_execution_id) as Row|undefined;
 if(saved)return saved;
 const destination=JSON.parse(receipt.receipt_json).destination;
 if(!destination)return;
 const row=db.prepare("SELECT snapshot_json,reservation_json FROM coordination_destination_admissions WHERE id=? AND state='admitted'").get(destination.admissionId) as Row|undefined;
 if(row)return {snapshot_json:row.snapshot_json,content_hash:JSON.parse(row.reservation_json).checkpointHash};
}

const imported=(u:Row)=>u.kind==='historical_question'||u.kind==='historical_answer'||u.actor_kind==='system'&&u.actor_id==='host-cut-restoration';
const evidence=(row:Row)=>({row,sha256:payloadHash(row)});

/** Captured with the Branch frontier. No live receipt or mutable Request is replay authority. */
export function captureHostProvenance(db:Database.Database,requests:Row[],updates:Row[]):HostProvenance|undefined {
 if(!db.inTransaction)throw Error('Historical provenance capture requires the owner transaction');
 const origins=updates.flatMap(u=>{
  const origin=db.prepare('SELECT * FROM coordination_restored_update_origins WHERE update_id=?').get(u.id) as Row|undefined;
  if(!origin&&imported(u))throw Error('Historical update origin unavailable');
  return origin?[evidence(origin)]:[];
 });
 const ids=new Set<string>(origins.map(o=>o.row.restoration_id));
 for(const r of requests){const origin=JSON.parse(r.payload_json)?.historicalOrigin;if(origin?.historical===true&&typeof origin.restorationId==='string')ids.add(origin.restorationId);}
 if(!ids.size)return;
 const restorations=[...ids].sort().map(id=>{
  const receipt=db.prepare('SELECT * FROM coordination_cut_restorations WHERE id=?').get(id) as Row|undefined;
  const saved=receipt&&retainedRestorationSnapshot(db,receipt) as Row|undefined;
  if(!receipt||!saved||saved.content_hash!==receipt.cut_hash)throw Error('Historical provenance source cut unavailable');
  const snapshot=JSON.parse(saved.snapshot_json);
  if(stableJson(snapshot)!==saved.snapshot_json||payloadHash(snapshot)!==receipt.cut_hash)throw Error('Historical provenance source cut differs');
  const destination=JSON.parse(receipt.receipt_json).destination;
  const admission=destination?db.prepare("SELECT * FROM coordination_destination_admissions WHERE id=? AND state='admitted'").get(destination.admissionId):undefined;
  if(destination&&!admission)throw Error('Historical destination admission receipt unavailable');
  return evidence({id,receipt,snapshot,...(admission?{admission}:{})});
 });
 return {restorations,origins};
}

class HostFacts {
 private active=new Set<string>();
 private checked=new Set<BranchHostCut>();
 private sources=new Map<string,BranchHostCut>();
 private sourceProofs=new Map<string,string>();
 private count=0;
 private source(cut:BranchHostCut,id:string):{cut:BranchHostCut;receipt:Row;map:Row} {
  const proof=cut.provenance?.restorations.find(e=>e.row.id===id);
  if(!proof||proof.sha256!==payloadHash(proof.row))throw Error('Historical provenance receipt unavailable');
  const prior=this.sourceProofs.get(id);
  if(prior&&prior!==proof.sha256)throw Error('Historical provenance source conflicts');
  this.sourceProofs.set(id,proof.sha256);
  const {receipt,snapshot}=proof.row,map=JSON.parse(receipt.receipt_json);
  if(receipt.id!==id||snapshot.selected?.execution?.[0]?.id!==receipt.source_execution_id||snapshot.selected?.execution?.[0]?.branch_id!==receipt.branch_id
   ||payloadHash(snapshot)!==receipt.cut_hash||map.replayed!==false||map.restorationId!==id||map.checkpointId!==receipt.checkpoint_id||map.checkpointHash!==receipt.cut_hash)throw Error('Historical provenance receipt differs');
  let source=this.sources.get(id);
  if(!source){source=retainedBranchHostGraph(snapshot,receipt.source_execution_id,false,Boolean(map.destination)).cut;this.sources.set(id,source);}
  for(const [field,records] of [['requestMap',source.requests],['updateMap',source.updates],['joinMap',source.joins]] as const){
   const mapping=map[field],ids=records.map(e=>e.row.id).sort();
   if(!mapping||stableJson(Object.keys(mapping).sort())!==stableJson(ids)||new Set(Object.values(mapping)).size!==ids.length||Object.values(mapping).some(value=>typeof value!=='string'||!value||ids.includes(value)))throw Error('Historical provenance canonical map differs');
  }
  if(map.destination){
   const admission=proof.row.admission,final=admission?.receipt_json&&JSON.parse(admission.receipt_json),reservation=admission?.reservation_json&&JSON.parse(admission.reservation_json),stage=admission?.stage_json&&JSON.parse(admission.stage_json);
   if(!admission||admission.id!==map.destination.admissionId||admission.state!=='admitted'||!final||final.restorationId!==id
    ||final.reservationHash!==admission.reservation_hash||payloadHash(reservation)!==admission.reservation_hash
    ||final.stageHash!==payloadHash(stage)||final.checkpointHash!==receipt.cut_hash
    ||stableJson(final.destination)!==stableJson(reservation.destination)
    ||map.destination.projectId!==final.destination.projectId||map.destination.conversationId!==final.destination.conversationId
    ||stableJson(map.destination.agentMap)!==stableJson(stage.agentMap)||stableJson(map.destination.artifactMap)!==stableJson(stage.artifactMap)
    ||['requestMap','updateMap','joinMap'].some(k=>stableJson(map[k])!==stableJson(final[k])))throw Error('Historical destination admission proof differs');
  }
  this.verify(source);
  return {cut:source,receipt,map};
 }
 verify(cut:BranchHostCut):void {
  if(this.checked.has(cut))return;
  if(++this.count>128||this.active.size>=32)throw Error('Historical provenance exceeds chain bound');
  const key=payloadHash(cut);
  if(this.active.has(key))throw Error('Historical provenance cycle');
  this.active.add(key);
  const p=cut.provenance;
  if(p){
   for(const list of [p.restorations,p.origins])if(!Array.isArray(list)||list.length>512||new Set(list.map(e=>e.row.id??e.row.update_id)).size!==list.length||list.some(e=>payloadHash(e.row)!==e.sha256))throw Error('Historical provenance inventory differs');
   for(const o of p.origins)if(!cut.updates.some(u=>u.row.id===o.row.update_id))throw Error('Historical origin escapes captured updates');
   for(const r of p.restorations)if(!p.origins.some(o=>o.row.restoration_id===r.row.id)&&!cut.requests.some(q=>JSON.parse(q.row.payload_json)?.historicalOrigin?.restorationId===r.row.id))throw Error('Historical receipt escapes captured facts');
  }
  for(const {row:r} of cut.requests)this.request(cut,r);
  for(const {row:u} of cut.updates)this.update(cut,u);
  for(const proof of p?.restorations??[]){
   const source=this.source(cut,proof.row.id);
   for(const {row:j} of cut.joins){
    const original=source.cut.joins.find(e=>source.map.joinMap[e.row.id]===j.id)?.row;if(!original)continue;
    const members=source.cut.members.filter(e=>e.row.join_id===original.id).sort((a,b)=>a.row.position-b.row.position).map(e=>({join_id:j.id,request_id:source.map.requestMap[e.row.request_id],position:e.row.position}));
    const continuations=JSON.parse(original.continuation_request_ids_json).map((id:string)=>source.map.requestMap[id]);
    if(['project_id','conversation_id','owner_agent_id','mode','quorum','wake_policy','satisfying_outcomes_json','deadline_at'].some(k=>j[k]!==restoredScopeValue(source.map,k,original[k]))
     ||j.continuation_request_ids_json!==stableJson(continuations)||stableJson(cut.members.filter(e=>e.row.join_id===j.id).map(e=>e.row).sort((a,b)=>a.position-b.position))!==stableJson(members)
     ||j.definition_hash!==payloadHash({restorationId:source.receipt.id,source:original.definition_hash,members:members.map(m=>m.request_id),continuations}))throw Error('Historical Join provenance differs');
   }
   for(const {row:s} of cut.suspensions){
    const original=source.cut.suspensions.find(e=>source.map.updateMap[e.row.question_update_id]===s.question_update_id)?.row;if(!original)continue;
    if(s.request_id!==source.map.requestMap[original.request_id]||s.owner_agent_id!==restoredScopeValue(source.map,'owner_agent_id',original.owner_agent_id)||s.dependency_kind!==original.dependency_kind||s.dependency_id!==source.map.joinMap[original.dependency_id])throw Error('Historical suspension provenance differs');
   }
  }
  this.active.delete(key);this.checked.add(cut);
 }
 request(cut:BranchHostCut,r:Row):unknown {
  const payload=JSON.parse(r.payload_json),origin=payload?.historicalOrigin;
  if(!cut.provenance?.restorations.some(e=>Object.values(JSON.parse(e.row.receipt.receipt_json).requestMap??{}).includes(r.id))){
   if(origin?.historical===true&&Object.hasOwn(payload,'historicalPayload'))throw Error('Historical Request provenance unavailable');
   return payload;
  }
  if(!origin||stableJson(payload)!==r.payload_json)throw Error('Historical Request provenance unavailable');
  const source=this.source(cut,origin.restorationId),old=source.cut.requests.find(e=>e.row.id===origin.sourceRequestId)?.row;
  if(!old||source.map.requestMap[old.id]!==r.id||stableJson(origin)!==stableJson({restorationId:source.receipt.id,sourceRequestId:old.id,historical:true})
   ||['project_id','conversation_id','requester_agent_id','recipient_agent_id'].some(k=>r[k]!==restoredScopeValue(source.map,k,old[k]))||stableJson(payload.historicalPayload)!==old.payload_json)throw Error('Historical Request provenance differs');
  return this.request(source.cut,old);
 }
 update(cut:BranchHostCut,u:Row):{kind:string;payload:unknown;actor:{kind:string;id:string};row:Row} {
  const payload=JSON.parse(u.payload_json),origin=cut.provenance?.origins.find(e=>e.row.update_id===u.id)?.row;
  if(!origin){if(imported(u))throw Error('Historical update provenance unavailable');return {kind:u.kind,payload,actor:{kind:u.actor_kind,id:u.actor_id},row:u};}
  const source=this.source(cut,origin.restoration_id),old=source.cut.updates.find(e=>e.row.id===origin.source_update_id)?.row;
  if(!old||old.request_id!==origin.source_request_id||old.kind!==origin.source_kind||old.payload_hash!==origin.source_payload_hash
   ||old.resulting_version!==origin.source_resulting_version||old.payload_hash!==payloadHash(JSON.parse(old.payload_json))||stableJson({kind:old.actor_kind,id:old.actor_id})!==origin.source_actor_json
   ||source.map.updateMap[old.id]!==u.id||source.map.requestMap[old.request_id]!==u.request_id
   ||(old.in_reply_to_update_id&&!source.map.updateMap[old.in_reply_to_update_id])||(u.in_reply_to_update_id??null)!==(old.in_reply_to_update_id?source.map.updateMap[old.in_reply_to_update_id]:null)
   ||u.actor_kind!=='system'||u.actor_id!=='host-cut-restoration'||u.resulting_version!==old.resulting_version||u.resulting_state!==old.resulting_state
   ||u.kind!==(old.kind==='question'?'historical_question':old.kind==='answer'?'historical_answer':old.kind)
   ||stableJson(payload)!==u.payload_json||payloadHash(payload)!==u.payload_hash||stableJson(payload.historicalPayload)!==old.payload_json
   ||stableJson(payload.historicalOrigin)!==stableJson({restorationId:source.receipt.id,sourceRequestId:old.request_id,sourceUpdateId:old.id,sourceKind:old.kind,sourcePayloadHash:old.payload_hash,sourceVersion:old.resulting_version,historical:true}))throw Error('Historical update provenance differs');
  return this.update(source.cut,old);
 }
}
export function verifyHostProvenance(cut:BranchHostCut):void {new HostFacts().verify(cut);}
export function hostRequestPayload(cut:BranchHostCut,r:Row):unknown {const facts=new HostFacts();facts.verify(cut);return facts.request(cut,r);}
export function hostUpdateFact(cut:BranchHostCut,u:Row):ReturnType<HostFacts['update']> {const facts=new HostFacts();facts.verify(cut);return facts.update(cut,u);}

export function coordinationLineageSupported(db:Database.Database,line:Row,snapshot:Row):boolean {
 try {
  const tree=snapshot.continuation?.schema==='ponderosa.branch.script-tree-continuation.v1';
  const issued=(tree?snapshot.continuation.owners:[{selected:snapshot.selected}]).some((o:Row)=>o.selected.attempts.some((a:Row)=>a.request_id));
  if(!issued)return !line.coordination&&!line.graphReviewHash;
  const {cut}=retainedBranchHostGraph(snapshot,line.sourceExecutionId),canonical=line.coordination;
  if(!canonical||typeof line.graphReviewHash!=='string')return false;
  const receipt=db.prepare('SELECT * FROM coordination_cut_restorations WHERE id=?').get(canonical.restorationId) as Row|undefined;
  if(!receipt||receipt.source_execution_id!==line.sourceExecutionId||receipt.checkpoint_id!==line.checkpointId||receipt.cut_hash!==line.checkpointHash
    ||receipt.command_key!==`${tree?'branch-tree-rewind':'branch-rewind'}:${payloadHash(line.commandKey)}`||receipt.receipt_json!==stableJson(canonical)
    ||receipt.command_hash!==payloadHash({checkpointId:line.checkpointId,expectedHash:line.checkpointHash,commandKey:receipt.command_key,reviewHash:line.graphReviewHash,reconcileEffects:true}))return false;
  for(const [field,records] of [['requestMap',cut.requests],['updateMap',cut.updates],['joinMap',cut.joins]] as const){
   const map=canonical[field],sources=records.map(({row})=>row.id).sort();
   if(!map||stableJson(Object.keys(map).sort())!==stableJson(sources)||new Set(Object.values(map)).size!==sources.length
    ||Object.values(map).some(id=>typeof id!=='string'||!id||sources.includes(id)))return false;
  }
  for(const {row:r} of cut.requests){const fresh=db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(canonical.requestMap[r.id]) as Row|undefined;if(!fresh||['project_id','conversation_id','requester_agent_id','recipient_agent_id'].some(k=>fresh[k]!==r[k]))return false;}
  for(const {row:u} of cut.updates)if(!db.prepare('SELECT 1 FROM coordination_restored_update_origins o JOIN coordination_request_updates u ON u.id=o.update_id WHERE o.update_id=? AND o.restoration_id=? AND o.source_update_id=? AND o.source_request_id=? AND u.request_id=? AND u.resulting_version=?').get(canonical.updateMap[u.id],canonical.restorationId,u.id,u.request_id,canonical.requestMap[u.request_id],u.resulting_version))return false;
  for(const {row:j} of cut.joins){
   const fresh=db.prepare('SELECT * FROM coordination_joins WHERE id=?').get(canonical.joinMap[j.id]) as Row|undefined;
   const members=db.prepare('SELECT request_id,position FROM coordination_join_members WHERE join_id=? ORDER BY position').all(canonical.joinMap[j.id]);
   const expected=cut.members.filter(({row})=>row.join_id===j.id).map(({row})=>({request_id:canonical.requestMap[row.request_id],position:row.position})).sort((a,b)=>a.position-b.position);
   if(!fresh||['project_id','conversation_id','owner_agent_id','mode','quorum','wake_policy','satisfying_outcomes_json'].some(k=>fresh[k]!==j[k])
    ||fresh.continuation_request_ids_json!==stableJson(JSON.parse(j.continuation_request_ids_json).map((id:string)=>canonical.requestMap[id]))||stableJson(members)!==stableJson(expected))return false;
  }
  return true;
 }catch{return false;}
}
