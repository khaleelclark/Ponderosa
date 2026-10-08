import { INLINE_TEXT_MAX_CODE_POINTS, unicodeCodePointLength, type CreateMultiAgentDirectMessageRequest } from "@ponderosa/core";
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "../../browserStorage.js";
import { durableSubmissionFingerprint } from "../idempotentAttempt.js";

export const VOICE_ATTEMPT_TTL = 24 * 60 * 60 * 1000;
export interface VoiceRoute { origin: string; product: string; projectId: string; conversationId: string; agentId: string }
export interface VoiceCallMarker {
  version: 2; route: VoiceRoute; instanceId: string | null; createdAt: number;
  fingerprint: string; idempotencyKey: string;
}
/** The payload belongs only to the still-mounted call, never browserStorage. */
export interface VoiceCallAttempt { marker: VoiceCallMarker; request: CreateMultiAgentDirectMessageRequest }
const key = (route: VoiceRoute) => `ponderosa.voice.pending.v1:${JSON.stringify(route)}`;
const reviewNotice = "This unconfirmed turn requires Chat review. Reopened or reloaded calls cannot retry or reconstruct its private words.";
const reviewOnly = (route: VoiceRoute) => JSON.stringify({ version: 2, route, reviewRequired: true });
const sameRoute = (left: VoiceRoute, right: VoiceRoute) => JSON.stringify(left) === JSON.stringify(right);
/** Server-authored workspace_status source; a stored cursor is NOT fresh connection proof. */
export function voiceServerInstanceHint(): string | null {
  try {
    const value = window.sessionStorage.getItem("ponderosa.workspace.instance.v1");
    return value && value.length <= 256 ? value : null;
  } catch { return null; }
}
export async function prepareVoiceCallAttempt(route: VoiceRoute, text: string, createId: () => string, now = Date.now()): Promise<VoiceCallAttempt> {
  if (!text.trim() || unicodeCodePointLength(text) > INLINE_TEXT_MAX_CODE_POINTS) throw new Error("Use Chat for turns longer than 10,000 characters.");
  const request: CreateMultiAgentDirectMessageRequest = { text, idempotencyKey: createId(), recipients: [{ agentId: route.agentId }], activeRunDelivery: "queue" };
  Object.freeze(request.recipients![0]); Object.freeze(request.recipients); Object.freeze(request);
  const marker: VoiceCallMarker = Object.freeze({ version: 2, route: Object.freeze({ ...route }), instanceId: voiceServerInstanceHint(), createdAt: now, fingerprint: await durableSubmissionFingerprint(request), idempotencyKey: request.idempotencyKey! });
  return Object.freeze({ marker, request });
}
export function retainVoiceCallAttempt(attempt: VoiceCallAttempt): boolean {
  const serialized = JSON.stringify(attempt.marker);
  const existing = readBrowserStorage("sessionStorage", key(attempt.marker.route));
  if (existing && existing !== serialized) throw new Error("An unresolved turn already exists. Review Chat.");
  return writeBrowserStorage("sessionStorage", key(attempt.marker.route), serialized);
}
const validIdentity = (record: VoiceCallMarker, route: VoiceRoute, now: number) => sameRoute(record.route, route) &&
  Number.isFinite(record.createdAt) && record.createdAt <= now &&
  (record.instanceId === null || (typeof record.instanceId === "string" && Boolean(record.instanceId) && record.instanceId.length <= 256)) &&
  typeof record.idempotencyKey === "string" && Boolean(record.idempotencyKey) && record.idempotencyKey.length <= 200 &&
  typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.fingerprint);
