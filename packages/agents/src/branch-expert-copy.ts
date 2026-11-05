import type Database from "better-sqlite3";
import type { CheckpointPackageReceipt, CheckpointPackageSource } from "@ponderosa/core";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";

export interface BranchExpertCopyIdentity {
  executionId:string; stepExecutionId:string; attemptId:string;
  sourceAgentId:string; sourceChatId:string; sourceProjectId:string;
  snapshotSource:CheckpointPackageSource;
}
export interface BranchExpertCopyReceipt extends BranchExpertCopyIdentity {
  schema:"branch-expert-copy.v1"; state:"reserved"|"active";
  snapshotReceipt?:CheckpointPackageReceipt;
  copyAgentId?:string; copyChatId?:string; copyProjectId?:string; creationOperationId?:string; requestId?:string;
  consent?:{snapshotSha256:string;reviewSha256:string;copySourceMemory:boolean;allowFindingsWriteback:boolean};
  accessReview?:import("@ponderosa/core").AgentAccessImportReviewDto;
  accessChoice?:NonNullable<import("@ponderosa/core").ImportAgentPackageRequest["accessSettingsResolution"]>;
}
const key=(stepId:string)=>`expert-copy:${stepId}`;
const identity=(r:BranchExpertCopyReceipt):BranchExpertCopyIdentity=>({
  executionId:r.executionId,stepExecutionId:r.stepExecutionId,attemptId:r.attemptId,
  sourceAgentId:r.sourceAgentId,sourceChatId:r.sourceChatId,sourceProjectId:r.sourceProjectId,snapshotSource:r.snapshotSource,
});
/** Receipt writes are composed inside the existing Branch unit transaction. */
export function readBranchExpertCopy(db:Database.Database,executionId:string,stepId:string):BranchExpertCopyReceipt|undefined {
  const row=db.prepare("SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?").get(executionId,key(stepId)) as {input_hash:string;result_json:string}|undefined;
  if(!row)return undefined;
  const r=JSON.parse(row.result_json) as BranchExpertCopyReceipt;
  if(r.schema!=="branch-expert-copy.v1"||r.executionId!==executionId||r.stepExecutionId!==stepId||
    stableJson(r)!==row.result_json||payloadHash(identity(r))!==row.input_hash||
    !["reserved","active"].includes(r.state)||!r.attemptId||!r.sourceAgentId||!r.sourceChatId||!r.sourceProjectId||
    r.snapshotSource?.sourceChatId!==r.sourceChatId||r.snapshotSource?.intent.executionId!==executionId||
    r.snapshotSource?.intent.resourceStepId!==stepId||stableJson(r.snapshotSource?.agentIds)!==stableJson([r.sourceAgentId]))
    throw Error("Expert copy receipt integrity failure");
  if(r.snapshotReceipt){
    const {version,custodyId,boundaryId,sha256,byteLength,...source}=r.snapshotReceipt;
    if(version!==1||!custodyId||!boundaryId||!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(byteLength)||byteLength<=0||
      stableJson(source)!==stableJson(r.snapshotSource))throw Error("Expert copy snapshot receipt integrity failure");
  }
  if(r.consent&&(!r.snapshotReceipt||!r.accessChoice||r.consent.snapshotSha256!==r.snapshotReceipt.sha256||
    r.consent.reviewSha256!==r.accessChoice.reviewSha256||typeof r.consent.copySourceMemory!=="boolean"||typeof r.consent.allowFindingsWriteback!=="boolean"))
    throw Error("Expert copy consent integrity failure");
  if(r.state==="active"&&(!r.snapshotReceipt||!r.creationOperationId||!r.copyAgentId||!r.copyChatId||!r.copyProjectId||!r.requestId||
    !r.consent?.copySourceMemory))throw Error("Expert copy activation receipt incomplete");
  return r;
}
export function reserveBranchExpertCopy(db:Database.Database,input:BranchExpertCopyIdentity):BranchExpertCopyReceipt {
  const previous=readBranchExpertCopy(db,input.executionId,input.stepExecutionId);
  if(previous){if(stableJson(identity(previous))!==stableJson(input))throw Error("Expert copy reservation differs");return previous;}
  const receipt:BranchExpertCopyReceipt={schema:"branch-expert-copy.v1",...input,state:"reserved"};
  db.prepare("INSERT INTO branch_commands VALUES(?,?,?,?,?)").run(input.executionId,key(input.stepExecutionId),payloadHash(input),stableJson(receipt),new Date().toISOString());
  return receipt;
}
export function sealBranchExpertSnapshot(db:Database.Database,executionId:string,stepId:string,receipt:CheckpointPackageReceipt):void {
  const r=readBranchExpertCopy(db,executionId,stepId);if(!r||r.state!=="reserved")throw Error("Expert copy snapshot reservation unavailable");
  const {version,custodyId,boundaryId,sha256,byteLength,...source}=receipt;
  if(version!==1||!custodyId||!boundaryId||!sha256||!byteLength||stableJson(source)!==stableJson(r.snapshotSource))throw Error("Expert copy snapshot differs from its reservation");
  if(r.snapshotReceipt&&stableJson(r.snapshotReceipt)!==stableJson(receipt))throw Error("Expert copy snapshot already sealed differently");
  db.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?").run(stableJson({...r,snapshotReceipt:receipt}),executionId,key(stepId));
}
export function reserveBranchExpertChat(db:Database.Database,executionId:string,stepId:string,chat:{copyChatId:string;copyProjectId:string}):void {
  const r=readBranchExpertCopy(db,executionId,stepId);if(!r||r.state!=="reserved"||!r.snapshotReceipt||!chat.copyChatId||!chat.copyProjectId||chat.copyChatId===r.sourceChatId)throw Error("Expert copy Chat reservation invalid");
  if(r.copyChatId&&(r.copyChatId!==chat.copyChatId||r.copyProjectId!==chat.copyProjectId))throw Error("Expert copy Chat identity changed");
  db.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?").run(stableJson({...r,...chat}),executionId,key(stepId));
}
export function reserveBranchExpertImport(db:Database.Database,executionId:string,stepId:string,creationOperationId:string):void {
  const r=readBranchExpertCopy(db,executionId,stepId);if(!r||r.state!=="reserved"||!r.copyChatId||!creationOperationId)throw Error("Expert copy import reservation invalid");
  if(r.creationOperationId&&r.creationOperationId!==creationOperationId)throw Error("Expert copy import identity changed");
  db.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?").run(stableJson({...r,creationOperationId}),executionId,key(stepId));
}
export function reviewBranchExpertAccess(db:Database.Database,executionId:string,stepId:string,review:import("@ponderosa/core").AgentAccessImportReviewDto,choice?:NonNullable<import("@ponderosa/core").ImportAgentPackageRequest["accessSettingsResolution"]>,consent?:{snapshotSha256:string;reviewSha256:string;copySourceMemory:boolean;allowFindingsWriteback:boolean}):void {
  const r=readBranchExpertCopy(db,executionId,stepId);
  if(!r||r.state!=="reserved"||!r.copyChatId||!r.snapshotReceipt||r.creationOperationId)throw Error("Expert copy access review is unavailable");
  if(choice&&choice.reviewSha256!==review.reviewSha256)throw Error("Expert copy access review changed");
  if(consent&&(!choice||consent.reviewSha256!==review.reviewSha256||consent.snapshotSha256!==r.snapshotReceipt.sha256||typeof consent.copySourceMemory!=="boolean"||typeof consent.allowFindingsWriteback!=="boolean"))throw Error("Expert copy consent does not match this snapshot and review");
  const {accessChoice:previous,consent:previousConsent,...unchosen}=r;
  db.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?").run(stableJson({...unchosen,accessReview:review,...(choice?{accessChoice:choice}:{}),...(consent?{consent}:{})}),executionId,key(stepId));
}
export function bindBranchExpertCopy(db:Database.Database,executionId:string,stepId:string,copy:{copyAgentId:string;copyChatId:string;copyProjectId:string;requestId:string}):void {
  const r=readBranchExpertCopy(db,executionId,stepId);if(!r||r.state!=="reserved"||!r.snapshotReceipt||!r.accessChoice||!r.consent?.copySourceMemory||r.consent.reviewSha256!==r.accessChoice.reviewSha256||r.consent.snapshotSha256!==r.snapshotReceipt.sha256)throw Error("Expert copy source snapshot or explicit consent unavailable");
  if(!copy.copyAgentId||!copy.copyChatId||!copy.copyProjectId||!copy.requestId||!r.creationOperationId||copy.copyChatId!==r.copyChatId||copy.copyProjectId!==r.copyProjectId||copy.copyAgentId===r.sourceAgentId||copy.copyChatId===r.sourceChatId)throw Error("Expert copy destination identity invalid");
  db.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?").run(stableJson({...r,...copy,state:"active"}),executionId,key(stepId));
}
