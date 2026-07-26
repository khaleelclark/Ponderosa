import { createHmac, timingSafeEqual } from "node:crypto";

const RESULT_PAGE_MIN_BYTES = 4 * 1024;
const RESULT_PAGE_DEFAULT_BYTES = 64 * 1024;
const RESULT_PAGE_MAX_BYTES = 256 * 1024;

interface ResultCursorState {
  runId: string;
  refsHash: string;
  versionsHash: string;
  maxBytes: number;
  itemIndex: number;
  byteOffset: number;
}

interface ActivityOutputCursorState {
  v: 1;
  agentId: string;
  seq: number;
  sha256: string;
  byteOffset: number;
}

function encodeTimelineCursor(stream: string, scope: string, createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 2, stream, scope, createdAt, id }), "utf8").toString("base64url");
}

function decodeTimelineCursor(value: string, stream: string, scope: string): { createdAt: string; id: string } {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 2 || parsed.stream !== stream || parsed.scope !== scope ||
        typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid cursor scope");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("invalid history cursor");
  }
}

function encodeActivityOutputCursor(state: Omit<ActivityOutputCursorState, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...state } satisfies ActivityOutputCursorState), "utf8").toString("base64url");
}

function decodeActivityOutputCursor(value: string, agentId: string, seq: number): ActivityOutputCursorState {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<ActivityOutputCursorState>;
    if (parsed.v !== 1 || parsed.agentId !== agentId || parsed.seq !== seq ||
        typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.sha256) ||
        !Number.isSafeInteger(parsed.byteOffset) || parsed.byteOffset! < 0) {
      throw new Error("invalid cursor scope");
    }
    return parsed as ActivityOutputCursorState;
  } catch {
    throw new Error("invalid activity output cursor");
  }
}

function encodeResultCursor(state: ResultCursorState, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeResultCursor(value: string, secret: Buffer): ResultCursorState | undefined {
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) return undefined;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  let payloadBytes: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
    payloadBytes = Buffer.from(payload, "base64url");
  }
  catch { return undefined; }
  // Node accepts alternate Base64URL spellings whose unused trailing bits
  // decode to the same bytes. Cursors have one stable textual identity.
  if (supplied.toString("base64url") !== suppliedSignature || payloadBytes.toString("base64url") !== payload) return undefined;
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return undefined;
  try {
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as Partial<ResultCursorState>;
    if (typeof parsed.runId !== "string" || typeof parsed.refsHash !== "string" ||
        typeof parsed.versionsHash !== "string" || !Number.isSafeInteger(parsed.maxBytes) ||
        !Number.isSafeInteger(parsed.itemIndex) || !Number.isSafeInteger(parsed.byteOffset) ||
        (parsed.itemIndex ?? -1) < 0 || (parsed.byteOffset ?? -1) < 0) return undefined;
    return parsed as ResultCursorState;
  } catch {
    return undefined;
  }
}

function parseResultRef(ref: string): { kind: "activation" | "artifact"; id: string } | undefined {
  const match = /^ponderosa:\/\/(activation|artifact)\/([^/]+)$/.exec(ref);
  return match ? { kind: match[1] as "activation" | "artifact", id: match[2]! } : undefined;
}

export {
  RESULT_PAGE_MIN_BYTES,
  RESULT_PAGE_DEFAULT_BYTES,
  RESULT_PAGE_MAX_BYTES,
  encodeTimelineCursor,
  decodeTimelineCursor,
  encodeActivityOutputCursor,
  decodeActivityOutputCursor,
  encodeResultCursor,
  decodeResultCursor,
  parseResultRef,
};
