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
          (item.dispatchStarted !== undefined && typeof item.dispatchStarted !== "boolean") ||
          !["send", "queue"].includes(item.action) || !["pending", "failed", "unknown", "accepted"].includes(item.status) ||
          (scope !== undefined && item.scope !== scope) ||
          (ownerId !== undefined && item.ownerId !== ownerId)) return [];
      return [item];
    } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt || a.pending.idempotencyKey.localeCompare(b.pending.idempotencyKey));
}
export function saveCapturedSubmission(item: CapturedSubmission): void {
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
const running = new Map<string, Promise<unknown>>();
export function capturedSubmissionRunning(id: string): boolean { return running.has(id); }
export function runCapturedSubmission(item: CapturedSubmission, execute: () => Promise<unknown>): Promise<unknown> {
  const id = item.pending.idempotencyKey;
  const existing = running.get(id);
  if (existing) return existing;
  const scope = JSON.stringify([item.scope, item.ownerId]);
  const previous = transports.get(scope) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    // Check order inside the cross-tab lock: another tab may have resolved an
    // earlier record while this tab waited to acquire the same owner scope.
    const run = async () => {
      if (!capturedSubmissionExists(id)) return;
      const ordered = readCapturedSubmissions(item.scope, item.ownerId).filter(value => value.status !== "accepted");
      if (item.status !== "accepted" && ordered[0]?.pending.idempotencyKey !== id) {
        throw new CapturedSubmissionOrderError("Resolve the earlier captured message before retrying this item.");
      }
      return execute();
    };
    return withCapturedSubmissionLock(item, run);
  });
  running.set(id, operation);
  transports.set(scope, operation);
  void operation.finally(() => {
    running.delete(id);
    if (transports.get(scope) === operation) transports.delete(scope);
    globalThis.window?.dispatchEvent(new Event(submissionOutboxEvent));
  }).catch(() => undefined);
  return operation;
}
