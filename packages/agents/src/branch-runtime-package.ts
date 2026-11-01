import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {BranchPortableRuntimeData,BranchPortableRuntimeOwner,BranchPortableRuntimeFact} from '@ponderosa/core';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {validateBranchDefinition} from './branch-definition.js';
type Row=Record<string,any>;
const kinds=new Set(['frontier','definition','bindings','configuration','provenance','host','initial','checkpoint','transition','command','custody','import','trigger']);
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===keys.sort().join('|');
function noCredentials(value:unknown,depth=0):void {
 if(depth>100)throw Error('Runtime evidence nesting exceeds the portable bound');
 if(!value||typeof value!=='object')return;
 for(const [key,v] of Object.entries(value)){
  if(key==='secretBindings'&&v&&typeof v==='object'&&Object.keys(v).length)throw Error('Private checkpoint contains secret bindings; export requires a nonsecret checkpoint');
  if(typeof v==='string'&&/^[\[{]/u.test(v.trim())){let parsed:unknown;try{parsed=JSON.parse(v);}catch{continue;}noCredentials(parsed,depth+1);}
  else noCredentials(v,depth+1);
 }
}
function parseFact(f:BranchPortableRuntimeFact):any {
 if(!exact(f,['kind','key','json','sha256'])||!kinds.has(f.kind)||typeof f.key!=='string'||!f.key||typeof f.json!=='string'||sha(f.json)!==f.sha256)throw Error('Runtime evidence bytes or identity differ');
 const parsed=JSON.parse(f.json);noCredentials(parsed);return parsed;
}
export function validateBranchRuntimeData(value:unknown):BranchPortableRuntimeData {
 const d=value as BranchPortableRuntimeData;
 if(!exact(d,['schema','sourceBranchId','identities','owners','sha256'])||d.schema!=='ponderosa.branch-runtime-data.v1'||typeof d.sourceBranchId!=='string'||!d.sourceBranchId||!Array.isArray(d.owners)||!d.owners.length||d.owners.length>1000||Buffer.byteLength(stableJson(d))>32*1024*1024)throw Error('Invalid or oversized Branch runtime data');
 if(payloadHash({schema:d.schema,sourceBranchId:d.sourceBranchId,identities:d.identities,owners:d.owners})!==d.sha256)throw Error('Runtime manifest hash differs');
 if(!exact(d.identities,['chats','agents'])||!d.identities.chats||!d.identities.agents||Array.isArray(d.identities.chats)||Array.isArray(d.identities.agents)||new Set(Object.values(d.identities.chats)).size!==Object.keys(d.identities.chats).length)throw Error('Invalid runtime identity inventory');
 if(Object.entries(d.identities.chats).some(([id,ref])=>!id||typeof ref!=='string'||!ref))throw Error('Invalid runtime Chat identities');
 const allChats=new Set(Object.values(d.identities.chats)),agentRefs=new Set<string>();
 for(const [id,a] of Object.entries(d.identities.agents)){const key=stableJson(a);if(!id||!exact(a,['chatRef','agentRef'])||!allChats.has(a.chatRef)||typeof a.agentRef!=='string'||!a.agentRef||agentRefs.has(key))throw Error('Runtime Agent identity aliases');agentRefs.add(key);}
 const owners=new Set<string>(),chats=new Set<string>();
 for(const o of d.owners){
  if(!exact(o,['sourceExecutionId','sourceBranchId','chatRefs','facts','sha256'])||typeof o.sourceExecutionId!=='string'||!o.sourceExecutionId||owners.has(o.sourceExecutionId)||o.sourceBranchId!==d.sourceBranchId||!Array.isArray(o.chatRefs)||!Array.isArray(o.facts)||o.facts.length>100000||payloadHash({sourceExecutionId:o.sourceExecutionId,sourceBranchId:o.sourceBranchId,chatRefs:o.chatRefs,facts:o.facts})!==o.sha256)throw Error('Runtime owner inventory differs');
  owners.add(o.sourceExecutionId);
  for(const ref of o.chatRefs){if(typeof ref!=='string'||!allChats.has(ref)||chats.has(ref))throw Error('Runtime Chat ownership aliases');chats.add(ref);}
  const seen=new Set<string>();
  for(const f of o.facts){const key=f.kind+':'+f.key;if(seen.has(key))throw Error('Duplicate runtime evidence');seen.add(key);parseFact(f);}
  for(const kind of ['frontier','definition','bindings','configuration','provenance'])if(o.facts.filter(f=>f.kind===kind).length!==1)throw Error('Incomplete runtime owner pins');
  const frontier=JSON.parse(o.facts.find(f=>f.kind==='frontier')!.json),e=frontier.execution?.[0];
  if(frontier.execution?.length!==1||e?.id!==o.sourceExecutionId||e.branch_id!==o.sourceBranchId||e.parent_execution_id||e.parent_attempt_id||!['manual','automatic'].includes(e.admission_source)||typeof e.input_text!=='string'||typeof e.input_hash!=='string'||!/^[a-f0-9]{64}$/u.test(e.input_hash))throw Error('Portable runtime data requires standalone owners with an original input identity');
  const provenance=JSON.parse(o.facts.find(f=>f.kind==='provenance')!.json);
  const imported=o.facts.filter(f=>f.kind==='import');
  if(provenance.source==='portable_runtime_data'){
   if(imported.length!==1||e.admitted_at||e.admission_json)throw Error('Re-exported data owner has no original acceptance');
   const original=JSON.parse(imported[0]!.json),receipt=original.receipt;
   if(!exact(original,['receipt','data']))throw Error('Re-export source manifest differs');
   const sourceData=validateBranchRuntimeData(original.data),sourceOwner=sourceData.owners.find(owner=>owner.sourceExecutionId===provenance.sourceExecutionId);
   const sourceExecution=sourceOwner&&JSON.parse(sourceOwner.facts.find(f=>f.kind==='frontier')!.json).execution[0];
   if(!sourceExecution||sourceExecution.input_text!==e.input_text||sourceExecution.input_hash!==e.input_hash||receipt.planId!==provenance.planId||receipt.branchId!==o.sourceBranchId)throw Error('Re-export source owner input or installation differs');
   if(receipt?.currentAuthority!==false||receipt.dispatched!==false||receipt.disposition!=='held'||receipt.manifestSha256!==provenance.manifestSha256||receipt.executionMap?.[provenance.sourceExecutionId]!==o.sourceExecutionId||original.data?.sha256!==provenance.manifestSha256)throw Error('Re-export source ownership differs');
   // The original manifest is private evidence; its owners are not new acceptance records.
  }else{
   if(imported.length)throw Error('Runtime original input identity differs');
   if(provenance.source==='trigger'){
    const trigger=o.facts.filter(f=>f.kind==='trigger');
    if(trigger.length!==1||typeof provenance.occurrenceId!=='string'||e.occurrence_key!==`trigger:${provenance.occurrenceId}`)throw Error('Automatic runtime occurrence provenance differs');
    const evidence=JSON.parse(trigger[0]!.json),row=evidence.occurrence;
    if(evidence.currentAuthority!==false||!['retained_data','unavailable_held'].includes(evidence.disposition)||evidence.disposition==='retained_data'&&(!row||row.id!==provenance.occurrenceId||row.branch_execution_id!==e.id||row.branch_id!==e.branch_id||row.input_hash!==e.input_hash))throw Error('Runtime trigger occurrence evidence differs');
   }else if(e.admission_source!=='manual'||e.input_hash!==payloadHash({input:e.input_text,source:'manual'}))throw Error('Runtime original input identity differs');
  }
  const definitionFact=o.facts.find(f=>f.kind==='definition')!,bindingFact=o.facts.find(f=>f.kind==='bindings')!;
  if(definitionFact.key!==e.version_id||bindingFact.key!==e.binding_revision_id)throw Error('Runtime pin identity differs');
  const definition=validateBranchDefinition(JSON.parse(definitionFact.json));
  const configuration=JSON.parse(o.facts.find(f=>f.kind==='configuration')!.json);
  if(!exact(configuration,['configuration','requiredSecretRefs'])||!configuration.configuration||!Array.isArray(configuration.requiredSecretRefs)||configuration.requiredSecretRefs.some((v:unknown)=>typeof v!=='string'||!v)||new Set(configuration.requiredSecretRefs).size!==configuration.requiredSecretRefs.length)throw Error('Runtime secret reentry inventory differs');
  for(const f of o.facts.filter(f=>f.kind==='custody')){const c=JSON.parse(f.json);if(c.receipt?.custodyId!==f.key||c.receipt.intent?.executionId!==o.sourceExecutionId||c.currentAuthority!==false||!['retained_data','unavailable_held'].includes(c.disposition)||c.disposition==='retained_data'&&payloadHash(c.package)!==c.packageSha256)throw Error('Private runtime custody evidence differs');}
  if(!definition)throw Error('Runtime definition unavailable');
 }
 return d;
}
/** Exact saved bytes plus shared selected/host codecs; never operational SQLite rows. */
export function captureBranchRuntimeData(db:Database.Database,branchId:string,chatRefs:Record<string,string>,agentRefs:Record<string,{chatRef:string;agentRef:string}>):BranchPortableRuntimeData|undefined {
 return db.transaction(()=>{
  const rows=db.prepare('SELECT id,parent_execution_id,admission_source,configuration_json,provenance_json,version_id,binding_revision_id,admitted_at,admission_json FROM branch_executions WHERE branch_id=? ORDER BY created_at,id').all(branchId) as Row[];
  if(!rows.length)return undefined;
  if(rows.length>1000)throw Error('Portable runtime owner bound exceeded');
  const owners:BranchPortableRuntimeOwner[]=rows.map(e=>{
   if(e.parent_execution_id||!['manual','automatic'].includes(e.admission_source)||db.prepare('SELECT 1 FROM branch_executions WHERE parent_execution_id=?').get(e.id))throw Error('Full runtime export currently requires standalone execution owners; called trees cannot be omitted');
   const facts:BranchPortableRuntimeFact[]=[],add=(kind:BranchPortableRuntimeFact['kind'],key:string,json:string)=>{const fact={kind,key,json,sha256:sha(json)};parseFact(fact);facts.push(fact);};
   const selected=selectBranchUnit(db,e.id);add('frontier','current',stableJson(selected));
   for(const [kind,table,id,column] of [['definition','branch_versions',e.version_id,'definition_json'],['bindings','branch_bindings',e.binding_revision_id,'bindings_json']] as const){
    const pin=db.prepare(`SELECT ${column} json,content_hash FROM ${table} WHERE id=? AND branch_id=?`).get(id,branchId) as Row|undefined;
    if(!pin||sha(pin.json)!==pin.content_hash)throw Error('Runtime source pin integrity failure');add(kind,id,pin.json);
   }
   const {secretBindings,...configuration}=JSON.parse(e.configuration_json);
   const pinnedDefinition=JSON.parse(facts.find(f=>f.kind==='definition')!.json);
   add('configuration','original',stableJson({configuration,requiredSecretRefs:[...new Set([...Object.keys(secretBindings??{}),...Object.entries(pinnedDefinition.parameters??{}).filter(([,v])=>(v as Row).type==='secret').map(([key])=>key)])].sort()}));add('provenance','original',e.provenance_json);
   const origin=JSON.parse(e.provenance_json);
   if(origin.source==='trigger'){
    const occurrence=db.prepare('SELECT id,trigger_id,occurrence_key,branch_id,branch_execution_id,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,activation_config_json,state,occurred_at,created_at,updated_at FROM trigger_occurrences WHERE id=? AND branch_execution_id=? AND branch_id=?').get(origin.occurrenceId,e.id,branchId);
    add('trigger','original',stableJson(occurrence?{disposition:'retained_data',occurrence,currentAuthority:false}:{disposition:'unavailable_held',occurrenceId:origin.occurrenceId,reason:'Original occurrence bytes are unavailable; no trigger is recreated',currentAuthority:false}));
   }
   if(origin.source==='portable_runtime_data'){
    if(e.admitted_at||e.admission_json)throw Error('Imported data owner acquired acceptance');
    const manifest=db.prepare("SELECT c.input_hash,c.result_json FROM branch_commands c JOIN branch_executions x ON x.id=c.execution_id WHERE x.branch_id=? AND c.command_key=?").get(branchId,`portable-runtime-manifest:${payloadHash(origin.planId)}`) as Row|undefined;
    if(!manifest||payloadHash(JSON.parse(manifest.result_json))!==manifest.input_hash)throw Error('Imported private runtime manifest unavailable or changed');
    add('import','original',manifest.result_json);
   }
   const host=captureBranchHostCut(db,e.id,selected);if(host)add('host','current',stableJson(host));
   for(const [kind,table] of [['initial','branch_initial_checkpoints'],['checkpoint','branch_unit_snapshots']] as const){
    for(const cp of db.prepare(`SELECT id,snapshot_json,content_hash FROM ${table} WHERE execution_id=? ORDER BY id`).all(e.id) as Row[]){if(sha(cp.snapshot_json)!==cp.content_hash)throw Error('Runtime checkpoint integrity failure');add(kind,String(cp.id),cp.snapshot_json);}
   }
   for(const cp of db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(e.id) as Row[])add('transition',String(cp.id),stableJson(cp));
   for(const c of db.prepare('SELECT command_key,input_hash,result_json,created_at FROM branch_commands WHERE execution_id=? ORDER BY command_key').all(e.id) as Row[])add('command',c.command_key,stableJson(c));
   const refs=(db.prepare('SELECT id FROM conversations WHERE branch_execution_id=? ORDER BY id').all(e.id) as Row[]).map(c=>{if(!chatRefs[c.id])throw Error('Execution-owned Chat is absent from the package');return chatRefs[c.id]!;});
   const owner={sourceExecutionId:e.id,sourceBranchId:branchId,chatRefs:refs,facts};return {...owner,sha256:payloadHash(owner)};
  });
  const data={schema:'ponderosa.branch-runtime-data.v1' as const,sourceBranchId:branchId,identities:{chats:chatRefs,agents:agentRefs},owners};return validateBranchRuntimeData({...data,sha256:payloadHash(data)});
 }).deferred();
}
