import type {BranchHostGraphRestoreDto, CheckpointPackageReceipt} from './branches.js';

/** Host-only contracts. No provider tool accepts these inputs. */
export interface CoordinationDestinationReservation {
  branchId:string; sourceExecutionId:string; checkpointId:number; checkpointHash:string;
  commandKey:string; operatorId:string; reconcileEffects:true;
  custody:CheckpointPackageReceipt;
  destination:{projectId:string;conversationId:string;executionId:string;resourceStepId:string;resourceGeneration:number};
}
export interface CoordinationDestinationImportPlan {
  creationOperationId:string; projectId:string; conversationId:string;
  agents:{sourceRef:string;agentId:string}[];
  artifacts:{sourceRef:string;destinationId:string;sha256:string;byteLength:number}[];
}
export interface CoordinationDestinationStage {
  importPlan:CoordinationDestinationImportPlan;
  /** Complete explicit original canonical participant -> fresh participant map. */
  agentMap:Record<string,string>;
  /** Complete original runtime artifact -> independently admitted artifact map. */
  artifactMap:Record<string,string>;
}
export interface CoordinationDestinationReview {
  admissionId:string; reviewHash:string; disclosureRevision:string;
  reservation:CoordinationDestinationReservation; stage:CoordinationDestinationStage;
  facts:{kind:'request'|'update'|'communication'|'join';id:string;sha256:string;originalAgentIds:string[];destinationAgentIds:string[];originalAudience:unknown;originalActor?:unknown}[];
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
  activationIds:string[]; owner:CoordinationDestinationOwnerReceipt;
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
