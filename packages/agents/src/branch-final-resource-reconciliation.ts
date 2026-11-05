import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import {TERMINAL_REQUEST_STATES, type BranchPortableRuntimeData, type BranchPortableRuntimeOwner} from '@ponderosa/core';
import {verifyBranchHostCut, type BranchHostCut} from './branch-host-cut.js';
import {verifyHostProvenance} from './branch-host-provenance.js';
import {verifyRetainedFinalExitCommand} from './branch-final-resource-exit.js';
import {retainedIssuedEnvelopeSupported, retainedIssuedLatestSupported} from './branch-issued-resource-continuation.js';
import {validateHistoricalRequest, validateRetainedCoordinationGraph} from './coordination-v3-cut-restoration-authority.js';
import {payloadHash, stableJson} from './coordination-v3-canonical-json.js';

/** Compare one retained final exit with its exact selected checkpoint. This
 * reports recorded outcomes only: it neither grants admission nor proves that
 * external effects did or did not occur. Ambiguous graphs stay held. */
export function reconcileRetainedFinalResourceRequests(owner:BranchPortableRuntimeOwner,checkpointKey:string,checkpointSha256:string,data?:BranchPortableRuntimeData,depth=0) {
 const checkpoints=owner.facts.filter(f=>f.kind==='checkpoint'&&f.key===checkpointKey&&f.sha256===checkpointSha256);
 const commands=owner.facts.filter(f=>f.kind==='command'&&f.key.startsWith('resource-final-exit:'));
 if(checkpoints.length!==1||commands.length!==1)throw Error('Exact final-resource checkpoint and exit required');
 const fact=checkpoints[0]!, command=JSON.parse(commands[0]!.json);
 if(stableJson(command)!==commands[0]!.json)throw Error('Final-resource command is not canonical');
 verifyRetainedFinalExitCommand(owner,command);
 const exit=JSON.parse(command.result_json),checkpoint=JSON.parse(fact.json);
 if(stableJson(checkpoint)!==fact.json||payloadHash(checkpoint)!==checkpointSha256
  ||String(exit.selectedCheckpoint.id)!==checkpointKey||exit.selectedCheckpoint.content_hash!==checkpointSha256
  ||exit.selectedCheckpoint.snapshot_json!==fact.json)throw Error('Final-resource checkpoint selection differs');
 const equalBoundary=stableJson(checkpoint.selected)===stableJson(exit.envelope.selected)
  &&stableJson(checkpoint.hostDependencies)===stableJson(exit.envelope.hostDependencies)
  &&stableJson(checkpoint.issuedContinuation)===stableJson(exit.latestContinuation);
 // Two independently recorded equal boundaries require one replay validation;
 // this avoids repeating the complete retained predecessor chain at each hop.
 if(!retainedIssuedEnvelopeSupported(owner,checkpoint,data,depth)||!equalBoundary&&!retainedIssuedLatestSupported(owner,exit.envelope.selected,exit.envelope.hostDependencies,exit.latestContinuation,data,depth))throw Error('Final-resource selected or final frontier replay unsupported');
 const selected=checkpoint.hostDependencies as BranchHostCut,final=exit.envelope.hostDependencies as BranchHostCut;
 if(!verifyBranchHostCut(selected,owner.sourceExecutionId)||!verifyBranchHostCut(final,owner.sourceExecutionId)
  ||!selected.coverage.complete||!final.coverage.complete||stableJson(selected.roots)!==stableJson(final.roots)
  ||stableJson(selected.bindingPin)!==stableJson(final.bindingPin))throw Error('Final-resource graph ownership or coverage differs');
 verifyHostProvenance(selected);verifyHostProvenance(final);
 // The first supported case has no independently actionable Join or additional
 // result channel. Those cases need explicit graph reconciliation and stay held.
 for(const cut of [selected,final])if(cut.joins.length||cut.members.length||cut.suspensions.length||cut.joinOutcomes.length||cut.lateResults.length||cut.artifactRefs.length)
  throw Error('Final-resource graph has additional dependencies requiring reconciliation');
 const sort=(values:string[])=>[...values].sort();
 if(stableJson(sort(selected.requests.map(x=>x.row.id)))!==stableJson(sort(final.requests.map(x=>x.row.id)))
  ||new Set(selected.requests.map(x=>x.row.id)).size!==selected.requests.length
  ||new Set(final.requests.map(x=>x.row.id)).size!==final.requests.length)throw Error('Final-resource Request set differs');
 const immutable=['id','project_id','conversation_id','requester_agent_id','recipient_agent_id','communication_event_id','payload_json','lifetime_kind','deadline_at','origin_run_id','created_at'];
 for(const {row:before} of selected.requests){
  const after=final.requests.find(x=>x.row.id===before.id)!.row;
  if(immutable.some(k=>stableJson(before[k]??null)!==stableJson(after[k]??null))
   ||after.superseded_by_request_id||!TERMINAL_REQUEST_STATES.has(after.state)||['outcome_unknown','superseded'].includes(after.state)
   ||!Number.isSafeInteger(before.version)||!Number.isSafeInteger(after.version)||after.version<before.version)
   throw Error('Final-resource Request outcome is unresolved or changed ownership');
  const old=selected.updates.filter(x=>x.row.request_id===before.id).sort((a,b)=>a.row.resulting_version-b.row.resulting_version);
  const newer=final.updates.filter(x=>x.row.request_id===before.id).sort((a,b)=>a.row.resulting_version-b.row.resulting_version);
  validateHistoricalRequest(before,old.map(x=>x.row),selected);
  if(old.length!==before.version||newer.length!==after.version||old.some((x,i)=>stableJson(x)!==stableJson(newer[i])))
   throw Error('Final-resource Request history is not an exact extension');
 }
 validateRetainedCoordinationGraph(final,new Date(0).toISOString(),true);
 return {checkpointKey,checkpointSha256,exitCommandKey:command.command_key,exitCommandHash:command.input_hash,
  finalGraph:final, finalFrontier:exit.envelope.selected, outcomes:final.requests.map(({row})=>({requestId:row.id,state:row.state,version:row.version})),currentAuthority:false as const};
}

