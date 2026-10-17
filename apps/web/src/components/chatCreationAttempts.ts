import type { ConversationDto, CreateProjectRequest } from "@ponderosa/core";
import { readBrowserStorage, writeBrowserStorage } from "../browserStorage.js";

export interface ChatCreationAttempt { key: string; input: CreateProjectRequest; chat?: Pick<ConversationDto, "id" | "projectId"> }
export const chatCreationAttemptsKey = "ponderosa.new-chat-attempts.v2";

export function readCreationAttempts(): ChatCreationAttempt[] {
  try {
    const items: unknown = JSON.parse(readBrowserStorage("sessionStorage", chatCreationAttemptsKey) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is ChatCreationAttempt => item && typeof item.key === "string" &&
      (item.chat === undefined || (typeof item.chat?.id === "string" && item.chat.id && typeof item.chat?.projectId === "string" && item.chat.projectId)) &&
      typeof item.input?.label === "string" && typeof item.input?.defaultEngine === "string" &&
      ["hostPath", "defaultModel", "defaultEffort", "defaultSpeed"].every(field => item.input[field] === undefined || typeof item.input[field] === "string"));
  } catch { return []; }
}

export function saveCreationAttempts(items: ChatCreationAttempt[]): boolean {
  return writeBrowserStorage("sessionStorage", chatCreationAttemptsKey, JSON.stringify(items));
}

/** Optional-storage memory fallback is recovery UI, never dispatch authority.
 * A durable original still permits exact replay if its later receipt write fails. */
export function ensureCreationAttemptPersisted(attempt: ChatCreationAttempt): boolean {
  try {
    const durable: unknown = JSON.parse(window.sessionStorage.getItem(chatCreationAttemptsKey) ?? "[]");
    if (Array.isArray(durable) && durable.some(item => item?.key === attempt.key &&
      JSON.stringify(item.input) === JSON.stringify(attempt.input))) return true;
  } catch { /* Try flushing the retained exact journal below. */ }
  const journal = readCreationAttempts();
  return saveCreationAttempts([...journal.filter(item => item.key !== attempt.key), attempt]);
}
