import type { ConversationDto, CreateProjectRequest } from "@ponderosa/core";
import { api } from "../api";
import { requestJson } from "../api/real";
import { readBrowserStorage, writeBrowserStorage } from "../browserStorage.js";

export interface ChatCreationOwner { product: "branches"; branchId: string }
export const sameCreationOwner = (a?: ChatCreationOwner, b?: ChatCreationOwner): boolean => a === undefined || b === undefined ? a === b : Boolean(a?.product === "branches" && b?.product === "branches" && a.branchId && a.branchId === b.branchId);
export const sameCreationAttempt = (a: ChatCreationAttempt, b: ChatCreationAttempt): boolean => a.key === b.key && sameCreationOwner(a.owner, b.owner);

/** The persisted owner chooses transport, including recovery after reload. */
export const submitCreationAttempt = (attempt: ChatCreationAttempt): Promise<ConversationDto> => attempt.owner
  ? requestJson(`/api/branches/${encodeURIComponent(attempt.owner.branchId)}/chats`, {method: "POST", headers: {"idempotency-key": attempt.key}, body: JSON.stringify(attempt.input)})
  : api.createChat(attempt.input, attempt.key);

export interface ChatCreationAttempt { key: string; owner?: ChatCreationOwner; input: CreateProjectRequest; chat?: Pick<ConversationDto, "id" | "projectId"> }
export const chatCreationAttemptsKey = "ponderosa.new-chat-attempts.v2";

export function readCreationAttempts(): ChatCreationAttempt[] {
  try {
    const items: unknown = JSON.parse(readBrowserStorage("sessionStorage", chatCreationAttemptsKey) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is ChatCreationAttempt => item && typeof item.key === "string" &&
      (item.owner === undefined || (item.owner?.product === "branches" && typeof item.owner.branchId === "string" && item.owner.branchId.length > 0)) &&
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
    if (Array.isArray(durable) && durable.some(item => item?.key === attempt.key && sameCreationOwner(item.owner, attempt.owner) &&
      JSON.stringify(item.input) === JSON.stringify(attempt.input))) return true;
  } catch { /* Try flushing the retained exact journal below. */ }
  const journal = readCreationAttempts();
  return saveCreationAttempts([...journal.filter(item => !sameCreationAttempt(item, attempt)), attempt]);
}
