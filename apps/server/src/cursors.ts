const RESULT_PAGE_MIN_BYTES = 4 * 1024;
const RESULT_PAGE_DEFAULT_BYTES = 64 * 1024;
const RESULT_PAGE_MAX_BYTES = 256 * 1024;

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

export {
  RESULT_PAGE_MIN_BYTES,
  RESULT_PAGE_DEFAULT_BYTES,
  RESULT_PAGE_MAX_BYTES,
  encodeTimelineCursor,
  decodeTimelineCursor,
  encodeActivityOutputCursor,
  decodeActivityOutputCursor,
};