/** Exact final automatic checkpoint in a trusted portable installation. Historical
 * source identities remain original; this proof supplies no current admission. */
export function retainedCompletedFinalResourceSource(owner:BranchPortableRuntimeOwner,checkpointKey:string,checkpointSha256:string,data?:BranchPortableRuntimeData,depth=0) {
 const reconciled=reconcileRetainedFinalResourceRequests(owner,checkpointKey,checkpointSha256,data,depth);
 const one=(kind:string,key?:string)=>{const rows=owner.facts.filter(f=>f.kind===kind&&(key===undefined||f.key===key));if(rows.length!==1)throw Error('Exact final source fact unavailable');return JSON.parse(rows[0]!.json);};
 const command=one('command',reconciled.exitCommandKey),exit=JSON.parse(command.result_json),i=exit.identity;
 const selected=one('checkpoint',checkpointKey),latest=one('frontier');
 if(i.generation!==0||selected.issuedContinuation.generationRetry||selected.issuedContinuation.group
  ||stableJson(selected.selected)!==stableJson(exit.envelope.selected)
  ||stableJson(selected.hostDependencies)!==stableJson(exit.envelope.hostDependencies)
  ||stableJson(selected.issuedContinuation)!==stableJson(exit.latestContinuation)
  ||!reconciled.outcomes.length||reconciled.outcomes.some(o=>o.state!=='completed')
  ||selected.selected.paths.some((p:any)=>p.state!=='completed'))throw Error('Only the completed exact final checkpoint is supported');
 const commandKey=`final-resource-package:${i.stepId}:0`;
 const captureCommand=one('command',`issued-resource-capture:${commandKey}`),capture=JSON.parse(captureCommand.result_json);
 const intentCommand=one('command',`final-package-intent:${i.stepId}:0`),intent=JSON.parse(intentCommand.result_json);
 const expectedIntent={schema:'branch-final-package-intent.v2',wholeWorkingFolder:true,commandKey,sourceSha256:payloadHash(capture.source),fenceSha256:exit.intakeFence.sha256};
 if(stableJson(intent)!==stableJson(expectedIntent)||intentCommand.input_hash!==payloadHash(intent)
  ||capture.schema!=='branch-issued-resource-capture.v1'||capture.state!=='retained'
  ||String(capture.checkpointId)!==checkpointKey||capture.checkpointHash!==checkpointSha256
  ||stableJson(capture.receipt)!==stableJson(selected.issuedResourceCustody)
  ||captureCommand.input_hash!==payloadHash({stepId:i.stepId,generation:0,commandKey}))
  throw Error('Automatic whole-folder final capture binding differs');
 // Nothing executed after the exact final package: permit only recorded cleanup.
 const before=structuredClone(selected.selected),after=structuredClone(latest);
 if(before.execution.length!==1||after.execution.length!==1||before.resources.length!==1||after.resources.length!==1
  ||before.execution[0].state!=='waiting'||before.execution[0].wait_reason!=='Waiting for ephemeral Agent work and runtime cleanup'
  ||after.execution[0].state!=='completed'||after.execution[0].wait_reason!==null
  ||before.resources[0].state!=='active'||after.resources[0].state!=='retired')throw Error('Final source terminal cleanup differs');
 after.execution[0].state=before.execution[0].state;after.execution[0].wait_reason=before.execution[0].wait_reason;
 after.resources[0].state=before.resources[0].state;
 if(stableJson(before)!==stableJson(after))throw Error('Final source changed beyond cleanup');
 const audit=owner.facts.filter(f=>f.kind==='transition').map(f=>JSON.parse(f.json));
 const prefix=exit.latestContinuation.audit,tail=audit.slice(prefix.length);
 if(stableJson(audit.slice(0,prefix.length))!==stableJson(prefix)||tail.length!==2
  ||tail[0].kind!=='resource_retired'||tail[0].transition_key!==`resource-retired:${i.stepId}:0`
  ||tail[0].evidence_json!==stableJson({stepExecutionId:i.stepId})||tail[1].kind!=='completed'
  ||tail[1].evidence_json!==stableJson({output:latest.execution[0].output_text}))
  throw Error('Final source has additional transitions');
 const custody=one('custody',selected.issuedResourceCustody.custodyId);
 if(custody.disposition!=='retained_data'||custody.currentAuthority!==false||typeof custody.wireJson!=='string'
  ||stableJson(custody.receipt)!==stableJson(selected.issuedResourceCustody)
  ||Buffer.byteLength(custody.wireJson)!==custody.receipt.byteLength
  ||createHash('sha256').update(custody.wireJson).digest('hex')!==custody.receipt.sha256
  ||stableJson(JSON.parse(custody.wireJson))!==stableJson(custody.package))
  throw Error('Final source package custody bytes unavailable');
 const pkg=custody.package;
 if(pkg.mode!=='full'||pkg.memory?.length||pkg.outputRoles?.length||pkg.gitStorageBindings?.length||pkg.workingRootNesting?.length||!Array.isArray(pkg.agents)
  ||stableJson(pkg.agents.map((a:any)=>a.ref))!==stableJson(custody.receipt.agentIds)
  ||pkg.agents.some((a:any)=>a.sourceChat?.ref!==i.chatId||!a.workingRootRef
   ||a.workingCopyMode==='separate_git'||a.accessSettings?.restrictedCapabilityIds?.length
   ||a.managementPermissions?.allowAutomaticDescendantDeletion||a.managementPermissions?.allowAutomaticDescendantReorganization))
  throw Error('Final source complete Shared folder package required');
 const roots=[...new Set(pkg.agents.map((a:any)=>a.workingRootRef))];
 if(roots.length!==1)throw Error('One complete final Shared root is required');
 const owners=pkg.agents.filter((a:any)=>a.workingFolder);
 // ponytail: admit only direct links to captured regular files; wider link shapes
 // need matching staged-root verification through the existing topology importer.
 if(owners.length!==1||owners[0].workingFolder.excludedPaths?.length||owners[0].workingFolder.links?.some((link:any)=>{
   if(link.targetRootRef!==undefined||!['symlink','hardlink'].includes(link.kind)||typeof link.target!=='string'||posix.isAbsolute(link.target))return true;
   const target=link.kind==='symlink'?posix.normalize(posix.join(posix.dirname(link.path),link.target)):link.target;
   return !(owners[0].workingFiles??[]).some((file:any)=>file.path===target);
  })
  ||pkg.agents.some((a:any)=>(a.artifacts??[]).some((artifact:any)=>artifact.dataEncoding!==undefined)))
  throw Error('Final source has excluded data, unsupported links or encoded artifacts');
 // latest denotes the independently recorded equal final boundary, not a post-cleanup checkpoint.
 return {selected,latest:selected,selectedCustody:custody,latestCustody:custody,finalExit:exit,currentAuthority:false as const};
}
