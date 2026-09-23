import {
  messageTagTokens,
  type AgentMentionBindingDto,
  type DraftPendingSubmissionDto,
} from "@ponderosa/core";

/** Remove the explicit #broadcast scope directive without matching longer tags. */
export function managerBroadcastText(text: string): string | undefined {
  if (!/(?:^|\s)#broadcast(?=$|\s|[.,!?;:])/iu.test(text)) return undefined;
  return text
    .replace(/(?:^|\s)#broadcast(?=$|\s|[.,!?;:])/giu, "")
    .trim();
}

export function newChatSubmission(text: string):
  | { kind: "broadcast"; text: string }
  | { kind: "agent"; text: string } {
  const broadcastText = managerBroadcastText(text);
  return broadcastText === undefined
    ? { kind: "agent", text }
    : { kind: "broadcast", text: broadcastText };
}

const RECIPIENT_UPLOAD_CONCURRENCY = 3;
const fileInstanceIds = new WeakMap<File, number>();
let nextFileInstanceId = 0;

export const fileSelectionFingerprint = (files: readonly File[]) =>
  files.map(file => {
    let instanceId = fileInstanceIds.get(file);
    if (instanceId === undefined) {
      instanceId = ++nextFileInstanceId;
      fileInstanceIds.set(file, instanceId);
    }
    return [file.name, file.type, file.size, file.lastModified, instanceId];
  });

export type RecipientUploads<T> = Array<{ agentId: string; attachments: T[] }>;

export const recipientUploadCleanupSettled = (
  status: number,
  message = "",
): boolean => status === 404 ||
  (status === 409 && message === "sent assets cannot be deleted");

export function pendingRecipientUploads(
  pending: DraftPendingSubmissionDto | undefined,
  scope: string,
): RecipientUploads<{ id: string }> | undefined {
  const prepared = pending?.uploads?.find(item => item.scope === scope);
  return prepared?.recipients.map(recipient => ({
    agentId: recipient.agentId,
    attachments: recipient.attachmentIds.map(id => ({ id })),
  }));
}

export function withPendingRecipientUploads<T extends { id: string }>(
  pending: DraftPendingSubmissionDto,
  scope: string,
  recipients: RecipientUploads<T>,
): DraftPendingSubmissionDto {
  return {
    ...pending,
    uploads: [
      ...(pending.uploads ?? []).filter(item => item.scope !== scope),
      {
        scope,
        recipients: recipients.map(recipient => ({
          agentId: recipient.agentId,
          attachmentIds: recipient.attachments.map(item => item.id),
        })),
      },
    ],
  };
}

export function withPendingRequest(
  pending: DraftPendingSubmissionDto,
  request: NonNullable<DraftPendingSubmissionDto["request"]>,
): DraftPendingSubmissionDto {
  return pending.request ? pending : { ...pending, request };
}

export function pendingDraftAttachmentIds(
  pending: DraftPendingSubmissionDto | undefined,
  editableIds: readonly string[],
): string[] {
  return pending?.editableDraftAttachmentIds &&
      JSON.stringify(pending.editableDraftAttachmentIds) === JSON.stringify(editableIds)
    ? [...(pending.draftAttachmentIds ?? editableIds)]
    : [...editableIds];
}

export function pendingPastedTextAttachmentId(
  pending: DraftPendingSubmissionDto | undefined,
  editableId: string | undefined,
): string | undefined {
  return pending && pending.editablePastedTextAttachmentId === editableId
    ? pending.pastedTextAttachmentId ?? editableId
    : editableId;
}

export function recipientActionSnapshot(
  agentIds: Iterable<string>,
  broadcastAttachmentOwnerAgentId?: string,
) {
  return {
    targetAgentIds: [...new Set(agentIds)].sort(),
    broadcastAttachmentOwnerAgentId,
  };
}

/** Make retry identity independent of mutable Agent display handles. */
export function stableMessageActionText(
  text: string,
  bindings: readonly AgentMentionBindingDto[],
): string {
  const ownersByHandle = new Map<string, Set<string>>();
  for (const binding of bindings) {
    for (const handle of [binding.handle, binding.currentHandle]) {
      const normalized = handle.toLocaleLowerCase();
      const owners = ownersByHandle.get(normalized) ?? new Set<string>();
      owners.add(binding.agentId);
      ownersByHandle.set(normalized, owners);
    }
  }
  let result = "";
  let offset = 0;
  for (const token of messageTagTokens(text)) {
    const owners = ownersByHandle.get(token.handle.toLocaleLowerCase());
    if (owners?.size !== 1) continue;
    result += text.slice(offset, token.start);
    result += `#agent:${[...owners][0]}`;
    offset = token.end;
  }
  return offset ? result + text.slice(offset) : text;
}

export const recipientUploadCacheKey = (
  scope: string,
  agentIds: readonly string[],
) => JSON.stringify([scope, agentIds]);

export const recipientUploadAuthorityStoragePrefix = (
  draftStorageKey: string,
): string => `${draftStorageKey}.recipient-upload-authority.`;

export const recipientUploadAuthorityStorageKey = (
  draftStorageKey: string,
  draftClientId: string,
  idempotencyKey: string,
): string => `${recipientUploadAuthorityStoragePrefix(draftStorageKey)}${encodeURIComponent(
  `${draftClientId}\u0000${idempotencyKey}`,
)}`;

const RECIPIENT_UPLOAD_AUTHORITY_VERSION = 1;
const RECIPIENT_UPLOAD_AUTHORITY_MAX_BYTES = 64 * 1_024;
const RECIPIENT_UPLOAD_AUTHORITY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const RECIPIENT_UPLOAD_AUTHORITY_MAX_RECORDS = 8;

export const recipientUploadAuthorityHasCapacity = (
  keys: readonly string[],
  candidate: string,
): boolean => keys.includes(candidate) ||
  keys.length < RECIPIENT_UPLOAD_AUTHORITY_MAX_RECORDS;

export interface RecipientUploadAuthorityOutbox {
  version: 1;
  draftId: string;
  draftStorageKey: string;
  projectId: string;
  ownerId: string;
  baseDraftClientId: string;
  writeClientId: string;
  expectedRevision: number;
  createdAt: number;
  pending: DraftPendingSubmissionDto;
}

export function createRecipientUploadAuthorityOutbox(input: Omit<
  RecipientUploadAuthorityOutbox,
  "version" | "createdAt"
>, now = Date.now()): RecipientUploadAuthorityOutbox {
  return {
    version: RECIPIENT_UPLOAD_AUTHORITY_VERSION,
    createdAt: now,
    ...input,
    pending: {
      fingerprint: input.pending.fingerprint,
      idempotencyKey: input.pending.idempotencyKey,
      ...(input.pending.agentCreationCommitted
        ? { agentCreationCommitted: true }
        : {}),
      uploads: input.pending.uploads,
    },
  };
}

export function serializeRecipientUploadAuthorityOutbox(
  value: RecipientUploadAuthorityOutbox,
): string | undefined {
  const serialized = JSON.stringify(value);
  return serialized.length <= RECIPIENT_UPLOAD_AUTHORITY_MAX_BYTES
    ? serialized
    : undefined;
}

export function parseRecipientUploadAuthorityOutbox(
  raw: string | undefined,
  scope: Pick<
    RecipientUploadAuthorityOutbox,
    "draftId" | "draftStorageKey" | "projectId" | "ownerId"
  >,
  now = Date.now(),
): RecipientUploadAuthorityOutbox | undefined {
  if (!raw || raw.length > RECIPIENT_UPLOAD_AUTHORITY_MAX_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as RecipientUploadAuthorityOutbox;
    const pending = value?.pending;
    if (value.version !== RECIPIENT_UPLOAD_AUTHORITY_VERSION ||
        value.draftId !== scope.draftId ||
        value.draftStorageKey !== scope.draftStorageKey ||
        value.projectId !== scope.projectId ||
        value.ownerId !== scope.ownerId ||
        typeof value.baseDraftClientId !== "string" ||
        !value.baseDraftClientId ||
        typeof value.writeClientId !== "string" ||
        !value.writeClientId ||
        !Number.isInteger(value.expectedRevision) || value.expectedRevision < 0 ||
        !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
        value.createdAt > now ||
        now - value.createdAt > RECIPIENT_UPLOAD_AUTHORITY_MAX_AGE_MS ||
        typeof pending?.fingerprint !== "string" || !pending.fingerprint ||
        typeof pending.idempotencyKey !== "string" || !pending.idempotencyKey ||
        !pending.uploads?.length ||
        pending.uploads.some(upload =>
          typeof upload.scope !== "string" ||
          !Array.isArray(upload.recipients) ||
          upload.recipients.some(recipient =>
            typeof recipient.agentId !== "string" ||
            !Array.isArray(recipient.attachmentIds) ||
            recipient.attachmentIds.some(id => typeof id !== "string")))) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export const recipientUploadAuthorityConfirmed = (
  durable: DraftPendingSubmissionDto | undefined,
  local: RecipientUploadAuthorityOutbox,
): boolean => Boolean(durable &&
  local.pending.idempotencyKey === durable.idempotencyKey &&
  local.pending.fingerprint === durable.fingerprint &&
  JSON.stringify(local.pending.uploads) === JSON.stringify(durable.uploads) &&
  (!local.pending.agentCreationCommitted || durable.agentCreationCommitted));

/** Reconcile a browser outbox written before a draft PUT with the last server
 * revision. It is safe to replay only against the same durable submission. */
export function reconcileRecipientUploadAuthority(
  durable: DraftPendingSubmissionDto | undefined,
  local: RecipientUploadAuthorityOutbox | undefined,
  draft: { clientId: string; revision: number },
): { pending: DraftPendingSubmissionDto | undefined; retainLocal: boolean } {
  const exactDraftIncarnation = local && (
    (draft.revision === local.expectedRevision &&
      draft.clientId === local.baseDraftClientId) ||
    (draft.revision === local.expectedRevision + 1 &&
      draft.clientId === local.writeClientId)
  );
  if (!local || !durable || !exactDraftIncarnation ||
      local.pending.idempotencyKey !== durable.idempotencyKey ||
      local.pending.fingerprint !== durable.fingerprint) {
    return { pending: durable, retainLocal: false };
  }
  if (recipientUploadAuthorityConfirmed(durable, local)) {
    return { pending: durable, retainLocal: false };
  }
  return {
    pending: {
      ...durable,
      ...local.pending,
      ...(durable.agentCreationCommitted || local.pending.agentCreationCommitted
        ? { agentCreationCommitted: true }
        : {}),
      uploads: local.pending.uploads,
    },
    retainLocal: true,
  };
}

export async function discardRecipientUploads<T>(
  recipients: RecipientUploads<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
  cleanupUnavailable?: (error: unknown) => boolean,
  onPendingChange?: (pending: number) => void,
  retryDelayMs = 5_000,
): Promise<void> {
  await retryRecipientUploadCleanup(
    recipients,
    async (recipientId, item) => {
      try {
        await cleanup(recipientId, item);
      } catch (error) {
        if (!cleanupUnavailable?.(error)) throw error;
      }
    },
    onPendingChange,
    retryDelayMs,
  );
}

export function recipientUploadsForAgentIds<T>(
  recipients: RecipientUploads<T>,
  agentIds: Iterable<string>,
): RecipientUploads<T> {
  const selected = new Set(agentIds);
  return recipients.filter(recipient => selected.has(recipient.agentId));
}

export async function failedRecipientUploadCleanup<T>(
  recipients: RecipientUploads<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
): Promise<RecipientUploads<T>> {
  return (await Promise.all(recipients.map(async recipient => {
    const settled = await Promise.allSettled(
      recipient.attachments.map(item => cleanup(recipient.agentId, item)),
    );
    const attachments = recipient.attachments.filter(
      (_, index) => settled[index]?.status === "rejected",
    );
    return attachments.length ? [{ ...recipient, attachments }] : [];
  }))).flat();
}

/** Retain exact cleanup authority after delivery commits, without retrying delivery. */
export async function retryRecipientUploadCleanup<T>(
  recipients: RecipientUploads<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
  onPendingChange?: (pending: number) => void,
  retryDelayMs = 5_000,
): Promise<void> {
  let pending = recipients;
  while (pending.length) {
    pending = await failedRecipientUploadCleanup(pending, cleanup);
    onPendingChange?.(
      pending.reduce((count, recipient) => count + recipient.attachments.length, 0),
    );
    if (pending.length) {
      await new Promise(resolve => globalThis.setTimeout(resolve, retryDelayMs));
    }
  }
}

export function recipientUploadCleanupReporter(
  change: (delta: 1 | -1) => void,
): (pending: number) => void {
  let reported = false;
  return pending => {
    if (pending && !reported) {
      reported = true;
      change(1);
    } else if (!pending && reported) {
      reported = false;
      change(-1);
    }
  };
}

/** Persist exact upload ownership before dispatch. Ambiguous failures keep the
 * value in the caller's durable-retry state; definitive failures clean every
 * prepared copy before allowing that state to be released. */
export async function persistRecipientUploadAuthority<T>(input: {
  pending: DraftPendingSubmissionDto;
  recipients: RecipientUploads<T>;
  persist(
    value: DraftPendingSubmissionDto,
    retainOnFailure?: boolean,
  ): Promise<void>;
  cleanup(recipientId: string, item: T): Promise<unknown>;
  definitiveFailure(error: unknown): boolean;
  cleanupUnavailable?(error: unknown): boolean;
  onPendingChange?(pending: number): void;
  retryDelayMs?: number;
}): Promise<void> {
  try {
    await input.persist(input.pending, true);
  } catch (error) {
    if (input.definitiveFailure(error)) {
      await discardRecipientUploads(
        input.recipients,
        input.cleanup,
        input.cleanupUnavailable,
        input.onPendingChange,
        input.retryDelayMs,
      );
    }
    throw error;
  }
}

/** A definitive pre-commit send rejection cannot be retried with this request
 * identity. Clean its exact prepared uploads before the Composer releases the
 * durable pending submission. */
export async function cleanupRecipientUploadsForDefinitiveFailure<T>(input: {
  error: unknown;
  recipients: RecipientUploads<T>;
  definitiveFailure(error: unknown): boolean;
  cleanup(recipientId: string, item: T): Promise<unknown>;
  cleanupUnavailable?(error: unknown): boolean;
  onPendingChange?(pending: number): void;
  retryDelayMs?: number;
}): Promise<boolean> {
  if (!input.definitiveFailure(input.error)) return false;
  await discardRecipientUploads(
    input.recipients,
    input.cleanup,
    input.cleanupUnavailable,
    input.onPendingChange,
    input.retryDelayMs,
  );
  return true;
}

async function settleWithConcurrency<T>(
  items: File[],
  task: (file: File) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(RECIPIENT_UPLOAD_CONCURRENCY, items.length) },
      () => worker(),
    ),
  );
  return results;
}

/** Upload one safe copy per recipient and clean every staged copy on failure. */
export async function uploadFilesForRecipients<T extends { id: string }>(
  recipientIds: string[],
  files: File[],
  upload: (recipientId: string, file: File) => Promise<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
  recipientUnavailable?: (error: unknown) => boolean,
  onCleanupPendingChange?: (pending: number) => void,
  cleanupRetryDelayMs = 5_000,
): Promise<RecipientUploads<T>> {
  const completed: Array<{ agentId: string; item: T }> = [];
  try {
    const recipients = [] as Array<{ agentId: string; attachments: T[] }>;
    for (const agentId of recipientIds) {
      const settled = await settleWithConcurrency(
        files,
        file => upload(agentId, file),
      );
      const attachments = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        await discardRecipientUploads(
          [{ agentId, attachments }],
          cleanup,
          recipientUnavailable,
          onCleanupPendingChange,
          cleanupRetryDelayMs,
        );
        if (recipientUnavailable?.(failed.reason)) {
          recipients.push({ agentId, attachments: [] });
          continue;
        }
        throw failed.reason;
      }
      completed.push(...attachments.map((item) => ({ agentId, item })));
      recipients.push({ agentId, attachments });
    }
    return recipients;
  } catch (error) {
    await discardRecipientUploads(
      completed.map(({ agentId, item }) => ({ agentId, attachments: [item] })),
      cleanup,
      recipientUnavailable,
      onCleanupPendingChange,
      cleanupRetryDelayMs,
    );
    throw error;
  }
}
