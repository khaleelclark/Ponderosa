export const NEW_AGENT_DESTINATION_HANDLE = "new-agent";

function escapedHandle(handle: string): string {
  return handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function composerDestinationMention(handle: string): string {
  return `#${handle} `;
}

export function hasComposerDestination(
  text: string,
  handle: string,
): boolean {
  return new RegExp(
    `(?:^|\\s)#${escapedHandle(handle)}(?=$|\\s|[.,!?;:])`,
    "iu",
  ).test(text);
}

export function prependComposerDestination(
  text: string,
  handle: string,
): string {
  if (hasComposerDestination(text, handle)) return text;
  return `${composerDestinationMention(handle)}${text.replace(/^\s+/u, "")}`;
}

export function selectExclusiveNewAgentDestination(
  text: string,
  start: number,
  end: number,
  existingHandles: readonly string[],
): string {
  let next = `${text.slice(0, start)}#${NEW_AGENT_DESTINATION_HANDLE} ${text.slice(end)}`;
  for (const handle of existingHandles) {
    const pattern = new RegExp(
      `(?:^|\\s)#${escapedHandle(handle)}(?=$|\\s|[.,!?;:])`,
      "iu",
    );
    while (pattern.test(next)) next = next.replace(pattern, "").trimStart();
  }
  return next;
}
