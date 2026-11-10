import type { AgentMentionBindingDto, DraftPendingSubmissionDto } from "@ponderosa/core";
import { readChatState, readChatStateEntries, writeChatState } from "../../chatState.js";

/** Captured browser intents, never accepted queue authority. Each operation has
 * its own key so another tab or a later draft cannot overwrite its retry ID. */
export interface CapturedSubmission {
  version: 1;
  scope: string;
  storageKey: string;
  ownerId: string;
  projectId?: string;
  clientId: string;
  createdAt: number;
  action: "send" | "queue";
  text: string;
  editorText: string;
  pastedText?: string;
  attachmentNames: string[];
  mentionedAgents: AgentMentionBindingDto[];
  newAgentRequested: boolean;
  pending: DraftPendingSubmissionDto;
  status: "pending" | "failed" | "unknown" | "accepted";
  /** IDs from an observed server receipt; never inferred from matching text. */
  acceptedDeliveryIds?: string[];
  /** Exact existing transport identity; observation, not this hint, proves acceptance. */
  communicationId?: string;
  /** A crash after dispatch must reconcile before disposal is allowed. */
  dispatchStarted?: boolean;
  error?: string;
}
const prefix = "ponderosa.submission.v1.";
const keyFor = (id: string) => `${prefix}${id}`;
export const submissionOutboxEvent = "ponderosa-submission-outbox";

export function readCapturedSubmissions(scope?: string, ownerId?: string): CapturedSubmission[] {
  return readChatStateEntries(prefix).flatMap(([, raw]) => {
    try {
      const item = JSON.parse(raw) as CapturedSubmission;
      if (item.version !== 1 || typeof item.scope !== "string" || typeof item.text !== "string" ||
          typeof item.ownerId !== "string" || typeof item.storageKey !== "string" ||
          typeof item.clientId !== "string" || !Number.isFinite(item.createdAt) ||
          !item.pending || typeof item.pending.idempotencyKey !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.pending.fingerprint) ||
          !Array.isArray(item.mentionedAgents) || !Array.isArray(item.attachmentNames) ||
          (item.acceptedDeliveryIds !== undefined && (!Array.isArray(item.acceptedDeliveryIds) || item.acceptedDeliveryIds.length > 32 || item.acceptedDeliveryIds.some(id => typeof id !== "string"))) ||
          (item.communicationId !== undefined && (typeof item.communicationId !== "string" || item.communicationId.length>200)) ||
          (item.dispatchStarted !== undefined && typeof item.dispatchStarted !== "boolean") ||
          !["send", "queue"].includes(item.action) || !["pending", "failed", "unknown", "accepted"].includes(item.status) ||
          (scope !== undefined && item.scope !== scope) ||
          (ownerId !== undefined && item.ownerId !== ownerId)) return [];
      return [item];
    } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt || a.pending.idempotencyKey.localeCompare(b.pending.idempotencyKey));
}
export function saveCapturedSubmission(item: CapturedSubmission): void {
  // Canonical observation can arrive while an original-key attempt is preparing.
  // A delayed metadata/error writer must never demote that observed acceptance.
  const accepted=readCapturedSubmissions(item.scope,item.ownerId).find(current=>current.pending.idempotencyKey===item.pending.idempotencyKey&&current.status==="accepted");
  if(accepted&&item.status!=="accepted")item={...item,status:"accepted",communicationId:accepted.communicationId??item.communicationId,acceptedDeliveryIds:accepted.acceptedDeliveryIds??item.acceptedDeliveryIds};
  if (!writeChatState(keyFor(item.pending.idempotencyKey), JSON.stringify(item))) {
    throw new Error("This message could not be saved for recovery. Free browser storage and retry.");
  }
  globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
}
export function removeCapturedSubmission(id: string): void {
  if (!writeChatState(keyFor(id), "")) throw new Error("The accepted message recovery record could not be retired. Retry uses the same identity.");
  globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
}
export function capturedSubmissionExists(id: string): boolean { return readChatState(keyFor(id)) !== undefined; }

