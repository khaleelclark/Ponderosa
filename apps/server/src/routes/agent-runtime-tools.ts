import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentStore, CoordinationV3Store, RuntimeArtifactV3 } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import { PONDEROSA_RESULT_TOOL, unicodeCodePointLength } from "@ponderosa/core";
import type { AssetStore } from "../assets.js";
import {
  BrowserSessionError,
  type BrowserSessionManager,
  type BrowserScope,
} from "../browser-session-manager.js";
import type {
  ActiveRun,
  AgentMessageCapability,
} from "../app-contracts.js";
import {
  RESULT_PAGE_DEFAULT_BYTES,
  RESULT_PAGE_MAX_BYTES,
  RESULT_PAGE_MIN_BYTES,
  decodeResultCursor,
  encodeResultCursor,
  parseResultRef,
} from "../cursors.js";
import { collectReachableArtifactIds } from "../artifact-refs.js";
import { utf8PageEnd } from "../static-content.js";

interface AgentRuntimeToolRoutesContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  resultCursorSecret: Buffer;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  projectBrowserGrants: Map<string, { agentId: string; runId: string }>;
  projectBrowserScope(projectId: string, grant?: { agentId: string; runId: string }): BrowserScope;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
  agentCanReadRuntimeArtifact(artifact: RuntimeArtifactV3, agentId: string): boolean;
}

const RESULT_QUERY_MAX_MATCHES = 20;
const RESULT_QUERY_CONTEXT_BEFORE_CODE_UNITS = 240;
const RESULT_QUERY_CONTEXT_AFTER_CODE_UNITS = 480;

const literalQueryRegex = (query: string): RegExp => new RegExp(
  query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  "giu",
);

const codePointAlignedStart = (text: string, index: number): number =>
  index > 0 && index < text.length && /[\uDC00-\uDFFF]/u.test(text[index]!) ? index - 1 : index;

const codePointAlignedEnd = (text: string, index: number): number =>
  index > 0 && index < text.length && /[\uDC00-\uDFFF]/u.test(text[index]!) ? index + 1 : index;

interface ResultRetrievalSource {
  ref: string;
  title: string;
  mediaType: string;
  content: Buffer;
  encoding: "utf8" | "base64";
}

function nextLiteralQueryMatch(
  sources: readonly ResultRetrievalSource[],
  query: string,
  from: { itemIndex: number; byteOffset: number },
): {
  itemIndex: number;
  startUtf8Byte: number;
  endUtf8Byte: number;
  startCodeUnit: number;
  endCodeUnit: number;
  matchedText: string;
  fullText: string;
} | undefined {
  for (let itemIndex = from.itemIndex; itemIndex < sources.length; itemIndex += 1) {
    const source = sources[itemIndex]!;
    if (source.encoding !== "utf8") continue;
    const byteOffset = itemIndex === from.itemIndex ? from.byteOffset : 0;
    const prefixText = source.content.subarray(0, byteOffset).toString("utf8");
    const suffixText = source.content.subarray(byteOffset).toString("utf8");
    const match = literalQueryRegex(query).exec(suffixText);
    if (!match || match.index === undefined) continue;
    const prefixUtf8Bytes = Buffer.byteLength(suffixText.slice(0, match.index), "utf8");
    const startUtf8Byte = byteOffset + prefixUtf8Bytes;
    const endUtf8Byte = startUtf8Byte + Buffer.byteLength(match[0], "utf8");
    const startCodeUnit = prefixText.length + match.index;
    return {
      itemIndex,
      startUtf8Byte,
      endUtf8Byte,
      startCodeUnit,
      endCodeUnit: startCodeUnit + match[0].length,
      matchedText: match[0],
      fullText: `${prefixText}${suffixText}`,
    };
  }
  return undefined;
}

