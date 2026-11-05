import {gzipSync,gunzipSync} from 'node:zlib';
import {verifyRetainedFinalExitCommand,readFinalResourceExit} from './branch-final-resource-exit.js';
import {captureForeignTreeGeneration} from './branch-tree-generation.js';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {BranchPortableRuntimeData,BranchPortableRuntimeOwner,BranchPortableRuntimeFact} from '@ponderosa/core';
import {remapBranchFrontier} from './branch-continuation-remap.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {validateBranchDefinition} from './branch-definition.js';
type Row=Record<string,any>;
const kinds=new Set(['frontier','definition','bindings','configuration','provenance','host','initial','checkpoint','transition','command','custody','import','trigger','tree-import','continuation','tree-continuation','acceptance']);
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
const runtimeByteLimit=32*1024*1024;
export function encodedRuntimeImport(json:string):string {
 const original=Buffer.from(json);
 if(original.length>runtimeByteLimit)throw Error('Runtime import bytes exceed the existing runtime bound');
 if(original.length<64*1024)return json;
 const zipped=gzipSync(original);
 if(zipped.length>=original.length)return json;
 const encoded=stableJson({schema:'ponderosa.runtime-import-bytes.v1',dataEncoding:'gzip',decodedSize:original.length,sha256:sha(json),dataBase64:zipped.toString('base64')});
 return Buffer.byteLength(encoded)<original.length?encoded:json;
}
type RuntimeImportCache={values:Map<string,Row>;decodedBytes:number};
export function decodedRuntimeImport(value:Row,budget?:RuntimeImportCache):Row {
 if(value.schema!=='ponderosa.runtime-import-bytes.v1')return value;
 if(!exact(value,['schema','dataEncoding','decodedSize','sha256','dataBase64'])||value.dataEncoding!=='gzip'
  ||!Number.isSafeInteger(value.decodedSize)||value.decodedSize<1||value.decodedSize>runtimeByteLimit
  ||typeof value.sha256!=='string'||! /^[a-f0-9]{64}$/.test(value.sha256)||typeof value.dataBase64!=='string'
  ||value.dataBase64.length>Math.ceil(runtimeByteLimit/3)*4)throw Error('Runtime import encoded byte bounds differ');
 if(budget){
  if(budget.decodedBytes+value.decodedSize>runtimeByteLimit)throw Error('Runtime import aggregate decoded bytes exceed the existing runtime bound');
  budget.decodedBytes+=value.decodedSize;
 }
 const compressed=Buffer.from(value.dataBase64,'base64');
 if(compressed.toString('base64')!==value.dataBase64)throw Error('Runtime import encoding differs');
 let bytes:Buffer;
 try{bytes=gunzipSync(compressed,{maxOutputLength:value.decodedSize});}catch{throw Error('Runtime import gzip is corrupt or exceeds its declared size');}
 if(bytes.length!==value.decodedSize||createHash('sha256').update(bytes).digest('hex')!==value.sha256||!Buffer.from(bytes.toString()).equals(bytes))throw Error('Runtime import decoded identity differs');
 const parsed=JSON.parse(bytes.toString());
 if(stableJson(parsed)!==bytes.toString()||!exact(parsed,['receipt','data']))throw Error('Runtime import original bytes differ');
 noCredentials(parsed);return parsed;
}
/** v2 shares exact immutable import bytes through one existing owner/fact. */
export function runtimeImportEvidence(data:BranchPortableRuntimeData,owner:BranchPortableRuntimeOwner):Row {
 return runtimeImportEvidenceCached(data,owner);
}
function runtimeImportEvidenceCached(data:BranchPortableRuntimeData,owner:BranchPortableRuntimeOwner,cache?:RuntimeImportCache):Row {
 const decode=(json:string):Row=>{
  const prior=cache?.values.get(json);if(prior)return prior;
  const parsed=decodedRuntimeImport(JSON.parse(json),cache);cache?.values.set(json,parsed);return parsed;
 };
 const facts=owner.facts.filter(f=>f.kind==='import'&&f.key==='original');
 if(facts.length!==1)throw Error('Exact runtime import fact unavailable');
 const value=JSON.parse(facts[0]!.json);
 if(value.schema==='ponderosa.runtime-import-bytes.v1'){
  if(data.schema!=='ponderosa.branch-runtime-data.v2')throw Error('Encoded runtime imports require runtime-data.v2');
  return decode(facts[0]!.json);
 }
 if(value.schema!=='ponderosa.runtime-import-reference.v1')return value;
 if(data.schema!=='ponderosa.branch-runtime-data.v2'||!exact(value,['schema','ownerId','sha256'])||value.ownerId===owner.sourceExecutionId)throw Error('Runtime import reference differs');
 const targets=data.owners.filter(o=>o.sourceExecutionId===value.ownerId);
 const target=targets.length===1?targets[0]!.facts.filter(f=>f.kind==='import'&&f.key==='original'):[];
 if(target.length!==1||target[0]!.sha256!==value.sha256||sha(target[0]!.json)!==value.sha256)throw Error('Runtime import reference unavailable');
 const resolved=decode(target[0]!.json);
 if(!exact(resolved,['receipt','data']))throw Error('Runtime import references must resolve in one hop');
 return resolved;
}
type RuntimeValidationContext={imports:RuntimeImportCache;validated:WeakMap<object,Set<string>>};
export function validateBranchRuntimeData(value:unknown,called=false,depth=0):BranchPortableRuntimeData {
 return validateRuntimeData(value,called,depth,{imports:{values:new Map(),decodedBytes:0},validated:new WeakMap()});
}
function validateRuntimeData(value:unknown,called:boolean,depth:number,context:RuntimeValidationContext):BranchPortableRuntimeData {
 if(depth>16)throw Error('Runtime generation chain exceeds 16 retained generations');
 const d=value as BranchPortableRuntimeData;
 const validationKey=String(called)+':'+depth;
 if(d&&typeof d==='object'&&context.validated.get(d)?.has(validationKey))return d;
 if(!exact(d,['schema','sourceBranchId','identities','owners','sha256'])||!['ponderosa.branch-runtime-data.v1','ponderosa.branch-runtime-data.v2'].includes(d.schema)||typeof d.sourceBranchId!=='string'||!d.sourceBranchId||!Array.isArray(d.owners)||(!called&&!d.owners.length)||d.owners.length>1000||Buffer.byteLength(stableJson(d))>32*1024*1024)throw Error('Invalid or oversized Branch runtime data');
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
  for(const fact of o.facts.filter(f=>f.kind==='command'&&f.key.startsWith('resource-final-exit:'))){
   const command=parseFact(fact);if(command.command_key!==fact.key)throw Error('Retained final resource command key differs');
   verifyRetainedFinalExitCommand(o,command);
  }
  const seen=new Set<string>();
  for(const f of o.facts){const key=f.kind+':'+f.key;if(seen.has(key))throw Error('Duplicate runtime evidence');seen.add(key);parseFact(f);}
  for(const f of o.facts.filter(f=>f.kind==='command')){
   const command=JSON.parse(f.json);if(!command.result_ref)continue;
   const ref=command.result_ref,anchor=d.owners.find(owner=>owner.sourceExecutionId===ref.ownerId),target=anchor?.facts.find(fact=>fact.kind==='import'&&fact.key==='original');
   if(d.schema!=='ponderosa.branch-runtime-data.v2'||!f.key.startsWith('portable-runtime-manifest:')||command.command_key!==f.key
    ||!exact(command,['command_key','input_hash','created_at','result_ref'])||!exact(ref,['schema','ownerId','sha256'])
    ||ref.schema!=='ponderosa.runtime-import-reference.v1'||!anchor||!target||target.sha256!==ref.sha256||sha(target.json)!==ref.sha256
    ||JSON.parse(target.json).schema==='ponderosa.runtime-import-reference.v1'||command.input_hash!==payloadHash(runtimeImportEvidenceCached(d,anchor,context.imports)))throw Error('Runtime manifest command reference differs');
  }
  for(const kind of ['frontier','definition','bindings','configuration','provenance'])if(o.facts.filter(f=>f.kind===kind).length!==1)throw Error('Incomplete runtime owner pins');
  const frontier=JSON.parse(o.facts.find(f=>f.kind==='frontier')!.json),e=frontier.execution?.[0];
  if(frontier.execution?.length!==1||e?.id!==o.sourceExecutionId||e.branch_id!==o.sourceBranchId||(!called&&(e.parent_execution_id||e.parent_attempt_id))||!(called?['manual','automatic','call']:['manual','automatic']).includes(e.admission_source)||typeof e.input_text!=='string'||typeof e.input_hash!=='string'||!/^[a-f0-9]{64}$/u.test(e.input_hash))throw Error('Portable runtime data requires standalone owners with an original input identity');
  const provenance=JSON.parse(o.facts.find(f=>f.kind==='provenance')!.json);
  const imported=o.facts.filter(f=>f.kind==='import');
  if(o.facts.some(f=>f.kind==='tree-import')&&!(called&&provenance.source==='portable_runtime_data'&&provenance.tree===true))throw Error('Private tree manifest has no matching provenance');
  if(called&&provenance.source==='portable_runtime_data'&&provenance.tree===true){
   if(o.facts.filter(f=>f.kind==='tree-import').length!==1||e.admitted_at||e.admission_json)throw Error('Tree data owner has no original acceptance');
  }else if(provenance.source==='portable_runtime_data'){
   if(imported.length!==1||e.admitted_at||e.admission_json)throw Error('Re-exported data owner has no original acceptance');
   const original=runtimeImportEvidenceCached(d,o,context.imports),receipt=original.receipt;
   if(!exact(original,['receipt','data']))throw Error('Re-export source manifest differs');
   const sourceData=validateRuntimeData(original.data,false,depth+1,context),sourceOwner=sourceData.owners.find(owner=>owner.sourceExecutionId===provenance.sourceExecutionId);
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
   }else if(called&&e.admission_source==='call'){
    if(!e.parent_execution_id||!e.parent_attempt_id)throw Error('Call owner requires exact parent ancestry');
   }else if(e.admission_source!=='manual'||e.input_hash!==payloadHash({input:e.input_text,source:'manual'}))throw Error('Runtime original input identity differs');
  }
  const compactSource=o.facts.some(f=>f.kind==='host'&&JSON.parse(f.json).provenance?.restorations?.some((entry:Row)=>entry.row.retainedSource?.schema==='ponderosa.retained-source-reference.v1'));
  if(compactSource&&d.schema!=='ponderosa.branch-runtime-data.v2')throw Error('Compact retained provenance requires runtime-data.v2');
  const acceptance=o.facts.filter(f=>f.kind==='acceptance');
  if(acceptance.length>1||acceptance.length&&!exact(JSON.parse(acceptance[0]!.json),['admittedAt','admissionJson']))throw Error('Runtime acceptance fact differs');
  if(acceptance.length&&!called){
   if(d.schema!=='ponderosa.branch-runtime-data.v2')throw Error('Standalone retained acceptance requires runtime-data.v2');
   const retained=JSON.parse(acceptance[0]!.json),started=o.facts.filter(f=>f.kind==='transition'&&JSON.parse(f.json).kind==='workflow_started');
   const commands=o.facts.filter(f=>f.kind==='command'&&f.key.startsWith('issued-destination-owner:'));
   if(provenance.source==='portable_runtime_data'||e.admission_source!=='manual'||typeof retained.admittedAt!=='string'||!retained.admittedAt
    ||typeof retained.admissionJson!=='string'||started.length!==1||commands.length!==1)throw Error('Standalone acceptance requires an admitted retained destination');
   const command=JSON.parse(commands[0]!.json),destination=JSON.parse(command.result_json).coordinationDestination?.destination;
   if(!destination?.retainedSourceId||commands[0]!.key!==`issued-destination-owner:${destination.admissionId}`
    ||stableJson(JSON.parse(retained.admissionJson))!==retained.admissionJson
    ||JSON.parse(started[0]!.json).evidence_json!==stableJson({admission:JSON.parse(retained.admissionJson)}))throw Error('Retained destination acceptance differs');
  }
  const treeGenerations=o.facts.filter(f=>f.kind==='tree-continuation');
  if(treeGenerations.length!==(called&&provenance.source==='foreign_tree_continuation'?1:0))throw Error('Unowned or missing tree continuation evidence');
  const generations=o.facts.filter(f=>f.kind==='continuation');
  if(provenance.source==='foreign_checkpoint_continuation'){
   if(generations.length!==1)throw Error('Retained continuation generation evidence missing');
   const retained=JSON.parse(generations[0]!.json);
   if(!exact(retained,['receipt','data','acceptance'])||retained.receipt.executionId!==e.id||retained.receipt.importedExecutionId!==provenance.importedExecutionId||retained.receipt.commandKey!==provenance.commandKey||retained.receipt.review.reviewSha256!==provenance.reviewSha256||!exact(retained.acceptance,['admittedAt','admissionJson'])||typeof retained.acceptance.admittedAt!=='string'||retained.acceptance.admissionJson!==stableJson(retained.receipt.admission))throw Error('Retained generation identity differs');
   if(validateRuntimeData(retained.data,false,depth+1,context).sha256!==retained.receipt.review.manifestSha256)throw Error('Retained generation source manifest differs');
   const importedOwner=d.owners.find(prior=>prior.sourceExecutionId===provenance.importedExecutionId);
   const importedFact=importedOwner?.facts.find(f=>f.kind==='import'),commandFact=importedOwner?.facts.find(f=>f.kind==='command'&&f.key===`foreign-continuation:${payloadHash(provenance.commandKey)}`);
   if(!importedFact||!commandFact)throw Error('Complete retained import and continuation command owners required');
   const importedSource=runtimeImportEvidenceCached(d,importedOwner!,context.imports),command=JSON.parse(commandFact.json);
   if(stableJson(importedSource.data)!==stableJson(retained.data)||stableJson(importedSource.receipt)!==stableJson(retained.receipt.review.nativeMaps)||command.input_hash!==payloadHash(retained.receipt)||command.result_json!==stableJson(retained.receipt))throw Error('Retained generation original command/import bytes differ');

  }else if(generations.length)throw Error('Unowned continuation evidence');
  const definitionFact=o.facts.find(f=>f.kind==='definition')!,bindingFact=o.facts.find(f=>f.kind==='bindings')!;
  if(definitionFact.key!==e.version_id||bindingFact.key!==e.binding_revision_id)throw Error('Runtime pin identity differs');
  const definition=validateBranchDefinition(JSON.parse(definitionFact.json));
  const configuration=JSON.parse(o.facts.find(f=>f.kind==='configuration')!.json);
  if(!exact(configuration,['configuration','requiredSecretRefs'])||!configuration.configuration||!Array.isArray(configuration.requiredSecretRefs)||configuration.requiredSecretRefs.some((v:unknown)=>typeof v!=='string'||!v)||new Set(configuration.requiredSecretRefs).size!==configuration.requiredSecretRefs.length)throw Error('Runtime secret reentry inventory differs');
  for(const f of o.facts.filter(f=>f.kind==='custody')){const c=JSON.parse(f.json);if(c.receipt?.custodyId!==f.key||c.receipt.intent?.executionId!==o.sourceExecutionId||c.currentAuthority!==false||!['retained_data','unavailable_held'].includes(c.disposition)||c.disposition==='retained_data'&&payloadHash(c.package)!==c.packageSha256)throw Error('Private runtime custody evidence differs');}
  for(const f of o.facts.filter(f=>f.kind==='custody')){
   const c=JSON.parse(f.json);
   if(c.wireJson!==undefined&&(c.disposition!=='retained_data'||typeof c.wireJson!=='string'||Buffer.from(c.wireJson,'utf8').toString('utf8')!==c.wireJson||Buffer.byteLength(c.wireJson)!==c.receipt.byteLength||sha(c.wireJson)!==c.receipt.sha256||payloadHash(JSON.parse(c.wireJson))!==c.packageSha256))throw Error('Private runtime original custody wire differs');
  }
  if(!definition)throw Error('Runtime definition unavailable');
 }
 const keys=context.validated.get(d)??new Set<string>();keys.add(validationKey);context.validated.set(d,keys);
 return d;
}
/** Exact saved bytes plus shared selected/host codecs; never operational SQLite rows. */
export function captureBranchRuntimeData(db:Database.Database,branchId:string,chatRefs:Record<string,string>,agentRefs:Record<string,{chatRef:string;agentRef:string}>,called=false):BranchPortableRuntimeData|undefined {
 return db.transaction(()=>{
  const rows=db.prepare('SELECT id,parent_execution_id,admission_source,configuration_json,provenance_json,version_id,binding_revision_id,admitted_at,admission_json,checkpoint_invocation_json FROM branch_executions WHERE branch_id=? ORDER BY created_at,id').all(branchId) as Row[];
  if(!rows.length&&!called)return undefined;
  if(rows.length>1000)throw Error('Portable runtime owner bound exceeded');
  const importAnchors=new Map<string,{ownerId:string;sha256:string}>();
  const owners:BranchPortableRuntimeOwner[]=rows.map(e=>{
   if(!called&&(e.parent_execution_id||!['manual','automatic'].includes(e.admission_source)||db.prepare('SELECT 1 FROM branch_executions WHERE parent_execution_id=?').get(e.id)))throw Error('Full runtime export currently requires standalone execution owners; called trees cannot be omitted');
   if(['async','exit'].includes(JSON.parse(e.configuration_json).checkpointMode??'async')&&JSON.parse(e.checkpoint_invocation_json??'null')?.durability==='failed')throw Error('Async/EXIT checkpoint durability failed; reconcile the source before export');
   const facts:BranchPortableRuntimeFact[]=[],add=(kind:BranchPortableRuntimeFact['kind'],key:string,json:string)=>{const fact={kind,key,json,sha256:sha(json)};parseFact(fact);facts.push(fact);};
   if(called||e.admitted_at&&e.admission_json&&db.prepare("SELECT 1 FROM coordination_destination_admissions WHERE state='admitted' AND retained_source_id IS NOT NULL AND json_extract(reservation_json,'$.destination.executionId')=?").get(e.id))add('acceptance','original',stableJson({admittedAt:e.admitted_at,admissionJson:e.admission_json}));
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
   if(origin.source==='portable_runtime_data'&&origin.tree===true){
    if(e.admitted_at||e.admission_json)throw Error('Imported tree data owner acquired acceptance');
    const manifest=db.prepare("SELECT input_hash,result_json FROM branch_commands WHERE command_key=?").get(`portable-runtime-tree-manifest:${payloadHash(origin.planId)}`) as Row|undefined;
    if(!manifest||payloadHash(JSON.parse(manifest.result_json))!==manifest.input_hash)throw Error('Imported private runtime tree unavailable or changed');
    add('tree-import','original',manifest.result_json);
   }else if(origin.source==='portable_runtime_data'){
    if(e.admitted_at||e.admission_json)throw Error('Imported data owner acquired acceptance');
    const manifest=db.prepare("SELECT c.input_hash,c.result_json FROM branch_commands c JOIN branch_executions x ON x.id=c.execution_id WHERE x.branch_id=? AND c.command_key=?").get(branchId,`portable-runtime-manifest:${payloadHash(origin.planId)}`) as Row|undefined;
    if(!manifest||payloadHash(JSON.parse(manifest.result_json))!==manifest.input_hash)throw Error('Imported private runtime manifest unavailable or changed');
    const digest=sha(manifest.result_json),anchor=importAnchors.get(digest);
    if(!called&&anchor)add('import','original',stableJson({schema:'ponderosa.runtime-import-reference.v1',...anchor}));
    else {const wire=called?manifest.result_json:encodedRuntimeImport(manifest.result_json);add('import','original',wire);importAnchors.set(digest,{ownerId:e.id,sha256:sha(wire)});}
   }
   if(origin.source==='foreign_checkpoint_continuation'){
    const command=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(origin.importedExecutionId,`foreign-continuation:${payloadHash(origin.commandKey)}`) as Row|undefined;
    const manifest=db.prepare("SELECT c.input_hash,c.result_json FROM branch_commands c JOIN branch_executions x ON x.id=c.execution_id WHERE x.branch_id=? AND c.command_key LIKE 'portable-runtime-manifest:%'").all(branchId) as Row[];
    if(!command||!e.admitted_at||!e.admission_json||payloadHash(JSON.parse(command.result_json))!==command.input_hash)throw Error('Continuation command or admission evidence unavailable');
    const receipt=JSON.parse(command.result_json),matches=manifest.filter(row=>payloadHash(JSON.parse(row.result_json))===row.input_hash&&JSON.parse(row.result_json).data.sha256===receipt.review.manifestSha256&&stableJson(JSON.parse(row.result_json).receipt)===stableJson(receipt.review.nativeMaps));
    if(matches.length!==1)throw Error('Continuation original import evidence missing or ambiguous');
    add('continuation','original',stableJson({receipt,data:JSON.parse(matches[0]!.result_json).data,acceptance:{admittedAt:e.admitted_at,admissionJson:e.admission_json}}));
   }
   if(origin.source==='foreign_tree_continuation')add('tree-continuation','original',stableJson(captureForeignTreeGeneration(db,e.id,origin)));
   const host=captureBranchHostCut(db,e.id,selected);if(host)add('host','current',stableJson(host));
   // Keep every private snapshot: local tree rewind proof owns root and child lineage rows here.
   for(const [kind,table] of [['initial','branch_initial_checkpoints'],['checkpoint','branch_unit_snapshots']] as const){
    for(const cp of db.prepare(`SELECT id,snapshot_json,content_hash FROM ${table} WHERE execution_id=? ORDER BY id`).all(e.id) as Row[]){if(sha(cp.snapshot_json)!==cp.content_hash)throw Error('Runtime checkpoint integrity failure');add(kind,String(cp.id),cp.snapshot_json);}
   }
   for(const cp of db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(e.id) as Row[])add('transition',String(cp.id),stableJson(cp));
   for(const c of db.prepare('SELECT command_key,input_hash,result_json,created_at FROM branch_commands WHERE execution_id=? ORDER BY command_key').all(e.id) as Row[]){
    if(c.command_key.startsWith('resource-final-exit:')){
     const retained=JSON.parse(c.result_json);
     if(retained.identity?.executionId!==e.id || !retained.identity?.stepId)throw Error('Original final resource owner differs');
     readFinalResourceExit(db,e.id,retained.identity.stepId);
    }
    const anchor=!called&&c.command_key.startsWith('portable-runtime-manifest:')?importAnchors.get(sha(c.result_json)):undefined;
    if(anchor){const {result_json,...fields}=c;add('command',c.command_key,stableJson({...fields,result_ref:{schema:'ponderosa.runtime-import-reference.v1',...anchor}}));}
    else add('command',c.command_key,stableJson(c));
   }
   const refs=(db.prepare('SELECT id FROM conversations WHERE branch_execution_id=? ORDER BY id').all(e.id) as Row[]).map(c=>{if(!chatRefs[c.id])throw Error('Execution-owned Chat is absent from the package');return chatRefs[c.id]!;});
   const owner={sourceExecutionId:e.id,sourceBranchId:branchId,chatRefs:refs,facts};return {...owner,sha256:payloadHash(owner)};
  });
  const extended=owners.some(o=>o.facts.some(f=>!called&&(f.kind==='acceptance'||f.kind==='import'&&['ponderosa.runtime-import-reference.v1','ponderosa.runtime-import-bytes.v1'].includes(JSON.parse(f.json).schema)||f.kind==='command'&&JSON.parse(f.json).result_ref)
   ||f.kind==='host'&&JSON.parse(f.json).provenance?.restorations?.some((entry:Row)=>entry.row.retainedSource?.schema==='ponderosa.retained-source-reference.v1')));
  const data={schema:(extended?'ponderosa.branch-runtime-data.v2':'ponderosa.branch-runtime-data.v1') as BranchPortableRuntimeData['schema'],sourceBranchId:branchId,identities:{chats:chatRefs,agents:agentRefs},owners};return validateBranchRuntimeData({...data,sha256:payloadHash(data)},called);
 }).deferred();
}

