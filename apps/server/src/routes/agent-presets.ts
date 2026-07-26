import type { AgentStore } from "@ponderosa/agents";
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

export interface AgentPresetRoutesOptions {
  readonly store: Pick<
    AgentStore,
    | "createAgentPreset"
    | "deleteAgentPreset"
    | "getAgentPreset"
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

  app.post<{ Params: { id: string }; Body: CreateAgentPresetRequest }>(
    "/api/projects/:id/agent-presets",
    async (request, reply) => {
      if (!options.store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      const error = validatePreset(request.body ?? {}, false, request.params.id);
      if (error) return reply.code(400).send({ error });
      return reply.code(201).send(options.store.createAgentPreset(request.params.id, request.body));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAgentPresetRequest }>(
    "/api/agent-presets/:id",
    async (request, reply) => {
      const current = options.store.getAgentPreset(request.params.id);
      if (!current) return reply.code(404).send({ error: "preset not found" });
      const body = request.body ?? {};
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
