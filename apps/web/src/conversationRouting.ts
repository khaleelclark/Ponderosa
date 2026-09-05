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

export function recipientActionSnapshot(
  agentIds: Iterable<string>,
  broadcastAttachmentOwnerAgentId?: string,
) {
  return {
    targetAgentIds: [...new Set(agentIds)].sort(),
    broadcastAttachmentOwnerAgentId,
  };
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