/** Unwrap held import generations as evidence; never recreate source authority. */
export function resolveBranchRuntimeSource(data:BranchPortableRuntimeData,executionId:string) {
 const chain:Array<{manifestSha256:string;ownerSha256:string;executionId:string}>=[],seen=new Set<string>();
 for(let depth=0;depth<=16;depth++){
  const owner=data.owners.find(o=>o.sourceExecutionId===executionId);
  if(!owner||seen.has(data.sha256+':'+executionId))throw Error('Runtime generation owner missing or cyclic');
  seen.add(data.sha256+':'+executionId);
  const fact=(kind:string)=>JSON.parse(owner.facts.find(f=>f.kind===kind)!.json);
  const origin=fact('provenance'),selected=fact('frontier'),e=selected.execution[0];
  chain.push({manifestSha256:data.sha256,ownerSha256:owner.sha256,executionId});
  if(origin.source!=='portable_runtime_data')return {data,owner,chain};
  if(origin.tree)throw Error('Tree generation cannot use standalone continuation');
  const imported=runtimeImportEvidence(data,owner),receipt=imported.receipt;
  const original=validateBranchRuntimeData(imported.data),source=original.owners.find(o=>o.sourceExecutionId===origin.sourceExecutionId);
  if(!source||receipt.frontiers?.[origin.sourceExecutionId]?.disposition!=='recreated_held')throw Error('Prior generation frontier is evidence-only');
  if(stableJson(Object.keys(receipt.executionMap).sort())!==stableJson(original.owners.map(o=>o.sourceExecutionId).sort())||new Set(Object.values(receipt.executionMap)).size!==original.owners.length||stableJson(Object.keys(receipt.frontiers).sort())!==stableJson(Object.keys(receipt.executionMap).sort()))throw Error('Retained generation owner map differs');
  const old=JSON.parse(source.facts.find(f=>f.kind==='frontier')!.json),ids=receipt.frontiers[origin.sourceExecutionId].idMap;
  const expected=remapBranchFrontier(old,ids,origin.sourceExecutionId,e.id);
  const normalize=(rows:Row[])=>rows.map(row=>stableJson(Object.fromEntries(Object.entries(row).filter(([key])=>!['created_at','updated_at'].includes(key))))).sort();
  for(const key of Object.keys(expected))if(stableJson(normalize(expected[key]!))!==stableJson(normalize(selected[key])))throw Error('Held generation mapped frontier differs');
  if(e.state!=='waiting'||e.cancel_requested||e.budget_exhausted||e.parent_execution_id||e.parent_attempt_id||e.admission_source!=='manual'||
    ['traversals','loop_iterations','recovery_traversals','depth_ceiling'].some(key=>e[key]!==old.execution[0][key])||
    payloadHash(fact('definition'))!==payloadHash(JSON.parse(source.facts.find(f=>f.kind==='definition')!.json))||
    stableJson(fact('configuration'))!==stableJson(JSON.parse(source.facts.find(f=>f.kind==='configuration')!.json)))throw Error('Held generation pins or counters differ');
  data=original;executionId=origin.sourceExecutionId;
 }
 throw Error('Runtime generation chain exceeds 16 retained generations');
}
