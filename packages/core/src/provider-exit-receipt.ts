import type {RuntimeProcessIdentity} from './adapter.js';

/** Host evidence of an observed process lifetime exit, never a provider outcome. */
export interface ProviderProcessRegistration {
  schema:'provider-process-registration.v1';
  authorityId:string;
  workerId:string;
  process: {kind:'posix';identity:RuntimeProcessIdentity}|{kind:'native-job';lifetimeId:string};
  purpose:string;
  projectId:string|null;
  agentId:string|null;
  conversationId:string|null;
  runId:string|null;
  runFence:number|null;
}
export interface ProviderProcessExitReceipt {
  schema:'provider-process-exit.v1';
  operationId:string;
  authorityId:string;
  result:'observed_exited';
  observation:'os-not-alive'|'close-confirmed';
  observedAt:string;
  registrations:Array<{identity:string;sha256:string;registration:ProviderProcessRegistration}>;
}
export interface ProviderNeverStartedReceipt {
  schema:'provider-never-started.v1';
  agentId:string;projectId:string;conversationId:string;executionId:string;stepExecutionId:string;generation:number;
  fence:{identity:string;sha256:string};coverage:{identity:string;sha256:string};drain:{identity:string;sha256:string};
}
interface ProviderExitEvidenceBody {
  projectId:string;
  conversationId:string;
  participants:Array<{agentId:string;runIds:string[]}>;
  runs:Array<{runId:string;agentId:string;fence:number;status:'completed'|'failed'|'cancelled'}>;
  receipts:Array<{identity:string;sha256:string;receipt:ProviderProcessExitReceipt}>;
  revision:string;
}

export type ProviderExitEvidence = ProviderExitEvidenceBody & ({schema:'provider-exit-evidence.v1'} | {schema:'provider-exit-evidence.v2';neverStarted:Array<{identity:string;sha256:string;receipt:ProviderNeverStartedReceipt}>});
