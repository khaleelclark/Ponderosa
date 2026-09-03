import type { FastifyReply, FastifyRequest } from "fastify";

type PendingAgentStore = {
  agentCreationPending(agentId: string): boolean;
};

const compoundAgentId = (value: string): string | undefined => {
  const match = /^agent:([^:]+)$/u.exec(value.trim());
  return match?.[1];
};

const collectAgentReferences = (
  value: unknown,
  ids: Set<string>,
  field = "",
  allStrings = false,
): void => {
  const pending: Array<{ value: unknown; field: string }> = [{ value, field }];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (allStrings || /agentIds?$/iu.test(current.field)) ids.add(current.value.trim());
      const compound = compoundAgentId(current.value);
      if (compound) ids.add(compound);
      continue;
    }
    if (!current.value || typeof current.value !== "object" || ArrayBuffer.isView(current.value)) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, field: current.field });
      continue;
    }
    for (const [key, item] of Object.entries(current.value)) {
      pending.push({ value: item, field: key });
    }
  }
};

export const pendingAgentReferences = (request: FastifyRequest): string[] => {
  const ids = new Set<string>();
  collectAgentReferences(request.params, ids, "", true);
  collectAgentReferences(request.query, ids);
  collectAgentReferences(request.body, ids);
  ids.delete("");
  return [...ids];
};

export const pendingAgentQuarantine = (store: PendingAgentStore) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (pendingAgentReferences(request).some((agentId) => store.agentCreationPending(agentId))) {
      return reply.code(404).send({ error: "agent not found" });
    }
  };