/** Recheck the immutable body and route before any deliberate mounted retry. */
export async function voiceCallAttemptCanRetry(attempt: VoiceCallAttempt, route: VoiceRoute, now = Date.now()): Promise<boolean> {
  const { marker, request } = attempt;
  return validIdentity(marker, route, now) && now - marker.createdAt < VOICE_ATTEMPT_TTL &&
    request.idempotencyKey === marker.idempotencyKey &&
    request.activeRunDelivery === "queue" && JSON.stringify(request.recipients) === JSON.stringify([{ agentId: route.agentId }]) &&
    marker.fingerprint === await durableSubmissionFingerprint(request) &&
    marker.instanceId === voiceServerInstanceHint() && readBrowserStorage("sessionStorage", key(route)) === JSON.stringify(marker);
}
/** Only this exact route slot is inspected. Legacy payloads are never returned. */
export async function restoreVoiceCallAttempt(route: VoiceRoute, now = Date.now()): Promise<{ marker?: VoiceCallMarker; notice?: string }> {
  const slot = key(route);
  const raw = readBrowserStorage("sessionStorage", slot);
  if (!raw) return {};
  try {
    // Bounded defensive upgrade; no storage enumeration or cross-route scan.
    if (raw.length > 128_000) throw new Error("Oversized record");
    const record = JSON.parse(raw);
    if (record.version === 2 && sameRoute(record.route, route) && record.reviewRequired === true &&
      Object.keys(record).every(field => ["version", "route", "reviewRequired"].includes(field))) return { notice: reviewNotice };
    let marker: VoiceCallMarker;
    if (record.version === 1) {
      // Remove raw private bytes before asynchronous legacy validation. A small
      // review-only marker prevents replacement even if validation is interrupted.
      removeBrowserStorage("sessionStorage", slot);
      writeBrowserStorage("sessionStorage", slot, reviewOnly(route));
      const request = record.request as CreateMultiAgentDirectMessageRequest;
      marker = { version: 2, route, instanceId: record.instanceId, createdAt: record.createdAt, fingerprint: record.fingerprint, idempotencyKey: request?.idempotencyKey ?? "" };
      if (Object.keys(record).some(field => !["version", "route", "instanceId", "createdAt", "fingerprint", "request"].includes(field)) ||
        !sameRoute(record.route, route) || !validIdentity(marker, route, now) ||
        typeof request?.text !== "string" || !request.text.trim() || unicodeCodePointLength(request.text) > INLINE_TEXT_MAX_CODE_POINTS ||
        request.activeRunDelivery !== "queue" || JSON.stringify(request.recipients) !== JSON.stringify([{ agentId: route.agentId }]) ||
        Object.keys(request).some(field => !["text", "idempotencyKey", "recipients", "activeRunDelivery"].includes(field)) ||
        marker.fingerprint !== await durableSubmissionFingerprint(request)) throw new Error("Invalid legacy record");
      // Do not overwrite a newer identity or resurrect an already-settled slot.
      if (readBrowserStorage("sessionStorage", slot) === reviewOnly(route)) writeBrowserStorage("sessionStorage", slot, JSON.stringify(marker));
    } else {
      marker = record;
      if (marker.version !== 2 || Object.keys(marker).some(field => !["version", "route", "instanceId", "createdAt", "fingerprint", "idempotencyKey"].includes(field)) || !validIdentity(marker, route, now)) throw new Error("Invalid marker");
    }
    // Expiry limits mounted retries, not marker deletion: unknown outcomes must
    // still block silent replacement when inspected repeatedly after 24 hours.
    return { marker, notice: now - marker.createdAt >= VOICE_ATTEMPT_TTL
      ? "An unconfirmed turn expired after 24 hours. Review Chat before sending another turn. Only its identity marker remains."
      : reviewNotice };
  } catch {
    // Corrupt/stale private records become text-free review warnings. Never
    // dispose the warning and thereby authorize a replacement send on reopen.
    if (readBrowserStorage("sessionStorage", slot) === raw || readBrowserStorage("sessionStorage", slot) === reviewOnly(route)) {
      removeBrowserStorage("sessionStorage", slot); writeBrowserStorage("sessionStorage", slot, reviewOnly(route));
    }
    return { notice: "An invalid pending turn requires Chat review. Voice sending is blocked." };
  }
}
/** Late acknowledgements settle their exact marker even after the call closes. */
export function settleVoiceCallAttempt(marker: VoiceCallMarker): void {
  const slot = key(marker.route);
  if (readBrowserStorage("sessionStorage", slot) === JSON.stringify(marker)) removeBrowserStorage("sessionStorage", slot);
}
