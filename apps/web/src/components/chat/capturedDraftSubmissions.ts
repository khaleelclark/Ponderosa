import type { ConversationDraftDto, PutConversationDraftRequest, DraftPendingSubmissionDto } from "@ponderosa/core";
import { api } from "../../api";
import { readCapturedSubmissions } from "./submissionOutbox";

export function capturedDraftSubmissions(scope: string, ownerId: string, current?: ConversationDraftDto): DraftPendingSubmissionDto[] {
  const retired = new Set(current?.retiredPendingSubmissionIds?.map(item => item.idempotencyKey));
  const byId = new Map((current?.pendingSubmissions ?? []).filter(item => !retired.has(item.idempotencyKey)).map(item => [item.idempotencyKey, item]));
  for (const item of readCapturedSubmissions(scope, ownerId)) {
    if (retired.has(item.pending.idempotencyKey)) continue;
    const retained = byId.get(item.pending.idempotencyKey);
    // Preparation only enriches an identity. An old browser snapshot may lack
    // a title/hash already recorded by another tab; don't regress that state.
    const incoming = item.pending;
    byId.set(incoming.idempotencyKey, retained ? {
      ...retained, ...incoming,
      ...(retained.fingerprint !== "0".repeat(64) && incoming.fingerprint === "0".repeat(64) || retained.agentTitle && !incoming.agentTitle
        ? { fingerprint: retained.fingerprint, intentFingerprint: retained.intentFingerprint } : {}),
      uploads: [...new Map([...(retained.uploads ?? []), ...(incoming.uploads ?? [])].map(upload => [upload.scope, upload])).values()],
    } : incoming);
  }
  return [...byId.values()];
}

export function withCapturedDraftSubmissions(scope: string, input: PutConversationDraftRequest, current?: ConversationDraftDto): PutConversationDraftRequest {
  return { ...input, pendingSubmissions: capturedDraftSubmissions(scope, input.ownerId ?? "", current) };
}

/** Append/retire one captured identity with CAS, preserving the server's current
 * editable body and other tabs' attempts. A failed CAS is visible, never forced. */
export async function persistCapturedDraftSubmission(scope: string, ownerId: string, clientId: string, pending: DraftPendingSubmissionDto, retire = false, expectedRevision?: number): Promise<{ draft: ConversationDraftDto; mayAdvanceDraftRevision: boolean; retired?: boolean }> {
  const current = await api.getConversationDraft(scope, ownerId);
  if (current.retiredPendingSubmissionIds?.some(item => item.idempotencyKey === pending.idempotencyKey)) {
    if (!retire) {
      throw new Error("This captured operation has already been retired by the server. Its original input is preserved. Reconcile its earlier outcome before copying the text into a new draft.");
    }
    return { draft: current, mayAdvanceDraftRevision: false, retired: true };
  }
  const pendingSubmissions = capturedDraftSubmissions(scope, ownerId, current)
    .filter(item => item.idempotencyKey !== pending.idempotencyKey);
  if (!retire) pendingSubmissions.push(pending);
  const draft = await api.putConversationDraft(scope, {
    text: current.text,
    attachmentIds: current.attachmentIds,
    ...(current.pastedTextAttachmentId ? { pastedTextAttachmentId: current.pastedTextAttachmentId } : {}),
    mentionBindings: current.mentionBindings,
    ...(current.pendingSubmission ? { pendingSubmission: current.pendingSubmission } : {}),
    pendingSubmissions,
    ...(retire ? { retirePendingSubmissionIds: [pending.idempotencyKey] } : {}),
    expectedRevision: current.revision,
    clientId: current.clientId || clientId,
    ownerId,
  });
  // A successful editable save can intentionally ignore an expired capture.
  // Its original revision/bytes must remain recoverable; never restamp or send
  // an identity the canonical journal did not retain.
  if (!retire && !draft.pendingSubmissions?.some(item => item.idempotencyKey === pending.idempotencyKey)) {
    throw new Error("The server did not retain this captured operation. Its original input is preserved. Reconcile its earlier outcome before retrying or copying the text into a new draft.");
  }
  return { draft, mayAdvanceDraftRevision: current.revision === expectedRevision || current.clientId === clientId };
}
