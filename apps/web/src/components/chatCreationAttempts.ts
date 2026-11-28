import { AGENT_CREATION_DRAFT_ATTACHMENTS_EXPIRED, type ConversationDto, type CreateProjectRequest } from "@ponderosa/core";
import { chatCreationFiles } from "./chatCreationFiles";
import { conversationHeaderActions, isConversationDetailView, type ConversationDetailView, type ConversationHeaderAction } from "../routing";
import { api } from "../api";
import { requestJson } from "../api/real";
import { ApiRequestError } from "../api/types";
import { durableSubmissionFingerprint } from "./idempotentAttempt";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
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

export type ChatCreationContinuation =
  | { view: ConversationDetailView }
  | { initialAction: ConversationHeaderAction };

export interface ChatCreationAttempt {
  key: string;
  owner?: ChatCreationOwner;
  origin?: "import_destination";
  input: CreateProjectRequest;
  chat?: Pick<ConversationDto, "id" | "projectId">;
  continuation?: ChatCreationContinuation;
  draft?: {
    text?: string;
    rawText?: string;
    ownerId: string;
    files?: { key: string; count: number; ids?: string[] };
  };
  opening?: {
    text: string;
    title: string;
    idempotencyKey?: string;
    attachmentsExpired?: true;
    runtime?: Pick<CreateProjectRequest, "defaultEngine" | "defaultModel" | "defaultEffort" | "defaultSpeed">;
  };
}
/** A retry requires one unchanged, still-unconfirmed original request. */
export function mayRetryCreationAttempt(items:ChatCreationAttempt[],attempt:ChatCreationAttempt):boolean {
  const matches=items.filter(item=>sameCreationAttempt(item,attempt)),existing=matches[0];
  return matches.length===1&&Boolean(existing&&!existing.chat&&existing.origin===attempt.origin&&sameCreationInput(existing,attempt));
}
/** Existing completion evidence must agree before an import-origin receipt is saved. */
export function mayRecordCreationReceipt(items:ChatCreationAttempt[],attempt:ChatCreationAttempt,chat:Pick<ConversationDto,"id"|"projectId">):boolean {
  const matches=items.filter(item=>sameCreationAttempt(item,attempt)),existing=matches[0];
  return matches.length===1&&Boolean(existing&&existing.origin===attempt.origin&&sameCreationInput(existing,attempt)&&
    (!existing.chat||(existing.chat.id===chat.id&&existing.chat.projectId===chat.projectId)));
}
function sameCreationInput(a: ChatCreationAttempt, b: ChatCreationAttempt): boolean {
  return JSON.stringify(a.input) === JSON.stringify(b.input) &&
    JSON.stringify(a.opening) === JSON.stringify(b.opening) &&
    JSON.stringify(a.continuation) === JSON.stringify(b.continuation) &&
    JSON.stringify(a.draft) === JSON.stringify(b.draft);
}

export function withChatCreationReceipt(attempt: ChatCreationAttempt, chat: ConversationDto): ChatCreationAttempt {
  const { id, projectId, defaultEngine, defaultModel, defaultEffort, defaultSpeed } = chat;
  const opening = attempt.opening && {
    ...attempt.opening,
    runtime: attempt.opening.runtime ?? {
      defaultEngine: defaultEngine ?? attempt.input.defaultEngine, defaultModel, defaultEffort, defaultSpeed,
    },
  };
  return { ...attempt, chat: { id, projectId }, opening };
}

