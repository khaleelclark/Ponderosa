import type {BranchHostGraphRestoreDto, CheckpointPackageReceipt} from './branches.js';

/** Host-only contracts. No provider tool accepts these inputs. */
export interface CoordinationDestinationReservation {
  branchId:string; sourceExecutionId:string; checkpointId:number; checkpointHash:string;
  commandKey:string; operatorId:string; reconcileEffects:true;
  custody:CheckpointPackageReceipt;
  /** Retired evidence only; never included in executable participant maps. */
  historicalPartition?:CoordinationHistoricalGenerationSelection[];
  /** Internal normalized group envelope; ordinary singular entrypoints reject it. */
  resources?:CoordinationDestinationGroupResource[];
  destination:{projectId:string;conversationId:string;executionId:string;resourceStepId:string;resourceGeneration:number};
}
export interface CoordinationDestinationImportPlan {
  creationOperationId:string; projectId:string; conversationId:string;
  agents:{sourceRef:string;agentId:string}[];
  artifacts:{sourceRef:string;destinationId:string;sha256:string;byteLength:number}[];
}
export interface CoordinationDestinationStage {
  importPlan:CoordinationDestinationImportPlan;
  imports?:Record<string,CoordinationDestinationImportPlan>;
  /** Complete explicit original canonical participant -> fresh participant map. */
  agentMap:Record<string,string>;
  /** Complete original runtime artifact -> independently admitted artifact map. */
  artifactMap:Record<string,string>;
}
export interface CoordinationDestinationReview {
  admissionId:string; reviewHash:string; disclosureRevision:string;
  reservation:CoordinationDestinationReservation; stage:CoordinationDestinationStage;
  facts:{kind:'request'|'update'|'communication'|'join'|'historical_generation';id:string;sha256:string;originalAgentIds:string[];destinationAgentIds:string[];originalAudience:unknown;originalActor?:unknown}[];
}
export interface CoordinationDestinationOwnerReceipt {
  executionId:string; resourceStepId:string; resourceGeneration:number; creationOperationId:string;
  /** Branch persists these exact references in its own tables in the same transaction. */
  requestBindings:{sourceRequestId:string;requestId:string;stepExecutionId:string}[];
  /** Branch command key; result_json.coordinationDestination stores the exact graph receipt. */
  receiptId:string;
}
export interface CoordinationDestinationReceipt extends BranchHostGraphRestoreDto {
  admissionId:string; reservationHash:string; stageHash:string; reviewHash:string;
  destination:CoordinationDestinationReservation['destination'];
  agentMap:Record<string,string>; artifactMap:Record<string,string>;
  historicalPartition?:{sha256:string;selection:CoordinationHistoricalGenerationSelection;seal:Record<string,unknown>;retirement:{inputHash:string;resultJson:string};destinationAgentIds:string[];historical:true;dispatchable:false}[];
  activationIds:string[]; owner:CoordinationDestinationOwnerReceipt;
  owners?:CoordinationDestinationOwnerReceipt[];
}

/** Explicit action by the single host-local operator, never an imported grant. */
export interface BranchDisclosureChoice {
 commandKey:string; action:'approve'|'revoke'; reviewHash:string; expectedRevision:number;
}
export interface BranchDisclosureReceipt {
 admissionId:string; commandKey:string; action:'approve'|'revoke'; reviewHash:string;
 revision:number; state:'approved'|'revoked'; active:boolean;
}
export interface BranchDisclosureReviewDto {
 admissionId:string; reviewHash:string; revision:number; state:'unreviewed'|'approved'|'revoked'; active:boolean;
 policyRevision:string; hostCutSha256:string;
 review:Omit<CoordinationDestinationReview,'reviewHash'|'disclosureRevision'>;
 /** Exact original fact content for the human review surface; retains original actors/audiences. */
 facts:(CoordinationDestinationReview['facts'][number]&{content:unknown})[];
 policy:unknown;
}

/** Single supported issued-resource destination; effects require explicit commands. */
export interface BranchIssuedDestinationInput {
  /** Copy from the server's exact generation-one selection preview. */
  historicalReviewHash?:string;
 commandKey:string; checkpointId:number; expectedHash:string; reconcileEffects:true;
 accessSettingsResolution?:import('./dto/agents.js').ImportAgentPackageRequest['accessSettingsResolution'];
}
export interface BranchIssuedDestinationDto {
 historicalPartition?:CoordinationHistoricalGenerationSelection[];
 commandKey:string; admissionId:string; checkpointId:number; checkpointHash:string;
 destination:CoordinationDestinationReservation['destination'];
 disclosure:{revision:number;state:'unreviewed'|'approved'|'revoked';reviewHash?:string};
 state:'reserved'|'import_unknown'|'awaiting_disclosure'|'admitted';
 restoreSupported:boolean; receipt?:CoordinationDestinationReceipt;
}

/** Host-only retirement: no provider or imported package can supply authority callbacks. */
export interface CoordinationDestinationReconciliationInput {
 admissionId:string; commandKey:string; operatorId:string;
 expectedReviewHash:string; releaseSourcePins:boolean;
}
export interface CoordinationDestinationReconciliationReview {
 admissionId:string; reviewHash:string; reservation:CoordinationDestinationReservation;
 state:string; stage:CoordinationDestinationStage|null; evidenceRevision:string;
 references:string[];
}
export interface CoordinationDestinationReconciliationReceipt {
 admissionId:string; commandKey:string; operatorId:string; reviewHash:string;
 releasedSourcePins:boolean; retiredAt:string;
}

/** Atomic whole-cut group: one resource organization per distinct source/fresh Chat. */
export interface CoordinationDestinationGroupResource {
 custody:CheckpointPackageReceipt;
 destination:CoordinationDestinationReservation['destination'];
}
export type CoordinationDestinationGroupReservation=Omit<CoordinationDestinationReservation,'custody'|'destination'|'resources'>&{
 resources:CoordinationDestinationGroupResource[];
};
export interface CoordinationDestinationGroupStage {
 /** Exact source Chat -> actual importer reservation, never inferred Agent identity. */
 imports:Record<string,CoordinationDestinationImportPlan>;
 agentMap:Record<string,string>; artifactMap:Record<string,string>;
}
export interface CoordinationDestinationGroupReceipt extends CoordinationDestinationReceipt {
 resources:CoordinationDestinationGroupResource[];
 owners:CoordinationDestinationOwnerReceipt[];
}

/** Exact retained slot rows, including importer stages before whole-group assembly. */
export interface CoordinationDestinationGroupReconciliationSlot {
 admission_id:string; source_chat_id:string; source_execution_id:string; conversation_id:string; stage_json:string|null;
}
export interface CoordinationDestinationGroupReconciliationReview extends CoordinationDestinationReconciliationReview {
 reservation:CoordinationDestinationReservation&{resources:CoordinationDestinationGroupResource[]};
 groupChats:CoordinationDestinationGroupReconciliationSlot[];
}
export interface CoordinationDestinationGroupReconciliationReceipt extends CoordinationDestinationReconciliationReceipt {
 resources:CoordinationDestinationGroupResource[];
 groupChats:CoordinationDestinationGroupReconciliationSlot[];
 evidenceSha256:string;
}

/** Exact prospective producer seal plus explicit current source-ref recipients for ALL retained facts. */
export interface CoordinationHistoricalGenerationSelection {
 executionId:string;stepId:string;generation:number;checkpointId:number;checkpointHash:string;envelopeSha256:string;
 intakeFence:{identity:string;sha256:string};
 /** Keys of the CURRENT destination stage.agentMap; old Agent identities are never remapped. */
 discloseTo:string[];
}