export class CapturedSubmissionOrderError extends Error {}
export async function withCapturedSubmissionLock<T>(item: CapturedSubmission, run: () => Promise<T>): Promise<T> {
  const scope = JSON.stringify([item.scope, item.ownerId]);
  return await (globalThis.navigator?.locks ? navigator.locks.request(`${prefix}${scope}`, run) : run());
}

// Transport order belongs to captured intents, independent of mounted editors.
const transports = new Map<string, Promise<unknown>>();
const running = new Map<string, {promise:Promise<unknown>;kind:"send"|"remove"}>();
export function capturedSubmissionRunning(id: string): boolean { return running.has(id); }
export function capturedSubmissionActivity(id:string):"send"|"remove"|undefined { return running.get(id)?.kind; }
export function earlierCapturedSubmission(item:CapturedSubmission):CapturedSubmission|undefined {
  if(item.status==="accepted")return;
  const first=readCapturedSubmissions(item.scope,item.ownerId).find(value=>value.status!=="accepted");
  return first&&first.pending.idempotencyKey!==item.pending.idempotencyKey?first:undefined;
}
function trackCapturedSubmission(id:string,operation:Promise<unknown>,kind:"send"|"remove"):Promise<unknown>{
  running.set(id,{promise:operation,kind});
  globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
  void operation.finally(()=>{
    if(running.get(id)?.promise===operation)running.delete(id);
    globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
  }).catch(()=>undefined);
  return operation;
}
/** Removal shares the same exact-owner cross-tab lock, but no send-order gate. */
export function removeRejectedCapturedSubmission(item:CapturedSubmission,remove:(current:CapturedSubmission)=>Promise<void>):Promise<unknown>{
  const id=item.pending.idempotencyKey,existing=running.get(id);if(existing)return existing.promise;
  if(!globalThis.navigator?.locks)return Promise.reject(new Error("This browser cannot safely coordinate message removal. Keep this message and use a browser with Web Locks."));
  const operation=withCapturedSubmissionLock(item,async()=>{
    const current=readCapturedSubmissions(item.scope,item.ownerId).find(value=>value.pending.idempotencyKey===id);
    if(!current)return;
    if(current.status!=="failed")throw new Error("Acceptance is unconfirmed. Reconcile this exact message before removal.");
    await remove(current);
  });
  return trackCapturedSubmission(id,operation,"remove");
}
export function runCapturedSubmission(item: CapturedSubmission, execute: (current: CapturedSubmission) => Promise<unknown>, onError?: (error: unknown, current: CapturedSubmission) => void): Promise<unknown> {
  const id = item.pending.idempotencyKey;
  const existing = running.get(id);
  if (existing) return existing.promise;
  const scope = JSON.stringify([item.scope, item.ownerId]);
  const previous = transports.get(scope) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    // Check order inside the cross-tab lock: another tab may have resolved an
    // earlier record while this tab waited to acquire the same owner scope.
    const run = async () => {
      if (!capturedSubmissionExists(id)) return;
      const currentItems = readCapturedSubmissions(item.scope, item.ownerId);
      const current = currentItems.find(value => value.pending.idempotencyKey === id);
      if (!current) throw new Error("Captured message is unavailable or changed. Preserve its recovery record.");
      try {
        const ordered = currentItems.filter(value => value.status !== "accepted");
        if (current.status !== "accepted" && ordered[0]?.pending.idempotencyKey !== id) {
          throw new CapturedSubmissionOrderError("Resolve the earlier captured message before retrying this item.");
        }
        return await execute(current);
      } catch (error) {
        if (!onError) throw error;
        onError(error, current);
      }
    };
    return withCapturedSubmissionLock(item, run);
  });
  transports.set(scope, operation);
  void operation.finally(() => {
    if (transports.get(scope) === operation) transports.delete(scope);
    globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
  }).catch(() => undefined);
  return trackCapturedSubmission(id,operation,"send");
}
