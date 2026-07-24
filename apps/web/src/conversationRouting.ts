/** A leading #broadcast is a scope directive, not an agent tag. */
export function managerBroadcastText(text: string): string | undefined {
  if (!/^#broadcast(?=$|\s)/iu.test(text.trimStart())) return undefined;
  return text.trimStart().replace(/^#broadcast(?=$|\s)\s*/iu, "").trim();
}

/** Upload one safe copy per recipient and clean every staged copy on failure. */
export async function uploadFilesForRecipients<T extends { id: string }>(
  recipientIds: string[],
  files: File[],
  upload: (recipientId: string, file: File) => Promise<T>,
  cleanup: (recipientId: string, item: T) => Promise<unknown>,
): Promise<Array<{ agentId: string; attachments: T[] }>> {
  const completed: Array<{ agentId: string; item: T }> = [];
  try {
    const recipients = [] as Array<{ agentId: string; attachments: T[] }>;
    for (const agentId of recipientIds) {
      const settled = await Promise.allSettled(files.map((file) => upload(agentId, file)));
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
