export const ALL_CHAT_REPLY_TARGET_KEY = "messages:composer:reply-target";

export type AllChatReplyTarget = {
  id: string;
  title: string;
  handle: string;
  projectId: string;
  conversationId?: string;
};

export function parseAllChatReplyTarget(
  raw: string | undefined,
): AllChatReplyTarget | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AllChatReplyTarget>;
    if (
      typeof value.id !== "string" || !value.id ||
      typeof value.title !== "string" || !value.title ||
      typeof value.handle !== "string" || !value.handle ||
      typeof value.projectId !== "string" || !value.projectId ||
      (value.conversationId !== undefined &&
        (typeof value.conversationId !== "string" || !value.conversationId))
    ) return undefined;
    return value as AllChatReplyTarget;
  } catch {
    return undefined;
  }
}

export function eligibleAllChatTargets(
  targets: Iterable<AllChatReplyTarget>,
  conversationId?: string,
): AllChatReplyTarget[] {
  return [...targets].filter(
    target => !conversationId || target.conversationId === conversationId,
  );
}
