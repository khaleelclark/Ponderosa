import type { ConversationDto, CreateProjectRequest } from "@ponderosa/core";
import { api } from "../api";
import { requestJson } from "../api/real";
import { readBrowserStorage, writeBrowserStorage } from "../browserStorage.js";

export interface ChatCreationOwner { product: "branches"; branchId: string }
export const sameCreationOwner = (a?: ChatCreationOwner, b?: ChatCreationOwner): boolean => a === undefined || b === undefined ? a === b : Boolean(a?.product === "branches" && b?.product === "branches" && a.branchId && a.branchId === b.branchId);
export const sameCreationAttempt = (a: ChatCreationAttempt, b: ChatCreationAttempt): boolean => a.key === b.key && sameCreationOwner(a.owner, b.owner);
/** Generic New Chat actions must not silently resume an import destination. */
export const isOrdinaryPendingChatAttempt = (item:ChatCreationAttempt,owner?:ChatCreationOwner):boolean =>
  sameCreationOwner(item.owner,owner)&&!item.chat&&item.origin!=="import_destination";

/** The persisted owner chooses transport, including recovery after reload. */
export const submitCreationAttempt = (attempt: ChatCreationAttempt): Promise<ConversationDto> => attempt.owner
  ? requestJson(`/api/branches/${encodeURIComponent(attempt.owner.branchId)}/chats`, {method: "POST", headers: {"idempotency-key": attempt.key}, body: JSON.stringify(attempt.input)})
  : api.createChat(attempt.input, attempt.key);

export interface ChatCreationAttempt { key: string; owner?: ChatCreationOwner; origin?: "import_destination"; input: CreateProjectRequest; chat?: Pick<ConversationDto, "id" | "projectId"> }
/** A retry requires one unchanged, still-unconfirmed original request. */
export function mayRetryCreationAttempt(items:ChatCreationAttempt[],attempt:ChatCreationAttempt):boolean {
  const matches=items.filter(item=>sameCreationAttempt(item,attempt)),existing=matches[0];
  return matches.length===1&&Boolean(existing&&!existing.chat&&existing.origin===attempt.origin&&JSON.stringify(existing.input)===JSON.stringify(attempt.input));
}
/** Existing completion evidence must agree before an import-origin receipt is saved. */
export function mayRecordCreationReceipt(items:ChatCreationAttempt[],attempt:ChatCreationAttempt,chat:Pick<ConversationDto,"id"|"projectId">):boolean {
  const matches=items.filter(item=>sameCreationAttempt(item,attempt)),existing=matches[0];
  return matches.length===1&&Boolean(existing&&existing.origin===attempt.origin&&JSON.stringify(existing.input)===JSON.stringify(attempt.input)&&
    (!existing.chat||(existing.chat.id===chat.id&&existing.chat.projectId===chat.projectId)));
}
export const chatCreationAttemptsKey = "ponderosa.new-chat-attempts.v2";

export function readCreationAttempts(): ChatCreationAttempt[] {
  try {
    const items: unknown = JSON.parse(readBrowserStorage("sessionStorage", chatCreationAttemptsKey) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is ChatCreationAttempt => item && typeof item.key === "string" &&
      (item.owner === undefined || (item.owner?.product === "branches" && typeof item.owner.branchId === "string" && item.owner.branchId.length > 0)) &&
      (item.origin === undefined || item.origin === "import_destination") &&
      (item.chat === undefined || (typeof item.chat?.id === "string" && item.chat.id && typeof item.chat?.projectId === "string" && item.chat.projectId)) &&
      typeof item.input?.label === "string" && typeof item.input?.defaultEngine === "string" &&
      ["hostPath", "defaultModel", "defaultEffort", "defaultSpeed"].every(field => item.input[field] === undefined || typeof item.input[field] === "string"));
  } catch { return []; }
}

/** Import recovery must not overwrite unreadable or partially filtered evidence. */
export function readDurableChatAttempts():ChatCreationAttempt[]{
  const raw=window.sessionStorage.getItem(chatCreationAttemptsKey);
  let parsed:unknown;
  try{parsed=raw===null?[]:JSON.parse(raw);}catch{throw Error("Saved destination information is unavailable. Preserve browser data and recover the earlier request.");}
  const attempts=readCreationAttempts();
  if(!Array.isArray(parsed)||JSON.stringify(parsed)!==JSON.stringify(attempts))
    throw Error("Saved destination information is unavailable. Preserve browser data and recover the earlier request.");
  return attempts;
}

export function saveCreationAttempts(items: ChatCreationAttempt[]): boolean {
  return writeBrowserStorage("sessionStorage", chatCreationAttemptsKey, JSON.stringify(items));
}

/** Optional-storage memory fallback is recovery UI, never dispatch authority.
 * A durable original still permits exact replay if its later receipt write fails. */
export function ensureCreationAttemptPersisted(attempt: ChatCreationAttempt): boolean {
  try {
    const journal=readDurableChatAttempts(),matches=journal.filter(item=>sameCreationAttempt(item,attempt));
    if(matches.length>1)return false;
    if(matches.length===1){
      const existing=matches[0]!;
      return existing.origin===attempt.origin&&JSON.stringify(existing.input)===JSON.stringify(attempt.input)&&
        JSON.stringify(existing.chat??null)===JSON.stringify(attempt.chat??null);
    }
    return saveCreationAttempts([...journal,attempt]);
  }catch{return false;}
}
