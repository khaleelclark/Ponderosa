const FORBIDDEN_AGENT_IDENTITY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function normalizeAgentTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new Error("Agent title is required");
  if (FORBIDDEN_AGENT_IDENTITY_CHARACTERS.test(title)) {
    throw new Error("Agent title cannot contain control characters or line breaks");
  }
  return title;
}
