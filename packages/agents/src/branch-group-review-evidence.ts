import type {BranchDefinition,BranchGroupOwnerReviewEvidence} from '@ponderosa/core';
type Row=Record<string,any>;
/** Nonsecret projection of an exact saved owner plus its fresh canonical acceptance receipt. */
export function groupOwnerReviewEvidence(o:Row,definition:BranchDefinition,idMap:Record<string,string>,ownerMap:Record<string,string>,acceptance:BranchGroupOwnerReviewEvidence['acceptance']):BranchGroupOwnerReviewEvidence {
 const e=o.selected.execution[0],policy=definition.policy;
 return {branchId:e.branch_id,sourceExecutionId:o.executionId,destinationExecutionId:ownerMap[o.executionId]!,
  sourceParentExecutionId:e.parent_execution_id,sourceParentAttemptId:e.parent_attempt_id,
  destinationParentExecutionId:e.parent_execution_id?ownerMap[e.parent_execution_id]!:null,destinationParentAttemptId:e.parent_attempt_id?idMap[e.parent_attempt_id]!:null,
  counters:{traversals:e.traversals,loopIterations:e.loop_iterations,recoveryTraversals:e.recovery_traversals,callDepth:e.call_depth,depthCeiling:e.depth_ceiling,
   paths:o.selected.paths.map((p:Row)=>({sourcePathId:p.id,destinationPathId:idMap[p.id],traversals:p.traversals})),
   steps:o.selected.steps.map((s:Row)=>({sourceStepExecutionId:s.id,destinationStepExecutionId:idMap[s.id],invocation:s.invocation})),
   loops:o.selected.loops.map((l:Row)=>({sourcePathId:l.path_id,destinationPathId:idMap[l.path_id],edgeId:l.edge_id,iterations:l.iterations}))},
  limits:o.configuration.limits,policy,
  capacity:{maxConcurrentExecutions:policy.maxConcurrentExecutions,maxPathInstances:policy.maxPathInstances??1000,maxStepInvocations:policy.maxStepInvocations??1000,maxEphemeralAgents:policy.maxEphemeralAgents??100},
  selectedUsage:{paths:o.selected.paths.length,stepInvocations:o.selected.steps.length,requestedAgents:o.selected.resources.reduce((n:number,r:Row)=>n+r.requested_count,0)},acceptance};
}
