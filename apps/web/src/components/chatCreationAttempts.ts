import type { ConversationDto, CreateProjectRequest, EngineDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { readBrowserStorage, writeBrowserStorage } from "../browserStorage.js";
import { effortOptionsForModel, engineIsAvailable, resolveRuntimeSelection, runtimeControlState, type RuntimeSelection, type RuntimeControlState } from "../conversationEngine.js";

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

/** New creation requires advertised values; retained unknown-model settings
 * elsewhere are not an advertisement. Explicit invalid values never downgrade. */
export function creationRuntimeState(engine: EngineDto | undefined, preferences: WorkspacePreferencesDto, explicit: RuntimeSelection): RuntimeControlState {
  const resolved = resolveRuntimeSelection(engine, preferences, undefined, explicit);
  const selection = {
    model: explicit.model || resolved.model,
    effort: explicit.effort || resolved.effort,
    speed: explicit.speed || resolved.speed || "standard",
  };
  const state = runtimeControlState(engine, selection);
  const model = engine?.models.find(option => option.id && option.id === selection.model);
  const advertisedEfforts = effortOptionsForModel(engine, selection.model);
  const effortKnown = !selection.effort || advertisedEfforts.some(option => option.id === selection.effort);
  const speedKnown = selection.speed === "standard" || state.speeds.some(option => option.id === selection.speed);
  return {
    ...state,
    ...selection,
    efforts: advertisedEfforts,
    models: state.models.filter(option => engine?.models.some(model => model.id === option.id)),
    ready: engineIsAvailable(engine) && Boolean(model && model.availability !== "unavailable") && effortKnown && speedKnown,
  };
}
