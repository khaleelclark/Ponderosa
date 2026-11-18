import type { AgentMentionBindingDto, DraftAttachmentDto } from "@ponderosa/core";
import { readBrowserStorage, writeBrowserStorage } from "../../browserStorage.js";
import { readChatState, readChatStateEntries, writeChatState } from "../../chatState.js";
import { removeHandle } from "./Composer.helpers.js";
import { createClientId } from "../../clientId.js";

/** One unacknowledged edit, retaining its original server CAS authority. */
export interface DraftTextRecovery {
  text: string;
  mentionBindings: AgentMentionBindingDto[];
  expectedRevision: number;
  clientId: string;
  captureId?: string;
  attachmentIds?: string[];
  attachments?: DraftAttachmentDto[];
  pastedText?: string;
  pastedTextAttachmentId?: string;
  pastedTextAttachment?: DraftAttachmentDto;
  cleared?: true;
  retired?: true;
}

/** Owned by the existing mounted write chain, never shared between visits. */
export interface DraftRecoveryFence { key?: string; observed?: string; edit?: string }
const recoveryKey = (key: string) => `${key}.pending-text.v3`;
const legacyPrefix = (key: string) => `${key}.pending-text.v2.`;

function parseRecovery(raw: string | null | undefined): DraftTextRecovery | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value.text !== "string" || typeof value.clientId !== "string" ||
        !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
        !Array.isArray(value.mentionBindings) || value.mentionBindings.some((binding: Record<string, unknown>) =>
          !binding || ["agentId", "projectId", "handle", "currentHandle", "currentTitle"]
            .some(field => typeof binding[field] !== "string"))) return undefined;
    if ((value.cleared !== undefined && value.cleared !== true) || (value.retired !== undefined && value.retired !== true) ||
        (value.pastedText !== undefined && typeof value.pastedText !== "string") || (value.pastedTextAttachmentId !== undefined && typeof value.pastedTextAttachmentId !== "string")) return undefined;
    if (value.captureId !== undefined && typeof value.captureId !== "string") return undefined;
    if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 20 || value.attachmentIds.some((id: unknown) => typeof id !== "string"))) return undefined;
    if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 20)) return undefined;
    const assets = [...(value.attachments ?? []), ...(value.pastedTextAttachment ? [value.pastedTextAttachment] : [])];
    if (assets.some((asset: DraftAttachmentDto) => !asset || typeof asset.id !== "string" || typeof asset.name !== "string" || typeof asset.mediaType !== "string" || typeof asset.downloadUrl !== "string" || !/^\/api\/(?:branches\/engine\/)?conversations\//.test(asset.downloadUrl))) return undefined;
    return value;
  } catch { return undefined; }
}

export function hasDraftRecoveryContent(value: Pick<DraftTextRecovery, "text" | "mentionBindings" | "attachmentIds" | "pastedText" | "pastedTextAttachmentId">): boolean {
  const handles = ["new-agent", "broadcast", "everyone", ...value.mentionBindings.flatMap(binding => [binding.handle, binding.currentHandle])];
  return Boolean(value.attachmentIds?.length || value.pastedText || value.pastedTextAttachmentId || handles.reduce((text, handle) => removeHandle(text, handle), value.text).trim());
}

function persist(key: string, value: DraftTextRecovery): void {
  // Preserve legacy evidence if device storage fails; the existing memory
  // fallback keeps this page usable, without pretending a durable save passed.
  if (writeBrowserStorage("localStorage", recoveryKey(key), JSON.stringify(value)))
    for (const [old] of readChatStateEntries(legacyPrefix(key))) writeChatState(old, "");
}

function current(key: string): DraftTextRecovery | undefined {
  const saved = parseRecovery(readBrowserStorage("localStorage", recoveryKey(key)));
  if (saved?.captureId) return saved;
  const legacy = readChatStateEntries(legacyPrefix(key)).flatMap(([, raw]) => {
    const value = parseRecovery(raw); return value && hasDraftRecoveryContent(value) ? [value] : [];
  });
  if (!legacy.length) return undefined;
  const local = readChatState(key), preferred = readBrowserStorage("sessionStorage", `${key}.pending-writer.v2`);
  // Old entries have no capture timestamp. Prefer authored visible content,
  // then this tab's recorded writer; revision/ID only break remaining ties.
  legacy.sort((a,b) => Number(b.text === local) - Number(a.text === local) ||
    Number(b.clientId === preferred) - Number(a.clientId === preferred) ||
    b.expectedRevision - a.expectedRevision || a.clientId.localeCompare(b.clientId));
  const retained = { ...legacy[0]!, captureId: createClientId("recovery:") };
  persist(key, retained);
  return retained;
}

export const draftRecoveryCaptureId = (key: string | undefined): string | undefined => key ? current(key)?.captureId : undefined;

