import type { AgentMentionBindingDto, DraftAttachmentDto } from "@ponderosa/core";
import { readBrowserStorage, writeBrowserStorage } from "../../browserStorage.js";
import { readChatState, readChatStateEntries, writeChatState } from "../../chatState.js";

/** Unacknowledged editable content, with the revision it was edited against. */
export interface DraftTextRecovery {
  text: string;
  mentionBindings: AgentMentionBindingDto[];
  expectedRevision: number;
  clientId: string;
  /** Unacknowledged staged assets; bytes remain in the owner-scoped server store. */
  attachmentIds?: string[];
  attachments?: DraftAttachmentDto[];
}

const recoveryKey = (key: string, clientId: string) => `${key}.pending-text.v2.${encodeURIComponent(clientId)}`;

function parseRecovery(raw: string | undefined): DraftTextRecovery | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value.text !== "string" || typeof value.clientId !== "string" ||
        !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
        !Array.isArray(value.mentionBindings) || value.mentionBindings.some((binding: Record<string, unknown>) =>
          !binding || ["agentId", "projectId", "handle", "currentHandle", "currentTitle"]
            .some(field => typeof binding[field] !== "string"))) return undefined;
    if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 20 || value.attachmentIds.some((id: unknown) => typeof id !== "string"))) return undefined;
    if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 20 || value.attachments.some((asset: DraftAttachmentDto) => !asset || typeof asset.id !== "string" || typeof asset.name !== "string" || typeof asset.mediaType !== "string" || typeof asset.downloadUrl !== "string" || !asset.downloadUrl.startsWith("/api/conversations/")))) return undefined;
    return value;
  } catch { return undefined; }
}

/** Each writer owns a separate key: parallel tabs never rewrite a shared map. */
export function readDraftTextRecoveries(key: string | undefined): DraftTextRecovery[] {
  if (!key) return [];
  return readChatStateEntries(`${key}.pending-text.v2.`)
    .flatMap(([, raw]) => { const value = parseRecovery(raw); return value ? [value] : []; });

}

export function readDraftTextRecovery(key: string | undefined, clientId?: string): DraftTextRecovery | undefined {
  if (!key) return undefined;
  if (clientId !== undefined) return parseRecovery(readChatState(recoveryKey(key, clientId)));
  return readDraftTextRecoveries(key).at(-1);
}

export function writeDraftTextRecovery(key: string | undefined, value: DraftTextRecovery): void {
  if (!key) return;
  writeChatState(recoveryKey(key, value.clientId), JSON.stringify(value));
  // A remounted surface prefers this tab's edit, even when another tab wrote
  // a different snapshot more recently. This pointer never grants CAS authority.
  writeBrowserStorage("sessionStorage", `${key}.pending-writer.v2`, value.clientId);
}

/** An old acknowledgement must not erase another surface's edit. */
export function acknowledgeDraftTextRecovery(
  key: string | undefined,
  clientId: string,
  saved: Pick<DraftTextRecovery, "text" | "mentionBindings" | "attachmentIds">,
  revision: number,
): void {
  const pending = readDraftTextRecovery(key, clientId);
  if (!key || !pending || pending.clientId !== clientId) return;
  if (pending.text === saved.text &&
      JSON.stringify(pending.mentionBindings) === JSON.stringify(saved.mentionBindings) &&
      (pending.attachmentIds === undefined || JSON.stringify(pending.attachmentIds) === JSON.stringify(saved.attachmentIds ?? []))) {
    writeChatState(recoveryKey(key, clientId), "");
  } else writeChatState(recoveryKey(key, clientId), JSON.stringify({ ...pending, expectedRevision: Math.max(pending.expectedRevision, revision) }));
}

/** A confirmed send can retire its exact browser snapshot after navigation,
 * but not another visit's recovery edit, even if its visible text is identical. */
export function retireSubmittedDraftText(
  key: string | undefined,
  clientId: string,
  saved: Pick<DraftTextRecovery, "text" | "mentionBindings" | "attachmentIds">,
  revision: number,
): void {
  if (!key) return;
  const pending = readDraftTextRecovery(key, clientId);
  const sameSubmission = !pending || (pending.clientId === clientId &&
    pending.text === saved.text &&
    JSON.stringify(pending.mentionBindings) === JSON.stringify(saved.mentionBindings));
  if (sameSubmission && !readDraftTextRecoveries(key).some(value => value.clientId !== clientId) && readChatState(key) === saved.text) writeChatState(key, "");
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
  canonical: { revision: number; text: string; mentionBindings?: AgentMentionBindingDto[]; attachmentIds?: string[] },
): DraftTextRecovery | undefined {
  const pending = readDraftTextRecoveries(key).filter(value => {
    const matching = canonical.revision >= value.expectedRevision &&
      canonical.text === value.text &&
      JSON.stringify(canonical.mentionBindings ?? []) === JSON.stringify(value.mentionBindings) &&
      (value.attachmentIds === undefined || JSON.stringify(canonical.attachmentIds ?? []) === JSON.stringify(value.attachmentIds));
    if (matching) acknowledgeDraftTextRecovery(key, value.clientId, value, canonical.revision);
    return !matching;
  });
  const preferred = key ? readBrowserStorage("sessionStorage", `${key}.pending-writer.v2`) : undefined;
  return pending.find(value => value.clientId === preferred) ?? pending.at(-1);
}
