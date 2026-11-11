// Deferred source-only regression. No provider, package, or full consumer qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {destinationResourceEvidence} from '../../packages/agents/dist/coordination-v3-destination-resource-evidence.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
import {resourceCaptureFrontierHash} from '../../packages/agents/dist/branch-resource-capture.js';
const evidence=row=>({row,sha256:payloadHash(row)});
function fixture(){
 const owners=['parent','child'].map((executionId,index)=>{
  const resource={execution_id:executionId,step_execution_id:`resource-${index}`,chat_id:`chat-${index}`,generation:0,import_operation_json:stableJson({result:{agentIds:[`agent-${index}`]}})};
  const selected={execution:[{id:executionId,branch_id:`branch-${index}`,version_id:`version-${index}`,binding_revision_id:`binding-${index}`,...(index?{parent_execution_id:'parent',parent_attempt_id:'call'}:{})}],resources:[resource],attempts:[{id:`attempt-${index}`,request_id:`request-${index}`},...(!index?[{id:'call'}]:[])]};
  const cut={schema:'ponderosa.branch.host-dependencies.v1',executionId,restoreAuthority:'fresh_admission_required',nativeState:'not_captured',artifactStorage:'references_only',bindingPin:{revisionId:`binding-${index}`,sha256:String(index).repeat(64),requiredSecretRefs:[]},coverage:{complete:true,missingReferences:[],requestVersions:[]},roots:[{attemptId:`attempt-${index}`,requestId:`request-${index}`}],...Object.fromEntries(['requests','updates','lateResults','joins','members','suspensions','communications','joinOutcomes','artifactRefs','resources','resourceMembers','resourceContexts','resourceReceipts'].map(k=>[k,[]]))};
  cut.resources=[evidence(resource)];cut.resourceMembers=[evidence({agent_id:`agent-${index}`,step_execution_id:resource.step_execution_id})];
  return {executionId,versionId:`version-${index}`,bindingRevisionId:`binding-${index}`,bindingHash:cut.bindingPin.sha256,configuration:{owner:index},selected,hostDependencies:cut,hostDependenciesHash:payloadHash(cut)};
 });
 const snapshot={selected:owners[0].selected,hostDependencies:owners[0].hostDependencies,continuation:{schema:'ponderosa.branch.script-tree-continuation.v1',rootExecutionId:'parent',owners}};
 const resources=owners.map((o,index)=>{const source={checkpointId:`package-${index}`,sourceChatId:`chat-${index}`,agentIds:[`agent-${index}`],intent:{executionId:o.executionId,resourceStepId:`resource-${index}`,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(o.selected),hostCutSha256:payloadHash(o.hostDependencies),bindingSha256:o.bindingHash,configurationSha256:payloadHash(o.configuration)}};return {custody:{version:1,...source,custodyId:createHash('sha256').update(source.checkpointId).digest('hex'),boundaryId:'original',sha256:'a'.repeat(64),byteLength:1},destination:{executionId:`fresh-${index}`,resourceStepId:`fresh-resource-${index}`,conversationId:`fresh-chat-${index}`,projectId:'project',resourceGeneration:0}};});
 return {snapshot,reservation:{branchId:'branch-0',sourceExecutionId:'parent',resources,custody:resources[0].custody,destination:resources[0].destination}};
}
test('retained parent and called child use distinct owner frontier, host, configuration and custody',()=>{
 const {snapshot,reservation}=fixture();assert.equal(destinationResourceEvidence(snapshot,reservation).owners.length,2);
 for(const field of ['executionId','frontierSha256','hostCutSha256','bindingSha256','configurationSha256']){
  const changed=structuredClone(reservation);changed.resources[1].custody.intent[field]=changed.resources[0].custody.intent[field];
  assert.throws(()=>destinationResourceEvidence(snapshot,changed));
 }
 assert.throws(()=>destinationResourceEvidence(snapshot,{...reservation,resources:reservation.resources.slice(0,1)}));
 const changed=structuredClone(reservation);changed.resources[1].custody.agentIds=['agent-0'];assert.throws(()=>destinationResourceEvidence(snapshot,changed));
});
