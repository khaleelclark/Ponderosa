import type { ChatMessage } from "@ponderosa/core";

/** Render canonical Ponderosa history for the first turn of any fresh engine session. */
export function renderSeedPrompt(history: ChatMessage[], prompt: string): string {
  const prior = history.filter((message) => message.text.trim() !== "" || message.attachments?.length);
  if (prior.length === 0) return prompt;
  const transcript = prior.map((message) => {
    const attachments = message.attachments?.map((item) => {
      const stable = item.artifactId
        ? `artifactId=${item.artifactId}; retrieval=${item.retrievalUrl ?? "unavailable"}`
        : item.available && item.localPath ? item.localPath : "unavailable";
      return `\n  [artifact: ${item.name}; ${item.mediaType}; ${item.size} bytes; ${stable}]`;
    }).join("") ?? "";
    return `${message.role === "user" ? "User" : "Assistant"}: ${message.text}${attachments}`;
  }).join("\n");
  return `Conversation so far:\n${transcript}\n\nCurrent request:\n${prompt}`;
}
