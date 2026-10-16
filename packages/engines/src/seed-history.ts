import type { ChatMessage } from "@ponderosa/core";
import { renderSeedHistoryMessage } from "@ponderosa/core/seed-history";

/** Render canonical Ponderosa history for the first turn of any fresh engine session. */
export function renderSeedPrompt(history: ChatMessage[], prompt: string): string {
  const prior = history.filter((message) => message.text.trim() !== "" || message.attachments?.length);
  if (prior.length === 0) return prompt;
  const transcript = prior.map(renderSeedHistoryMessage).join("\n");
  return `Conversation so far:\n${transcript}\n\nCurrent request:\n${prompt}`;
}