export function registerAgentRuntimeToolRoutes(
  app: FastifyInstance,
  context: AgentRuntimeToolRoutesContext,
): void {
  const {
    store,
    coordinationV3,
    assets,
    resultCursorSecret,
    agentMessageCapabilities,
    activeRuns,
    browserSessions,
    projectBrowserSessions,
    projectBrowserGrants,
    projectBrowserScope,
    capabilityOwnsAuthoritativeRun,
    agentCanReadRuntimeArtifact,
  } = context;

  app.post<{
    Body: { refs?: string[]; cursor?: string; maxBytes?: number; query?: string };
  }>("/api/agent-results", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const author = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !author || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "result capability is not authorized for an active Run" });
    }
    if (!capability.availableToolNames.includes(PONDEROSA_RESULT_TOOL.name)) {
      return reply.code(403).send({ error: "result retrieval is unavailable for this Run" });
    }
    const body = request.body ?? {};
    if (Object.keys(body).some((key) => !["refs", "cursor", "maxBytes", "query"].includes(key))) {
      return reply.code(400).send({ error: "result retrieval accepts only refs, cursor, maxBytes, and query" });
    }
    if (!Array.isArray(body.refs) || body.refs.length === 0 || body.refs.length > 20 ||
        new Set(body.refs).size !== body.refs.length || body.refs.some((ref) => typeof ref !== "string" || !parseResultRef(ref))) {
      return reply.code(400).send({ error: "refs must contain 1 to 20 unique ponderosa://activation/<id> or ponderosa://artifact/<id> references" });
    }
    if (body.cursor !== undefined && (typeof body.cursor !== "string" || !body.cursor || body.cursor.length > 4096)) {
      return reply.code(400).send({ error: "cursor must be a non-empty opaque string of at most 4096 characters" });
    }
    if (body.query !== undefined && (typeof body.query !== "string" || !body.query.trim() || unicodeCodePointLength(body.query) > 256)) {
      return reply.code(400).send({ error: "query must be a non-empty string of at most 256 Unicode code points" });
    }
    const decodedCursor = body.cursor ? decodeResultCursor(body.cursor, resultCursorSecret) : undefined;
    if (body.cursor && !decodedCursor) return reply.code(400).send({ error: "result cursor is invalid or has been tampered with" });
    const maxBytes = body.maxBytes ?? decodedCursor?.maxBytes ?? RESULT_PAGE_DEFAULT_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < RESULT_PAGE_MIN_BYTES || maxBytes > RESULT_PAGE_MAX_BYTES) {
      return reply.code(400).send({ error: `maxBytes must be an integer from ${RESULT_PAGE_MIN_BYTES} through ${RESULT_PAGE_MAX_BYTES}` });
    }

    const parsedRefs = body.refs.map((ref) => ({ ref, parsed: parseResultRef(ref)! }));
    const activationIds = parsedRefs.flatMap(({ parsed }) => parsed.kind === "activation" ? [parsed.id] : []);
    const activations = coordinationV3.activationPayloads(author.id, activationIds, capability.runId);
    if (activations.length !== activationIds.length) {
      return reply.code(404).send({ error: "one or more activation references are not reachable from this Run" });
    }
    const activationById = new Map(activations.map((activation) => [activation.id, activation]));
    const reachableArtifactIds = new Set(capability.reachableArtifactIds);
    const attachedActivationIds = coordinationV3.activationIdsAttachedToRun(capability.runId, author.id);
    for (const activation of coordinationV3.activationPayloads(author.id, attachedActivationIds, capability.runId)) {
      collectReachableArtifactIds(activation.payload, reachableArtifactIds);
    }

    const sources: ResultRetrievalSource[] = [];
    for (const { ref, parsed } of parsedRefs) {
      if (parsed.kind === "activation") {
        const activation = activationById.get(parsed.id)!;
        const content = Buffer.from(JSON.stringify({
          id: activation.id,
          kind: activation.kind,
          promptClass: activation.promptClass,
          payload: activation.payload,
        }, null, 2));
        sources.push({ ref, title: `Activation ${activation.id}`, mediaType: "application/json", content, encoding: "utf8" });
        continue;
      }
      if (!reachableArtifactIds.has(parsed.id)) {
        return reply.code(404).send({ error: `artifact reference is not reachable from this Run: ${ref}` });
      }
      const artifact = store.getProjectArtifact(author.projectId, parsed.id);
      const runtimeArtifact = coordinationV3.runtimeArtifact(parsed.id);
      if (!artifact && runtimeArtifact?.projectId !== author.projectId) {
        return reply.code(404).send({ error: `artifact is unavailable: ${ref}` });
      }
      if ((artifact && !store.agentCanReadProjectArtifact(author.projectId, parsed.id, author.id)) ||
          (runtimeArtifact && !agentCanReadRuntimeArtifact(runtimeArtifact, author.id))) {
        return reply.code(404).send({ error: `artifact reference is not reachable from this Run: ${ref}` });
      }
      let content: Buffer;
      if (runtimeArtifact?.projectId === author.projectId) {
        const authoritative = assets.authoritativeRuntimeArtifact(author.projectId, runtimeArtifact);
        if (!authoritative) {
          return reply.code(404).send({ error: `artifact content is unavailable: ${ref}` });
        }
        content = authoritative.body;
      } else {
        const managed = artifact
          ? assets.authoritativeManagedProjectArtifact(author.projectId, artifact)
          : undefined;
        if (!managed) return reply.code(404).send({ error: `artifact content is unavailable: ${ref}` });
        content = managed.body;
      }
      sources.push({
        ref,
        title: runtimeArtifact?.title ?? artifact!.summary ?? path.basename(artifact!.path),
        mediaType: runtimeArtifact?.mediaType ?? artifact!.mediaType ?? "application/octet-stream",
        content,
        encoding: isUtf8(content) ? "utf8" : "base64",
      });
    }

    const refsHash = createHash("sha256").update(JSON.stringify({
      refs: body.refs,
      query: body.query ?? null,
    })).digest("hex");
    const versionsHash = createHash("sha256").update(JSON.stringify(sources.map((source) => ({
      ref: source.ref,
      hash: createHash("sha256").update(source.content).digest("hex"),
    })))).digest("hex");
    if (decodedCursor && (decodedCursor.runId !== capability.runId || decodedCursor.refsHash !== refsHash ||
        decodedCursor.versionsHash !== versionsHash || decodedCursor.maxBytes !== maxBytes)) {
      return reply.code(409).send({ error: "result cursor no longer matches this Run, reference order, content version, or byte budget" });
    }
    let itemIndex = decodedCursor?.itemIndex ?? 0;
    let byteOffset = decodedCursor?.byteOffset ?? 0;
    if (itemIndex > sources.length || (itemIndex < sources.length && byteOffset > sources[itemIndex]!.content.length)) {
      return reply.code(409).send({ error: "result cursor is outside the durable result boundary" });
    }
    if (body.query !== undefined) {
      if (itemIndex < sources.length && byteOffset < sources[itemIndex]!.content.length &&
          (sources[itemIndex]!.content[byteOffset]! & 0xc0) === 0x80) {
        return reply.code(409).send({ error: "result cursor is not on a UTF-8 boundary" });
      }
      let remaining = maxBytes;
      let position = { itemIndex, byteOffset };
      const matches: Array<{
        ref: string;
        title: string;
        mediaType: string;
        match: string;
        matchRange: { startUtf8Byte: number; endUtf8Byte: number };
        excerptRange: { startUtf8Byte: number; endUtf8Byte: number };
        excerpt: string;
      }> = [];
      let nextPosition: { itemIndex: number; byteOffset: number } | undefined;
      while (matches.length < RESULT_QUERY_MAX_MATCHES && remaining > 0) {
        const found = nextLiteralQueryMatch(sources, body.query, position);
        if (!found) break;
        const source = sources[found.itemIndex]!;
        const excerptStartCodeUnit = codePointAlignedStart(
          found.fullText,
          Math.max(0, found.startCodeUnit - RESULT_QUERY_CONTEXT_BEFORE_CODE_UNITS),
        );
        const excerptEndCodeUnit = codePointAlignedEnd(
          found.fullText,
          Math.min(found.fullText.length, found.endCodeUnit + RESULT_QUERY_CONTEXT_AFTER_CODE_UNITS),
        );
        const excerpt = found.fullText.slice(excerptStartCodeUnit, excerptEndCodeUnit);
        const excerptUtf8Bytes = Buffer.byteLength(excerpt, "utf8");
        if (excerptUtf8Bytes > remaining && matches.length > 0) {
          nextPosition = { itemIndex: found.itemIndex, byteOffset: found.startUtf8Byte };
          break;
        }
        const excerptStartUtf8Byte = Buffer.byteLength(
          found.fullText.slice(0, excerptStartCodeUnit),
          "utf8",
        );
        matches.push({
          ref: source.ref,
          title: source.title,
          mediaType: source.mediaType,
          match: found.matchedText,
          matchRange: {
            startUtf8Byte: found.startUtf8Byte,
            endUtf8Byte: found.endUtf8Byte,
          },
          excerptRange: {
            startUtf8Byte: excerptStartUtf8Byte,
            endUtf8Byte: excerptStartUtf8Byte + excerptUtf8Bytes,
          },
          excerpt,
        });
        remaining -= excerptUtf8Bytes;
        position = { itemIndex: found.itemIndex, byteOffset: found.endUtf8Byte };
      }
      if (!nextPosition) {
        const next = nextLiteralQueryMatch(sources, body.query, position);
        if (next) nextPosition = { itemIndex: next.itemIndex, byteOffset: next.startUtf8Byte };
      }
      const nextCursor = nextPosition
        ? encodeResultCursor({
            runId: capability.runId,
            refsHash,
            versionsHash,
            maxBytes,
            itemIndex: nextPosition.itemIndex,
            byteOffset: nextPosition.byteOffset,
          }, resultCursorSecret)
        : undefined;
      return {
        query: body.query,
        matching: "case_insensitive_literal",
        matches,
        skipped: sources
          .filter((source) => source.encoding !== "utf8")
          .map((source) => ({ ref: source.ref, reason: "non_utf8_content" as const })),
        maxBytes,
        maxMatchesPerPage: RESULT_QUERY_MAX_MATCHES,
        complete: !nextCursor,
        ...(nextCursor ? { nextCursor } : {}),
      };
    }
    let remaining = maxBytes;
    const items: Array<{
      ref: string; mediaType: string; title: string; totalBytes: number;
      range: { start: number; end: number }; content: string; encoding: "utf8" | "base64"; complete: boolean;
    }> = [];
    while (itemIndex < sources.length && remaining > 0) {
      const source = sources[itemIndex]!;
      const start = byteOffset;
      const tentativeEnd = Math.min(source.content.length, start + remaining);
      const end = source.encoding === "utf8" ? utf8PageEnd(source.content, start, tentativeEnd) : tentativeEnd;
      const chunk = source.content.subarray(start, end);
      const complete = end >= source.content.length;
      items.push({
        ref: source.ref,
        mediaType: source.mediaType,
        title: source.title,
        totalBytes: source.content.length,
        range: { start, end },
        content: source.encoding === "utf8" ? chunk.toString("utf8") : chunk.toString("base64"),
        encoding: source.encoding,
        complete,
      });
      remaining -= end - start;
      if (!complete) {
        byteOffset = end;
        break;
      }
      itemIndex += 1;
      byteOffset = 0;
    }
    const nextCursor = itemIndex < sources.length
      ? encodeResultCursor({ runId: capability.runId, refsHash, versionsHash, maxBytes, itemIndex, byteOffset }, resultCursorSecret)
      : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}), maxBytes };
  });

  app.post<{
    Body: {
      operation?: "open" | "navigate" | "inspect" | "act" | "screenshot" | "take_control" | "close";
      url?: string;
      action?: unknown;
      selector?: unknown;
      text?: unknown;
      key?: unknown;
    };
  }>("/api/agent-browser", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    const agent = capability ? store.getAgent(capability.agentId) : undefined;
    if (!capability || !active || !agent || !capabilityOwnsAuthoritativeRun(capability, active) || active.messageCapability !== token) {
      return reply.code(401).send({ error: "browser capability is not authorized for an active run" });
    }
    const projectGrant = projectBrowserGrants.get(agent.projectId);
    const borrowingProjectBrowser = projectGrant?.agentId === agent.id && projectGrant.runId === active.runId;
    const sessionManager = borrowingProjectBrowser ? projectBrowserSessions : browserSessions;
    const scope: BrowserScope = borrowingProjectBrowser
      ? projectBrowserScope(agent.projectId, projectGrant)
      : {
          projectId: agent.projectId,
          agentId: agent.id,
          runId: active.runId,
          ...(active.conversationId ? { conversationId: active.conversationId } : {}),
        };
    try {
      switch (request.body?.operation) {
        case "open": {
          const session = await sessionManager.open(scope, request.body.url);
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "navigate": {
          if (typeof request.body.url !== "string") throw new BrowserSessionError("url is required");
          const session = await sessionManager.navigate(scope, request.body.url, "agent");
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "inspect":
          return { session: sessionManager.get(scope.agentId), snapshot: await sessionManager.inspect(scope) };
        case "act": {
          const session = await sessionManager.act(scope, request.body);
          return { session, snapshot: await sessionManager.inspect(scope) };
        }
        case "screenshot":
          return { session: sessionManager.get(scope.agentId), artifact: await sessionManager.captureArtifact(scope) };
        case "take_control":
          return { session: await sessionManager.setControl(scope, "agent") };
        case "close": {
          if (borrowingProjectBrowser) {
            const session = sessionManager.get(scope.agentId);
            if (!session) throw new BrowserSessionError("project browser session is unavailable", 404);
            projectBrowserGrants.delete(agent.projectId);
            return { session: await sessionManager.setControl(scope, "operator", session.controlEpoch) };
          }
          return { session: await sessionManager.close(scope, "agent_closed") };
        }
        default:
          return reply.code(400).send({ error: "unknown browser operation" });
      }
    } catch (error) {
      if (error instanceof BrowserSessionError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
