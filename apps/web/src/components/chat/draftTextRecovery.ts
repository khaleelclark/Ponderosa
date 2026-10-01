import type { AgentMentionBindingDto } from "@ponderosa/core";
import { readChatState, writeChatState } from "../../chatState.js";

/** Only unacknowledged text, with the revision it was edited against. */
export interface DraftTextRecovery {
  text: string;
  mentionBindings: AgentMentionBindingDto[];
  expectedRevision: number;
  clientId: string;
}

const recoveryKey = (key: string) => `${key}.pending-text.v1`;

export function readDraftTextRecovery(key: string | undefined): DraftTextRecovery | undefined {
  if (!key) return undefined;
  try {
    const value = JSON.parse(readChatState(recoveryKey(key)) ?? "null");
    if (!value || typeof value.text !== "string" || typeof value.clientId !== "string" ||
        !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
        !Array.isArray(value.mentionBindings) || value.mentionBindings.some((binding: Record<string, unknown>) =>
          !binding || ["agentId", "projectId", "handle", "currentHandle", "currentTitle"]
            .some(field => typeof binding[field] !== "string"))) return undefined;
    return value;
  } catch { return undefined; }
}

export function writeDraftTextRecovery(key: string | undefined, value: DraftTextRecovery): void {
  if (key) writeChatState(recoveryKey(key), JSON.stringify(value));
}

/** An old acknowledgement must not erase another surface's edit. */
export function acknowledgeDraftTextRecovery(
  key: string | undefined,
  clientId: string,
  saved: Pick<DraftTextRecovery, "text" | "mentionBindings">,
  revision: number,
): void {
  const pending = readDraftTextRecovery(key);
  if (!key || !pending || pending.clientId !== clientId) return;
  if (pending.text === saved.text &&
      JSON.stringify(pending.mentionBindings) === JSON.stringify(saved.mentionBindings)) writeChatState(recoveryKey(key), "");
  else writeDraftTextRecovery(key, { ...pending, expectedRevision: revision });
}

/** A confirmed send can retire its exact browser snapshot after navigation,
 * but not another visit's recovery edit, even if its visible text is identical. */
export function retireSubmittedDraftText(
  key: string | undefined,
  clientId: string,
  saved: Pick<DraftTextRecovery, "text" | "mentionBindings">,
  revision: number,
): void {
  if (!key) return;
  const pending = readDraftTextRecovery(key);
  const sameSubmission = !pending || (pending.clientId === clientId &&
    pending.text === saved.text &&
    JSON.stringify(pending.mentionBindings) === JSON.stringify(saved.mentionBindings));
  if (sameSubmission && readChatState(key) === saved.text) writeChatState(key, "");
  acknowledgeDraftTextRecovery(key, clientId, saved, revision);
}

/**
 * Only matching content proves this edit was saved. A newer empty draft may be
 * an earlier clear whose response was delayed while the user typed new work.
 * Preserve ambiguous edits with their old CAS revision for explicit recovery.
 * Successful send persistence already consumes its exact recovery record.
 */
export function recoverDraftText(
  key: string | undefined,
  canonical: { revision: number; text: string; mentionBindings?: AgentMentionBindingDto[] },
): DraftTextRecovery | undefined {
  const pending = readDraftTextRecovery(key);
  if (!pending) return undefined;
  if (canonical.revision >= pending.expectedRevision &&
      canonical.text === pending.text &&
      JSON.stringify(canonical.mentionBindings ?? []) === JSON.stringify(pending.mentionBindings)) {
    acknowledgeDraftTextRecovery(key, pending.clientId, pending, canonical.revision);
    return undefined;
  }
  return pending;
}
