export type ConversationSendRoute =
  | { kind: "direct-reply"; agentIds: [string] }
  | { kind: "mentioned-reply"; agentIds: string[] }
  | { kind: "spawn" };

/** A leading #broadcast is a scope directive, not an agent tag. */
export function managerBroadcastText(text: string): string | undefined {
  if (!/^#broadcast(?=$|\s)/iu.test(text.trimStart())) return undefined;
  return text.trimStart().replace(/^#broadcast(?=$|\s)\s*/iu, "").trim();
}

/** Direct-reply state takes precedence over message text and can never spawn. */
export function resolveConversationSendRoute(
  directReplyTargetId: string | undefined,
  mentionedAgentIds: string[],
): ConversationSendRoute {
  if (directReplyTargetId) return { kind: "direct-reply", agentIds: [directReplyTargetId] };
  if (mentionedAgentIds.length > 0) return { kind: "mentioned-reply", agentIds: mentionedAgentIds };
  return { kind: "spawn" };
}

export async function uploadDirectReplyFiles<T extends { id: string }>(
  files: File[],
  upload: (file: File) => Promise<T>,
  cleanup: (item: T) => Promise<unknown>,
): Promise<T[]> {
  const settled = await Promise.allSettled(files.map(upload));
  const uploaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) {
    await Promise.allSettled(uploaded.map(cleanup));
    throw failed.reason;
  }
  return uploaded;
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
      const attachments = await uploadDirectReplyFiles(
        files,
        (file) => upload(agentId, file),
        (item) => cleanup(agentId, item),
      );
      completed.push(...attachments.map((item) => ({ agentId, item })));
      recipients.push({ agentId, attachments });
    }
    return recipients;
  } catch (error) {
    await Promise.allSettled(completed.map(({ agentId, item }) => cleanup(agentId, item)));
    throw error;
  }
}
