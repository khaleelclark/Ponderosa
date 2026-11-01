import type {CoordinationDestinationGroupReconciliationReview} from './coordination-destination.js';
import type {CoordinationDestinationReconciliationReview} from './coordination-destination.js';
export interface MemoryMutationEffect {
  scope:string;log:boolean;operation:'create_collection'|'delete_collection'|'upsert'|'add'|'update'|'delete'|'modify';
}
export interface MemoryMutationHoldDto {id:string;sha256:string;effect?:MemoryMutationEffect;state:'unsettled'|'reconciled';legacy:boolean}
export interface MemoryMutationReviewDto {
  hold:MemoryMutationHoldDto;reviewSha256:string;backendSha256?:string;rowCount?:number;
  canReconcile:boolean;backendDrainEvidenceRequired:true;reason?:string;
}
export interface MemoryMutationReconcileInput {
  commandKey:string;reviewSha256:string;backendDrainEvidence:string;
  preserveCurrentBackend:true;
}
export interface MemoryMutationReconcileReceipt {
  version:1;id:string;commandKey:string;reviewSha256:string;holdSha256:string;backendSha256:string;
  backendDrainEvidence:string;operatorId:'local-operator';state:'reconciled';
}
export interface CheckpointCustodyLifecycleEntry {
  custodyId:string;state:'capturing'|'failed'|'retained'|'released'|'reconciled';
  checkpointId?:string;sourceChatId?:string;sourceAgentIds:string[];
  references:string[];blockers:string[];reviewSha256:string;
  files:Array<{name:string;byteLength:number;sha256:string}>;
}
export interface CheckpointCustodyReconcileInput {
  commandKey:string;reviewSha256:string;preserveEvidence:true;
}
export interface CheckpointCustodyReconcileReceipt {
  version:1;custodyId:string;commandKey:string;reviewSha256:string;state:'reconciled';
  evidenceDirectory:string;preservedBytes:number;filesSha256:string;operatorId:'local-operator';
}
export interface AgentImportLifecycleReview {
  operationId:string;creationOperationId?:string;canRetireMutationFree:boolean;
  blockers:string[];reviewSha256:string;
}
export interface AgentImportLifecycleReconcileInput {
  commandKey:string;reviewSha256:string;action:'preserve_unresolved'|'retire_mutation_free';note:string;
}
export interface AgentImportLifecycleReceipt {
  version:1;operationId:string;commandKey:string;reviewSha256:string;
  state:'preserved_unresolved'|'retired';operatorId:'local-operator';evidenceDirectory?:string;
}

export interface BranchCustodyReviewInput {source:import('./branches.js').CheckpointPackageSource}
export interface BranchCustodyCheckpointRetirementInput extends BranchCustodyReviewInput {
 commandKey:string;expectedRevision:string;checkpoints:{id:number;sha256:string}[];
}
export interface CheckpointCaptureAbandonmentReviewInput {source:import('./branches.js').CheckpointPackageSource;captureKey:string}
export interface CheckpointCaptureAbandonmentInput extends CheckpointCaptureAbandonmentReviewInput {
 commandKey:string;reviewSha256:string;preserveEvidence:true;
}
export interface DestinationRetirementChoice {
 commandKey:string;expectedReviewHash:string;releaseSourcePins:boolean;authorizeDeletedOwner:true;
}
export interface CheckpointCaptureAbandonmentReviewDto {
 custodyId:string;branchRevision:string;captureSha256:string;packageReviewSha256:string;
 references:string[];blockers:string[];reviewSha256:string;
}
export interface CheckpointCaptureAbandonmentReceipt {
 state:'abandoned';custodyId:string;commandKey:string;reviewSha256:string;captureArchiveSha256:string;
 branch:unknown;package:CheckpointCustodyReconcileReceipt;
}
export interface DestinationRetirementApprovalDto {
 admissionId:string;operatorId:'local-operator';choice:DestinationRetirementChoice;reviewHash:string;
}

export interface DestinationRetirementReviewDto extends CoordinationDestinationReconciliationReview {
 preserveOnlyPermanent:true;globalRuntimeQuiescenceRequired:true;canReleaseSourcePins:boolean;
}

/** Whole-group commands use one admission and one immutable disposition for all resources. */
export type DestinationGroupRetirementChoice=DestinationRetirementChoice;
export type DestinationGroupRetirementApprovalDto=DestinationRetirementApprovalDto;
export interface DestinationGroupRetirementReviewDto extends CoordinationDestinationGroupReconciliationReview {
 preserveOnlyPermanent:true;globalRuntimeQuiescenceRequired:true;canReleaseSourcePins:boolean;
}
export type DestinationGroupRetirementReceipt=import('./coordination-destination.js').CoordinationDestinationGroupReconciliationReceipt;

/** Operator audit discovery; identifiers are retained originals, never admission/cleanup authority. */
export interface LifecycleDiscoveryQuery {cursor?:string;limit?:number|string}
export interface LifecycleDiscoveryPage<T> {items:T[];revision:string;nextCursor?:string;unverifiedEvidenceCount?:number}
export interface LifecycleAuditOwner {
 projectId:string;conversationId:string;
 project:'current'|'deletion_receipt'|'retained_only';conversation:'current'|'deletion_receipt'|'retained_only';
}
export interface LifecycleImportEntry {
 operationId:string;owner:LifecycleAuditOwner;product:'dev'|'branches';status:string;phase:string;
 evidenceOrigin:'journal'|'retained_lifecycle';lifecycleState?:string;evidenceSha256:string;
}
export interface LifecycleDestinationEntry {
 admissionId:string;group:boolean;state:'reserved'|'staged'|'admitted'|'retired';
 branchId:string;sourceExecutionId:string;sourceOwner:'current'|'retained_only';checkpointId:number;checkpointHash:string;
 destinations:(LifecycleAuditOwner&{executionId:string;resourceStepId:string;sourceChatId:string})[];evidenceSha256:string;
}
export interface LifecycleCaptureEntry {
 captureKey:string;source:import('./branches.js').CheckpointPackageSource;branchId?:string;
 sourceOwner:'current'|'retained_only';state:'capturing';evidenceSha256:string;
}

/** Exact issued-group capture identity, obtained from retained intent discovery. */
export interface CheckpointGroupCaptureAbandonmentReviewInput {executionId:string;captureKey:string}
export interface CheckpointGroupCaptureAbandonmentInput extends CheckpointGroupCaptureAbandonmentReviewInput {
 commandKey:string;reviewSha256:string;preserveEvidence:true;
}
export interface CheckpointGroupCaptureAbandonmentReviewDto extends CheckpointGroupCaptureAbandonmentReviewInput {
 groupId:string;captureSha256:string;branchRevision:string;
 packages:(CheckpointCustodyLifecycleEntry&{source:import('./branches.js').CheckpointPackageSource})[];
 references:string[];blockers:string[];reviewSha256:string;
}
export interface CheckpointGroupCaptureAbandonmentReceipt {
 state:'abandoned';groupId:string;commandKey:string;reviewSha256:string;captureArchiveSha256:string;
 branch:unknown;packages:CheckpointCustodyReconcileReceipt[];
}
export interface LifecycleGroupCaptureEntry extends CheckpointGroupCaptureAbandonmentReviewInput {
 sources:import('./branches.js').CheckpointPackageSource[];capturedCheckpointIds:string[];
 sourceOwner:'current'|'retained_only';state:'capturing';evidenceSha256:string;
}