/** Replays the first message through the same Agent creation operation. */
export async function submitChatOpening(attempt: ChatCreationAttempt, chat: ConversationDto): Promise<void> {
  const opening = attempt.opening;
  if (!opening) return;
  const journal = readDurableChatAttempts();
  if (!mayRecordCreationReceipt(journal, attempt, chat)) {
    throw new Error("Saved opening message changed. The original request is retained.");
  }
  if (!opening.runtime) throw new Error("The opening message runtime could not be recovered.");
  const { defaultEngine, defaultModel, defaultEffort, defaultSpeed } = opening.runtime;
  attempt = await stageCreationFiles(attempt, chat);
  const idempotencyKey = attempt.opening?.idempotencyKey ?? `${attempt.key}:opening`;
  try {
    await api.createAgent(chat.projectId, chat.id, {
      title: opening.title,
      engine: defaultEngine,
      model: defaultModel,
      effort: defaultEffort,
      speed: defaultSpeed,
      initialMessage: opening.text,
      ...(attempt.draft?.files ? {
        draftAttachmentIds: attempt.draft.files.ids,
        draftOwnerId: attempt.draft.ownerId,
      } : {}),
      idempotencyKey,
    });
  } catch (error) {
    if (attempt.draft?.files?.ids && error instanceof ApiRequestError && error.status === 400 &&
        (error.body as { code?: string } | undefined)?.code === AGENT_CREATION_DRAFT_ATTACHMENTS_EXPIRED) {
      replaceCreationReceipt(attempt, {
        ...attempt, opening: { ...attempt.opening!, attachmentsExpired: true },
      }, chat);
    }
    throw error;
  }
  settleCreationDraft(attempt, chat);
}

async function stageCreationFiles(attempt: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): Promise<ChatCreationAttempt> {
  const draft = attempt.draft;
  const expired = attempt.opening?.attachmentsExpired;
  if (!draft?.files || (draft.files.ids && !expired)) return attempt;
  const files = await chatCreationFiles("read", draft.files.key);
  if (!files || files.length !== draft.files.count)
    throw new Error("The original attachments are unavailable. The opening message has been held.");
  const ids = [];
  for (const file of files) {
    ids.push((await api.uploadDraftAttachment(chat.id, draft.ownerId, file)).id);
  }
  const staged = { ...attempt, draft: { ...draft, files: { ...draft.files, ids } } };
  if (expired && attempt.opening) {
    staged.opening = {
      ...attempt.opening,
      attachmentsExpired: undefined,
      // Independent recoveries of the same rejected request must share one key.
      idempotencyKey: await durableSubmissionFingerprint(attempt.opening.idempotencyKey ?? `${attempt.key}:opening`),
    };
  }
  replaceCreationReceipt(attempt, staged, chat);
  return staged;
}

export async function keepChatOpeningAsDraft(attempt: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): Promise<void> {
  const draft = attempt.draft;
  if (!draft) return;
  const next = {
    ...attempt, opening: undefined,
    draft: {
      ...draft,
      text: draft.text ?? attempt.opening?.text,
      files: attempt.opening?.attachmentsExpired && draft.files ? { ...draft.files, ids: undefined } : draft.files,
    },
  };
  replaceCreationReceipt(attempt, next, chat);
  await moveCreationDraft(next, chat);
}

export async function moveCreationDraft(attempt: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): Promise<ChatCreationAttempt> {
  if (!attempt.draft) return attempt;
  attempt = await stageCreationFiles(attempt, chat);
  const draft = attempt.draft!;
  const text = draft.text ?? attempt.opening?.text ?? "";
  const attachmentIds = draft.files?.ids ?? [];
  if (text || attachmentIds.length) {
    const existing = await api.getConversationDraft(chat.id, draft.ownerId);
    const matches = existing.text === text && JSON.stringify(existing.attachmentIds) === JSON.stringify(attachmentIds);
    if (!matches) {
      if (existing.revision !== 0) throw new Error("The saved Chat already has a draft. The New Chat draft is retained.");
      try {
        await api.putConversationDraft(chat.id, {
          text,
          attachmentIds,
          ownerId: draft.ownerId,
          expectedRevision: 0,
          clientId: attempt.key,
        });
      } catch (error) {
        if (draft.files && error instanceof ApiRequestError && error.status === 400) {
          const unavailable = (error.body as { unavailableAttachmentIds?: unknown } | undefined)?.unavailableAttachmentIds;
          if (Array.isArray(unavailable) && unavailable.some(id => attachmentIds.includes(id))) {
            replaceCreationReceipt(attempt, {
              ...attempt, draft: { ...draft, files: { ...draft.files, ids: undefined } },
            }, chat);
          }
        }
        throw error;
      }
    }
  }
  return settleCreationDraft(attempt, chat);
}

