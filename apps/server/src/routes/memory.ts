import type { FastifyInstance, FastifyRequest } from "fastify";
import { PONDEROSA_MEMORY_TOOLS, type MemorySourceReference, type MemorySourceClassification } from "@ponderosa/core";
import { MemoryNotFoundError, MemoryRevisionConflictError, MemoryCommandConflictError, type MemoryStore } from "@ponderosa/agents";
import { MemoryAuthority, MemoryAuthorityError, type MemoryAuthorityPorts } from "../memory-authority.js";
import { projectInProduct, requestProduct } from "../product-scope.js";

type Command = { operation: string; memoryId?: string; expectedRevision?: number; text?: string;
  classification?: MemorySourceClassification; sources?: MemorySourceReference[]; expiresAt?: string;
  commandKey?: string; query?: string; limit?: number; scope?: "project" | "global" | "both"; textHash?: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Invalid memory fields");
}
/** Validate before Fastify's default removeAdditional/coercion can rewrite data.
 * No model identity, grants, collection, source paths or operator fields exist. */
export function memoryCommand(body: unknown, operator: boolean): Command {
  if (!object(body) || typeof body.operation !== "string") throw new TypeError("Memory operation required");
  const operation = body.operation;
  const spec = PONDEROSA_MEMORY_TOOLS.find(tool => tool.name === `ponderosa_memory_${operation}`)?.inputSchema;
  const extra = operator && operation === "list" ? ["limit"] : operator && operation === "history" ? ["memoryId", "limit"]
    : operator && operation === "promote" ? ["memoryId", "expectedRevision", "textHash", "commandKey"] : undefined;
  if (!spec && !extra) throw new TypeError("Invalid memory operation");
  const fields = extra ?? Object.keys(spec!.properties as Record<string, unknown>);
  keys(body, ["operation", ...fields]);
  const required = extra ? operation === "list" ? [] : operation === "history" ? ["memoryId"] : extra : spec!.required as string[];
  if (required.some(key => body[key] === undefined)) throw new TypeError("Missing memory field");
  for (const key of ["memoryId", "commandKey"]) {
    const v = body[key]; if (v !== undefined && (typeof v !== "string" || !v || v.length > 256 || /[\u0000-\u001f]/u.test(v))) throw new TypeError("Invalid memory identifier");
  }
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)) throw new TypeError("Invalid memory revision");
  if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 100)) throw new TypeError("Invalid memory limit");
  for (const key of ["text", "query"]) if (body[key] !== undefined && (typeof body[key] !== "string" || !(body[key] as string).trim() || [...body[key] as string].length > 10000 || (body[key] as string).includes("\u0000"))) throw new TypeError("Invalid memory text");
  if (body.classification !== undefined && !["agent_inference", "user_statement"].includes(body.classification as string)) throw new TypeError("Invalid memory classification");
  if (body.expiresAt !== undefined && (typeof body.expiresAt !== "string" || body.expiresAt.length > 64 || !Number.isFinite(Date.parse(body.expiresAt)))) throw new TypeError("Invalid memory expiry");
  if (body.scope !== undefined && !(operation === "search" ? ["project", "global", "both"] : operator ? ["project", "global"] : ["project"]).includes(body.scope as string)) throw new TypeError("Invalid memory scope");
  if (body.textHash !== undefined && (typeof body.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(body.textHash))) throw new TypeError("Invalid memory hash");
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources) || body.sources.length > 20) throw new TypeError("Invalid memory sources");
    for (const source of body.sources) {
      keys(source, ["kind", "id", "revision", "sha256"]);
      if (!["communication", "artifact"].includes(source.kind as string) ||
          ["id", "revision"].some(key => typeof source[key] !== "string" || !source[key] || (source[key] as string).length > 256 || /[\u0000-\u001f]/u.test(source[key] as string)) ||
          typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new TypeError("Invalid memory source");
    }
  }
  return body as unknown as Command;
}
function execute(memory: MemoryStore, command: Command, operator: boolean) {
  switch (command.operation) {
    case "search": return { retrieval: "lexical", memories: memory.search(command.query!, command.limit) };
    case "get": return memory.get(command.memoryId!) ?? (() => { throw new MemoryNotFoundError(); })();
    case "list": return memory.list(command.limit);
    case "history": return memory.history(command.memoryId!, command.limit);
    case "save": return memory.save({ ...command, text: command.text!, classification: command.classification ?? (operator ? "user_statement" : "agent_inference"), commandKey: command.commandKey!, scope: undefined });
    case "update": return memory.update(command.memoryId!, command.expectedRevision!, { ...command, text: command.text!, classification: command.classification ?? (operator ? "user_statement" : "agent_inference"), commandKey: command.commandKey! });
    case "forget": return memory.forget(command.memoryId!, command.expectedRevision!, command.commandKey!);
    default: throw new TypeError("Invalid memory operation");
  }
}

