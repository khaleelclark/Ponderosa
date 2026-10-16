import { stableJson, type AgentStore } from "@ponderosa/agents";
import { createHash } from "node:crypto";
import type {
  CreateAgentPresetRequest,
  UpdateAgentPresetRequest,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";

type PresetSelection = {
  name?: string;
  description?: string;
  guidance?: string;
  engine?: string;
  model?: string | null;
  effort?: string | null;
};

function presetPrimitiveError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "preset must be an object";
  const input = value as Record<string, unknown>;
  for (const field of ["name", "description", "guidance", "engine"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") return `${field} must be a string`;
  }
  for (const field of ["model", "effort"] as const) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") {
      return `${field} must be a string or null`;
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return "enabled must be a boolean";
  return undefined;
}

export interface AgentPresetRoutesOptions {
  readonly store: Pick<
    AgentStore,
    | "createAgentPreset"
    | "deleteAgentPreset"
    | "getAgentPreset"
    | "getAgentPresetCreation"
    | "getProject"
    | "listAgentPresets"
    | "updateAgentPreset"
  >;
  readonly validateRuntimeSelection: (
    input: PresetSelection,
    projectId?: string,
  ) => string | undefined;
}

export function registerAgentPresetRoutes(
  app: FastifyInstance,
  options: AgentPresetRoutesOptions,
): void {
  const validatePreset = (
    input: PresetSelection,
    partial = false,
    projectId?: string,
  ): string | undefined => {
    const primitiveError = presetPrimitiveError(input);
    if (primitiveError) return primitiveError;
    if (!partial && (!input.name?.trim() || !input.description?.trim() || !input.guidance?.trim() || !input.engine)) {
      return "name, description, guidance, and engine are required";
    }
    if (input.name !== undefined && (input.name.trim().length < 2 || input.name.trim().length > 60)) {
      return "name must be 2-60 characters";
    }
    if (input.description !== undefined && input.description.trim().length > 240) {
      return "description must be at most 240 characters";
    }
    if (input.guidance !== undefined && (input.guidance.trim().length < 10 || input.guidance.trim().length > 8000)) {
      return "guidance must be 10-8000 characters";
    }
    return options.validateRuntimeSelection(input, projectId);
  };

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/agent-presets",
    async (request, reply) => options.store.getProject(request.params.id)
      ? options.store.listAgentPresets(request.params.id)
      : reply.code(404).send({ error: "project not found" }),
  );

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: CreateAgentPresetRequest;
  }>(
    "/api/projects/:id/agent-presets",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"]?.trim();
      if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
        return reply.code(400).send({ error: "a valid Agent preset creation idempotency key is required" });
      }
      const identity = {
        idempotencyKey,
        payloadHash: createHash("sha256").update(stableJson(request.body ?? null)).digest("hex"),
      };
      try {
        const replay = options.store.getAgentPresetCreation(request.params.id, identity);
        if (replay) return replay;
      } catch (error) {
        if (error instanceof Error && (error.message.includes("reused with different input") ||
            error.message.includes("was already deleted"))) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (!options.store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const error = validatePreset(request.body ?? {}, false, request.params.id);
      if (error) return reply.code(400).send({ error });
      return reply.code(201).send(options.store.createAgentPreset(request.params.id, request.body, identity));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAgentPresetRequest }>(
    "/api/agent-presets/:id",
    async (request, reply) => {
      const current = options.store.getAgentPreset(request.params.id);
      if (!current) return reply.code(404).send({ error: "preset not found" });
      const body = request.body ?? {};
      const primitiveError = presetPrimitiveError(body);
      if (primitiveError) return reply.code(400).send({ error: primitiveError });
      if (Object.keys(body).some((key) =>
        !["name", "description", "guidance", "engine", "model", "effort", "enabled"].includes(key))) {
        return reply.code(400).send({ error: "unknown preset field" });
      }
      const error = validatePreset({ ...current, ...body }, true, current.projectId);
      if (error) return reply.code(400).send({ error });
      return options.store.updateAgentPreset(request.params.id, body)!;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/agent-presets/:id",
    async (request, reply) => options.store.deleteAgentPreset(request.params.id)
      ? { deleted: true }
      : reply.code(404).send({ error: "preset not found" }),
  );
}