export function readDraftTextRecovery(key: string | undefined, clientId?: string): DraftTextRecovery | undefined {
  const value = key ? current(key) : undefined;
  return value && !value.cleared && !value.retired && (clientId === undefined || value.clientId === clientId) ? value : undefined;
}

/** Called for an authored mutation, not background hydration or acknowledgements. */
export function observeDraftTextRecovery(key: string | undefined, fence: DraftRecoveryFence): void {
  fence.key = key; fence.observed = key ? current(key)?.captureId : undefined;
  fence.edit = createClientId("edit:");
}

function owns(key: string, fence?: DraftRecoveryFence, before = current(key)): boolean {
  if (!fence) return true;
  if (fence.key !== key) observeDraftTextRecovery(key, fence);
  return fence.observed === before?.captureId;
}

export function writeDraftTextRecovery(key: string | undefined, value: DraftTextRecovery, fence?: DraftRecoveryFence): boolean {
  if (!key || !hasDraftRecoveryContent(value)) return true;
  const before = current(key);
  if (!owns(key, fence, before) || (value.captureId && value.captureId !== before?.captureId)) return false;
  const captureId = fence?.edit ?? value.captureId ?? createClientId("recovery:");
  persist(key, { ...value, captureId, cleared: undefined, retired: undefined });
  if (fence) fence.observed = captureId;
  return true;
}

export function discardDraftTextRecovery(key: string | undefined, clientId: string, revision: number, fence?: DraftRecoveryFence): void {
  if (!key || !owns(key, fence)) return;
  const captureId = fence?.edit ?? createClientId("clear:");
  persist(key, { text: "", mentionBindings: [], attachmentIds: [], clientId, expectedRevision: revision, captureId, cleared: true });
  writeChatState(key, "");
  if (fence) fence.observed = captureId;
}

type SavedEdit = Pick<DraftTextRecovery, "text" | "mentionBindings" | "attachmentIds" | "captureId" | "pastedText" | "pastedTextAttachmentId">;
const matches = (pending: DraftTextRecovery, saved: SavedEdit) =>
  (saved.captureId === undefined || pending.captureId === saved.captureId) && pending.text === saved.text &&
  (pending.pastedText === undefined || pending.pastedText === saved.pastedText ||
    (Boolean(pending.pastedTextAttachmentId) && pending.pastedTextAttachmentId === saved.pastedTextAttachmentId)) &&
  (pending.pastedTextAttachmentId === undefined || pending.pastedTextAttachmentId === saved.pastedTextAttachmentId) &&
  JSON.stringify(pending.mentionBindings) === JSON.stringify(saved.mentionBindings) &&
  (pending.attachmentIds === undefined || JSON.stringify(pending.attachmentIds) === JSON.stringify(saved.attachmentIds ?? []));

/** Late acknowledgement updates only this writer; a newer edit keeps its identity. */
export function acknowledgeDraftTextRecovery(key: string | undefined, clientId: string, saved: SavedEdit, revision: number): void {
  const pending = key ? current(key) : undefined;
  if (!key || !pending || pending.clientId !== clientId) return;
  const expectedRevision = Math.max(pending.expectedRevision, revision);
  persist(key, matches(pending, saved)
    ? { ...pending, text: "", mentionBindings: [], attachmentIds: [], attachments: [], pastedText: undefined, pastedTextAttachmentId: undefined, pastedTextAttachment: undefined, expectedRevision, retired: pending.cleared ? undefined : true }
    : { ...pending, expectedRevision });
}

export function retireSubmittedDraftText(key: string | undefined, clientId: string, saved: SavedEdit, revision: number): void {
  const pending = key ? current(key) : undefined;
  if (!key || !pending || pending.clientId !== clientId || !matches(pending, saved)) return;
  persist(key, { text: "", mentionBindings: [], attachmentIds: [], clientId, expectedRevision: revision,
    captureId: createClientId("sent:"), retired: true });
  if (readChatState(key) === saved.text) writeChatState(key, "");
}

/** Matching canonical content proves a save; a newer empty revision alone does not. */
export function recoverDraftText(key: string | undefined,
  canonical: { revision: number; text: string; mentionBindings?: AgentMentionBindingDto[]; attachmentIds?: string[]; pastedTextAttachmentId?: string },
): DraftTextRecovery | undefined {
  const pending = key ? current(key) : undefined;
  if (!pending || pending.retired) return undefined;
  if (pending.cleared) {
    return { ...pending, expectedRevision: canonical.text.trim() ? pending.expectedRevision : Math.max(pending.expectedRevision, canonical.revision) };
  }
  if (canonical.revision >= pending.expectedRevision && matches(pending, { text: canonical.text,
    mentionBindings: canonical.mentionBindings ?? [], attachmentIds: canonical.attachmentIds ?? [], pastedTextAttachmentId: canonical.pastedTextAttachmentId })) {
    acknowledgeDraftTextRecovery(key, pending.clientId, pending, canonical.revision);
    return undefined;
  }
  return pending;
}
