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

export async function discardRecipientUploads<T>(
  recipients: RecipientUploads<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(recipients.flatMap(recipient =>
    recipient.attachments.map(item => cleanup(recipient.agentId, item))));
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
        await Promise.allSettled(attachments.map((item) => cleanup(agentId, item)));
        throw failed.reason;
      }
      completed.push(...attachments.map((item) => ({ agentId, item })));
      recipients.push({ agentId, attachments });
    }
    return recipients;
  } catch (error) {
    await Promise.allSettled(completed.map(({ agentId, item }) => cleanup(agentId, item)));
    throw error;
  }
}