function replaceCreationReceipt(attempt: ChatCreationAttempt, next: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): void {
  const journal = readDurableChatAttempts();
  if (!mayRecordCreationReceipt(journal, attempt, chat) ||
      !saveCreationAttempts(journal.map(item => sameCreationAttempt(item, attempt) ? next : item))) {
    throw new Error("The Chat receipt could not be saved. Retry the same request.");
  }
}

export function settleCreationDraft(attempt: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): ChatCreationAttempt {
  const next = { ...attempt, opening: undefined, draft: undefined };
  replaceCreationReceipt(attempt, next, chat);
  if (attempt.draft?.files) void chatCreationFiles("remove", attempt.draft.files.key).catch(() => {});
  const draftKey = chatStateKey("draft", `new-chat.${attempt.key}`);
  const source = attempt.draft?.rawText ?? attempt.draft?.text ?? attempt.opening?.text;
  if (source !== undefined && readChatState(draftKey)?.trim() === source.trim()) writeChatState(draftKey, "");
  return next;
}

export function settleCreationContinuation(attempt: ChatCreationAttempt, chat: Pick<ConversationDto, "id" | "projectId">): void {
  if (attempt.continuation) replaceCreationReceipt(attempt, { ...attempt, continuation: undefined }, chat);
}

export const chatCreationAttemptsKey = "ponderosa.new-chat-attempts.v2";

export function readCreationAttempts(): ChatCreationAttempt[] {
  try {
    const items: unknown = JSON.parse(readBrowserStorage("sessionStorage", chatCreationAttemptsKey) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is ChatCreationAttempt => item && typeof item.key === "string" &&
      (item.owner === undefined || (item.owner?.product === "branches" && typeof item.owner.branchId === "string" && item.owner.branchId.length > 0)) &&
      (item.origin === undefined || item.origin === "import_destination") &&
      (item.continuation === undefined || (!item.owner && !item.origin && !item.opening &&
        (isConversationDetailView(item.continuation?.view) || conversationHeaderActions.includes(item.continuation?.initialAction)))) &&
      (item.draft === undefined || (!item.owner && !item.origin &&
        item.draft && (item.draft.text === undefined || typeof item.draft.text === "string") &&
        (item.draft.rawText === undefined || typeof item.draft.rawText === "string") &&
        typeof item.draft?.ownerId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(item.draft.ownerId) &&
        (item.draft.files === undefined || (typeof item.draft.files?.key === "string" &&
          Number.isInteger(item.draft.files.count) && item.draft.files.count > 0 &&
          (item.draft.files.ids === undefined || (Array.isArray(item.draft.files.ids) &&
            item.draft.files.ids.length === item.draft.files.count && item.draft.files.ids.every((id: unknown) => typeof id === "string"))))))) &&
      (item.opening === undefined || (!item.owner && !item.origin &&
        typeof item.opening?.text === "string" && Boolean(item.opening.text || item.draft?.files) &&
        typeof item.opening?.title === "string" && Boolean(item.opening.title) &&
        (item.opening.idempotencyKey === undefined || (typeof item.opening.idempotencyKey === "string" && /^[a-f0-9]{64}$/u.test(item.opening.idempotencyKey))) &&
        (item.opening.attachmentsExpired === undefined || (item.opening.attachmentsExpired === true && item.draft?.files?.ids)) &&
        (item.opening.runtime === undefined || (typeof item.opening.runtime?.defaultEngine === "string" &&
          ["defaultModel", "defaultEffort", "defaultSpeed"].every(field =>
            item.opening.runtime[field] === undefined || typeof item.opening.runtime[field] === "string"))))) &&
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
      return existing.origin===attempt.origin&&sameCreationInput(existing,attempt)&&
        JSON.stringify(existing.chat??null)===JSON.stringify(attempt.chat??null);
    }
    return saveCreationAttempts([...journal,attempt]);
  }catch{return false;}
}