export function registerMemoryRoutes(app: FastifyInstance, ports: MemoryAuthorityPorts, changed?: (hint: import("@ponderosa/core").MemoryChangedEvent) => void): void {
  const authority = new MemoryAuthority(ports);
  // Disabled retains canonical data/deletion safety and exposes no route/tools.
  if (!ports.opts.memoryEnabled) return;
  const generation = (scope: string, owner: string) => (ports.store.sqlite.prepare("SELECT generation FROM memory_scope_generations WHERE scope=? AND owner_id=?").get(scope, owner) as { generation: number } | undefined)?.generation ?? 0;
  const principal = () => (ports.store.sqlite.prepare("SELECT principal_id FROM memory_installation_owner WHERE singleton=1").get() as { principal_id: string } | undefined)?.principal_id ?? "";
  const mutate = <T>(projectId: string | undefined, product: import("../product-scope.js").ProductScope, apply: () => T): T => {
    const scope = projectId ? "project" : "global";
    const before = generation(scope, projectId ?? principal());
    const result = apply(); // MemoryStore/setGrant have committed before any hint.
    const after = generation(scope, projectId ?? principal());
    if (after !== before) {
      const targets = projectId ? [projectId] : (ports.store.sqlite.prepare("SELECT project_id FROM memory_global_grants WHERE product=? AND enabled=1").all(product) as Array<{ project_id: string }>).map(row => row.project_id);
      for (const id of targets) if (projectInProduct(ports.store, id, product)) changed?.({ type: "memory_changed", projectId: id, scope, generation: after });
    }
    return result;
  };
  const token = (request: FastifyRequest) => request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
  const operator = (request: FastifyRequest) => {
    if (ports.agentMessageCapabilities.has(token(request))) throw new MemoryAuthorityError("Agent capabilities cannot authorize operator memory");
  };
  const handle = async (reply: import("fastify").FastifyReply, apply: () => unknown) => {
    try { return apply(); } catch (error) {
      if (error instanceof MemoryAuthorityError) return reply.code(403).send({ error: error.message });
      if (error instanceof MemoryNotFoundError) return reply.code(404).send({ error: "Memory not found" });
      if (error instanceof MemoryRevisionConflictError || error instanceof MemoryCommandConflictError) return reply.code(409).send({ error: error.message });
      if (error instanceof TypeError || (error instanceof Error && /^(Invalid memory|Memory (text|source|expiry)|Unverified|User statement requires verified source)/u.test(error.message))) return reply.code(400).send({ error: error.message });
      throw error;
    }
  };
  app.post("/api/agent-memory", { bodyLimit: 128 * 1024 }, async (request, reply) => handle(reply, () => {
    const command = memoryCommand(request.body, false);
    const apply = () => execute(authority.forAgent(token(request), `ponderosa_memory_${command.operation}`, command.scope ?? "both"), command, false);
    const cap = ports.agentMessageCapabilities.get(token(request));
    const agent = cap && ports.store.getAgent(cap.agentId);
    return ["save", "update", "forget"].includes(command.operation) && agent ? mutate(agent.projectId, requestProduct(request), apply) : apply();
  }));
  for (const url of ["/api/memories", "/api/projects/:id/memories"]) {
    app.post<{ Params: { id?: string } }>(url, { bodyLimit: 128 * 1024 }, async (request, reply) => handle(reply, () => {
      operator(request); const command = memoryCommand(request.body, true); const product = requestProduct(request); const projectId = request.params.id;
      if (command.scope !== undefined && command.scope !== (projectId ? "project" : "global")) throw new TypeError("Invalid memory scope for route");
      if (command.operation === "promote") {
        if (!projectId) throw new TypeError("Invalid memory promotion source");
        return mutate(undefined, product, () => authority.promote(product, projectId, command.memoryId!, command.expectedRevision!, command.textHash!, command.commandKey!));
      }
      const memory = authority.forOperator(product, projectId);
      if (!projectId && command.operation === "save") return mutate(undefined, product, () => memory.save({ ...command, text: command.text!, classification: command.classification ?? "user_statement", commandKey: command.commandKey!, scope: "global" }));
      const apply = () => execute(memory, command, true);
      return ["save", "update", "forget"].includes(command.operation) ? mutate(projectId, product, apply) : apply();
    }));
  }
  app.put<{ Params: { id: string } }>("/api/projects/:id/memory-global-grant", async (request, reply) => handle(reply, () => {
    operator(request); keys(request.body, ["enabled", "expectedRevision"]);
    if (typeof request.body.enabled !== "boolean" || !Number.isSafeInteger(request.body.expectedRevision) || (request.body.expectedRevision as number) < 0) throw new TypeError("Invalid memory grant");
    const { enabled, expectedRevision } = request.body;
    return mutate(request.params.id, requestProduct(request), () => authority.setGrant(request.params.id, requestProduct(request), enabled, expectedRevision as number));
  }));
}
