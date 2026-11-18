import type { NativeTranscriptForkResult } from "@ponderosa/core";

interface ForkRpc { request(method: string, params: Record<string, unknown>): Promise<unknown> }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native history response");
  return value as Record<string, unknown>;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u0020\u007f]/u.test(value);
}

/** Caller owns the idle source and a durable mutation reservation. No model
 * input, file restore, history truncation, lease or capability adoption occurs. */
export async function forkCodexTranscript(
  rpc: ForkRpc,
  sourceSessionId: string,
  throughId: string,
  assertCurrent: () => void,
  destination: Record<string, unknown> = {},
): Promise<NativeTranscriptForkResult> {
  if (!identity(sourceSessionId) || !identity(throughId)) throw new Error("Exact source thread and completed turn required");
  assertCurrent();
  const source = record(record(await rpc.request("thread/read", { threadId: sourceSessionId })).thread);
  if (source.id !== sourceSessionId || !["idle", "notLoaded"].includes(String(record(source.status).type))) {
    throw new Error("Exact source thread is not idle");
  }
  // Native goals can autonomously continue after load/fork. Do not copy any
  // goal until a scheduler-bound continuation contract exists.
  const goal = record(await rpc.request("thread/goal/get", { threadId: sourceSessionId }));
  if (goal.goal !== null) throw new Error("Clear the native goal before transcript fork");
  let cursor: string | undefined;
  let matched = false;
  const seen = new Set<string>();
  do {
    if (seen.size >= 100) throw new Error("Native turn inventory exceeds bounded fork lookup");
    assertCurrent();
    const page = record(await rpc.request("thread/turns/list", {
      threadId: sourceSessionId, limit: 100, itemsView: "notLoaded", ...(cursor ? { cursor } : {}),
    }));
    if (!Array.isArray(page.data)) throw new Error("Native completed-turn inventory unavailable");
    for (const raw of page.data) {
      const turn = record(raw);
      if (turn.id !== throughId) continue;
      if (turn.status !== "completed") throw new Error("Fork boundary must be a completed native turn");
      matched = true;
    }
    if (matched || page.nextCursor === null) break;
    if (!identity(page.nextCursor) || seen.has(page.nextCursor)) throw new Error("Native turn pagination incomplete");
    cursor = page.nextCursor;
    seen.add(cursor);
  } while (true);
  if (!matched) throw new Error("Exact fork boundary does not belong to source thread");
  assertCurrent();
  const base = { sourceSessionId, throughId, contextAccepted: false as const,
    sourceWork: "unchanged" as const, replayAuthorized: false as const };
  // A transport failure after this point can have created a native fork. Never
  // retry it or treat absence of a response as proof of no mutation.
  let sessionId: string | undefined;
  try {
    const thread = record(record(await rpc.request("thread/fork", {
      ...destination, threadId: sourceSessionId, lastTurnId: throughId, excludeTurns: true, ephemeral: false,
    })).thread);
    if (identity(thread.id) && thread.id !== sourceSessionId) sessionId = thread.id;
    if (!sessionId || thread.forkedFromId !== sourceSessionId || thread.ephemeral !== false) {
      return { ...base, ...(sessionId ? { sessionId } : {}), outcome: "outcome_unknown" };
    }
    assertCurrent();
    return { ...base, sessionId, outcome: "completed" };
  } catch {
    return { ...base, ...(sessionId ? { sessionId } : {}), outcome: "outcome_unknown" };
  }
}
