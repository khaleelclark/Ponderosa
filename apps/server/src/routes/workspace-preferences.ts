import type {
  MarkWorkspaceResourceUsedRequest,
  ModelOption,
  ProjectEngineModelCatalogDto,
  UpdateWorkspacePreferencesRequest,
} from "@ponderosa/core";
import { validSpeechPreferences } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import {
  MAX_CONFIGURABLE_AGENT_RUN_CONCURRENCY,
  MIN_CONFIGURABLE_AGENT_RUN_CONCURRENCY,
  type ActiveRun,
  type CreateServerOptions,
  type EngineRegistration,
  type PersistentRuntime,
} from "../app-contracts.js";
import {
  isManagedOperatorAvatarId,
  readOperatorProfileImage,
} from "../operator-profile-images.js";
import { runtimeSelectionError } from "../runtime-selection.js";
import { registerOperatorProfileImageRoutes } from "./operator-profile-images.js";

interface WorkspacePreferenceRoutesContext {
  opts: CreateServerOptions;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  scheduledSessionRollovers: Map<string, string>;
  organizationEnvelopeStates: Map<string, { sessionId: string; hash: string }>;
  engineModelCatalogCache: Map<string, {
    projectId: string;
    engineId: string;
    expiresAt: number;
    value: ProjectEngineModelCatalogDto;
  }>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[] | undefined;
  applyOperatorModelOptions(): void;
  publishWorkspaceSince(cursor: number): void;
  setMaxConcurrentRuns(maxConcurrentRuns: number): void;
  clearAgentResumeSession(agentId: string, reason: string): void;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId: string,
  ): Promise<void>;
}

export function registerWorkspacePreferenceRoutes(
  app: FastifyInstance,
  context: WorkspacePreferenceRoutesContext,
): void {
  const {
    opts,
    store,
    workspace,
    engines,
    activeRuns,
    scheduledSessionRollovers,
    organizationEnvelopeStates,
    engineModelCatalogCache,
    cachedModelOptions,
    applyOperatorModelOptions,
    publishWorkspaceSince,
    setMaxConcurrentRuns,
    clearAgentResumeSession,
    persistentRuntimeForTermination,
    teardownPersistentRuntime,
  } = context;
  const catalogOperatorAvatarIds = new Set([
    "default-user",
    "sunset",
    "river",
    "mountain",
    "fox",
    "owl",
  ]);

  registerOperatorProfileImageRoutes(app, opts);
  app.put<{ Params: { kind: string; id: string }; Body: { mode?: string } }>("/api/notification-settings/:kind/:id", async (request, reply) => {
    const { kind, id } = request.params;
    if (kind !== "agent" && kind !== "conversation") return reply.code(400).send({ error: "invalid notification scope" });
    if (!(kind === "agent" ? store.getAgent(id) : store.getConversation(id))) return reply.code(404).send({ error: "resource not found" });
    const mode = request.body?.mode;
    if (!["all", "attention", "muted", ...(kind === "agent" ? ["inherit"] : [])].includes(mode ?? "")) return reply.code(400).send({ error: "invalid notification mode" });
    const scopes = { ...workspace.getPreferences().notificationScopes };
    if (mode === "inherit") delete scopes[`${kind}:${id}`];
    else scopes[`${kind}:${id}`] = mode as "all" | "attention" | "muted";
    const cursor = workspace.cursor();
    const preferences = workspace.updatePreferences({ notificationScopes: scopes });
    publishWorkspaceSince(cursor);
    return preferences;
  });

  app.get("/api/workspace/preferences", async () => workspace.getPreferences());

  app.get<{ Querystring: { limit?: string } }>(
    "/api/workspace/recent-resources",
    async (request, reply) => {
      const rawLimit = request.query.limit;
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        return reply.code(400).send({ error: "limit must be an integer between 1 and 1000" });
      }
      const recency = workspace.listResourceRecency(limit);
      return {
        ...recency,
        resources: recency.resources.filter((resource) =>
          resource.kind !== "agent" || !store.agentCreationPending(resource.resourceId)),
      };
    },
  );

  app.post<{ Body: MarkWorkspaceResourceUsedRequest }>(
    "/api/workspace/recent-resources/use",
    async (request, reply) => {
      const kind = request.body?.kind;
      const resourceId = request.body?.resourceId;
      if (
        (
          kind !== "project"
          && kind !== "conversation"
          && kind !== "agent"
        )
        || typeof resourceId !== "string"
        || !resourceId.trim()
        || resourceId.length > 200
      ) {
        return reply.code(400).send({ error: "invalid workspace resource" });
      }
      const exists = kind === "project"
        ? Boolean(store.getProject(resourceId))
        : kind === "conversation"
          ? Boolean(store.getConversation(resourceId))
          : Boolean(store.getAgent(resourceId)) && !store.agentCreationPending(resourceId);
      if (!exists) {
        return reply.code(404).send({ error: "workspace resource not found" });
      }
      const cursor = workspace.cursor();
      const recency = workspace.markResourceUsed(kind, resourceId);
      publishWorkspaceSince(cursor);
      return recency;
    },
  );

  app.patch<{ Body: UpdateWorkspacePreferencesRequest }>("/api/workspace/preferences", async (request, reply) => {
    const patch = request.body ?? {};
    if (patch.notificationScopes !== undefined) return reply.code(400).send({ error: "use the resource notification settings endpoint" });
    for (const key of ["projectFolders", "chatFolders"] as const) {
      if (patch[key] === undefined) continue;
      const folders = patch[key];
      const memberKey = key === "projectFolders" ? "projectIds" : "conversationIds";
      const ids = new Set<string>();
      const members = new Set<string>();
      if (!Array.isArray(folders) || folders.length > 1000 || folders.some(folder => {
        if (!folder || typeof folder !== "object" || typeof folder.id !== "string" || !folder.id || folder.id.length > 200 || ids.has(folder.id) ||
          typeof folder.name !== "string" || !folder.name.trim() || folder.name.length > 100 || typeof folder.expanded !== "boolean" ||
          (key === "chatFolders" && "starred" in folder && folder.starred !== undefined && typeof folder.starred !== "boolean") ||
          !Array.isArray((folder as unknown as Record<string, unknown[]>)[memberKey]) || (folder as unknown as Record<string, unknown[]>)[memberKey]!.length > 10000) return true;
        ids.add(folder.id);
        return (folder as unknown as Record<string, unknown[]>)[memberKey]!.some(id => {
          if (typeof id !== "string" || !id || id.length > 200 || members.has(id) || members.size >= 10000) return true;
          members.add(id); return false;
        });
      })) return reply.code(400).send({ error: `invalid ${key}` });
    }
    if (patch.speech !== undefined && !validSpeechPreferences(patch.speech)) {
      return reply.code(400).send({ error: "invalid speech preferences" });
    }
    if (Object.hasOwn(patch, "revision") || Object.hasOwn(patch, "updatedAt")) {
      return reply.code(400).send({ error: "preference revision and timestamp are server-owned" });
    }
    if (patch.projectSort && !["last_used", "alphabetical", "custom"].includes(patch.projectSort)) return reply.code(400).send({ error: "invalid project sort" });
    for (const [label, sort] of [["home", patch.homeSort], ["chat", patch.chatSort], ["agent", patch.agentSort]] as const) {
      if (sort !== undefined && !["last_used", "alphabetical", "custom"].includes(sort)) return reply.code(400).send({ error: `invalid ${label} sort` });
    }
    if (patch.projectOrder && (patch.projectOrder.length > 10_000 || patch.projectOrder.some((id) => typeof id !== "string" || id.length > 200) || new Set(patch.projectOrder).size !== patch.projectOrder.length)) {
      return reply.code(400).send({ error: "invalid custom project order" });
    }
    for (const [label, order] of [["home", patch.homeOrder], ["chat", patch.chatOrder], ["agent", patch.agentOrder]] as const) {
      if (order !== undefined && (!Array.isArray(order) || order.length > 10_000 || order.some((id) => typeof id !== "string" || id.length > 200) || new Set(order).size !== order.length)) {
        return reply.code(400).send({ error: `invalid custom ${label} order` });
      }
    }
    if (patch.starredProjectIds !== undefined && (!Array.isArray(patch.starredProjectIds) || patch.starredProjectIds.length > 10_000 || patch.starredProjectIds.some((id) => typeof id !== "string" || id.length > 200) || new Set(patch.starredProjectIds).size !== patch.starredProjectIds.length)) {
      return reply.code(400).send({ error: "invalid starred projects" });
    }
    if (patch.starredResourceIds !== undefined && (!Array.isArray(patch.starredResourceIds) || patch.starredResourceIds.length > 10_000 || patch.starredResourceIds.some((id) => typeof id !== "string" || id.length > 240 || !/^(?:project|conversation|agent):[^:]+$/u.test(id)) || new Set(patch.starredResourceIds).size !== patch.starredResourceIds.length)) {
      return reply.code(400).send({ error: "invalid starred resources" });
    }
    if (patch.notifications !== undefined && (typeof patch.notifications !== "object" || patch.notifications === null || Object.entries(patch.notifications).some(([key, value]) => !["directResponses", "broadcasts"].includes(key) || typeof value !== "boolean"))) return reply.code(400).send({ error: "notification preferences must contain supported boolean switches" });
    if (patch.providerAvailability !== undefined && (typeof patch.providerAvailability !== "object" || patch.providerAvailability === null || Object.entries(patch.providerAvailability).some(([key, value]) => !engines.has(key) || typeof value !== "boolean"))) return reply.code(400).send({ error: "provider availability must contain configured engines and boolean values" });
    if (patch.defaultUsageProvider !== undefined && (typeof patch.defaultUsageProvider !== "string" || !engines.get(patch.defaultUsageProvider)?.adapter.readProviderUsage)) {
      return reply.code(400).send({ error: "default usage provider must expose subscription usage" });
    }
    if (patch.engineDefaults !== undefined) {
      if (typeof patch.engineDefaults !== "object" || patch.engineDefaults === null) return reply.code(400).send({ error: "engine defaults must be an object" });
      for (const [engineId, selection] of Object.entries(patch.engineDefaults)) {
        const registration = engines.get(engineId);
        if (!registration || !selection || typeof selection !== "object" || typeof selection.model !== "string" || !selection.model.trim() || (selection.effort !== undefined && typeof selection.effort !== "string")) {
          return reply.code(400).send({ error: "engine defaults require a configured engine and concrete model" });
        }
        const selectionError = runtimeSelectionError(
          registration.adapter,
          selection.model,
          selection.effort,
          cachedModelOptions(registration.adapter),
        );
        if (selectionError) return reply.code(400).send({ error: selectionError });
      }
    }
    if (patch.claudeModelOptions !== undefined) {
      if (!Array.isArray(patch.claudeModelOptions) ||
          patch.claudeModelOptions.length > 100 ||
          patch.claudeModelOptions.some((model) =>
            !model || typeof model !== "object" ||
            typeof model.id !== "string" || !model.id.trim() || model.id.length > 200 ||
            (model.label !== undefined && (typeof model.label !== "string" || model.label.length > 200)) ||
            (model.resolvedModel !== undefined && (typeof model.resolvedModel !== "string" || model.resolvedModel.length > 200)) ||
            (model.validatedAt !== undefined && (typeof model.validatedAt !== "string" || !Number.isFinite(Date.parse(model.validatedAt)))) ||
            (model.availability !== undefined && model.availability !== "available" && model.availability !== "unavailable") ||
            (model.unavailableReason !== undefined && (typeof model.unavailableReason !== "string" || model.unavailableReason.length > 1_000))) ||
          new Set(patch.claudeModelOptions.map((model) => model.id.trim())).size !== patch.claudeModelOptions.length) {
        return reply.code(400).send({ error: "Claude model options require unique validated model records with bounded ids, labels, and availability details" });
      }
    }
    if (patch.globalInstructions !== undefined && typeof patch.globalInstructions !== "string") return reply.code(400).send({ error: "global instructions must be a string" });
    if (patch.maxConcurrentAgentRuns !== undefined && (!Number.isSafeInteger(patch.maxConcurrentAgentRuns) ||
        patch.maxConcurrentAgentRuns < MIN_CONFIGURABLE_AGENT_RUN_CONCURRENCY ||
        patch.maxConcurrentAgentRuns > MAX_CONFIGURABLE_AGENT_RUN_CONCURRENCY)) {
      return reply.code(400).send({ error: `maximum concurrent Agent Runs must be an integer from ${MIN_CONFIGURABLE_AGENT_RUN_CONCURRENCY} to ${MAX_CONFIGURABLE_AGENT_RUN_CONCURRENCY}` });
    }
    if (patch.contextRolloverEnabled !== undefined && typeof patch.contextRolloverEnabled !== "boolean") {
      return reply.code(400).send({ error: "context rollover enabled must be a boolean" });
    }
    if (patch.contextRolloverTokens !== undefined &&
        (typeof patch.contextRolloverTokens !== "number" || !Number.isFinite(patch.contextRolloverTokens))) {
      return reply.code(400).send({ error: "context rollover tokens must be a finite number" });
    }
    if (patch.contextRolloverWindowFraction !== undefined &&
        (typeof patch.contextRolloverWindowFraction !== "number" || !Number.isFinite(patch.contextRolloverWindowFraction))) {
      return reply.code(400).send({ error: "context rollover window fraction must be a finite number" });
    }
    if (patch.onboardingCompletedAt !== undefined && patch.onboardingCompletedAt !== null &&
        (typeof patch.onboardingCompletedAt !== "string" || !Number.isFinite(Date.parse(patch.onboardingCompletedAt)))) {
      return reply.code(400).send({ error: "onboarding completion must be a valid timestamp or null" });
    }
    if (patch.profile !== undefined) {
      const profile = patch.profile;
      const handle = profile?.handle?.replace(/^#/, "").toLowerCase();
      if (!profile || typeof profile.displayName !== "string" || typeof handle !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(handle) || ["broadcast", "everyone", "user"].includes(handle) || typeof profile.avatarId !== "string") {
        return reply.code(400).send({ error: "profile requires a display name, picture, and an available 2–32 character handle" });
      }
      if (!catalogOperatorAvatarIds.has(profile.avatarId) && (!isManagedOperatorAvatarId(profile.avatarId) || !await readOperatorProfileImage(opts.dataDir, profile.avatarId))) return reply.code(400).send({ error: "profile picture is not a durable managed upload or generated choice" });
      patch.profile = { ...profile, handle };
    }
    const previousPreferences = workspace.getPreferences();
    if (patch.projectFolders !== undefined && patch.projectFoldersRevision !== previousPreferences.revision) {
      return reply.code(409).send({ error: "Project folders changed; refresh and reapply the folder action." });
    }
    delete patch.projectFoldersRevision;
    if (patch.chatFolders !== undefined && patch.chatFoldersRevision !== previousPreferences.revision) {
      return reply.code(409).send({ error: "Chat folders changed; refresh and reapply the folder action." });
    }
    if (patch.chatFolders?.some(folder => folder.conversationIds.some(id => !store.getConversation(id)))) {
      return reply.code(400).send({ error: "A chat in this folder no longer exists. Refresh and retry." });
    }
    delete patch.chatFoldersRevision;
    const cursor = workspace.cursor();
    const preferences = workspace.updatePreferences(patch);
    // The store owns normalization; compare only fields delivered in the prompt.
    const globalInstructionsChanged = preferences.globalInstructions.trim() !== previousPreferences.globalInstructions.trim();
    const profileChanged = preferences.profile.displayName !== previousPreferences.profile.displayName ||
      preferences.profile.handle !== previousPreferences.profile.handle;
    if (patch.claudeModelOptions !== undefined) {
      applyOperatorModelOptions();
      for (const entry of engineModelCatalogCache.values()) entry.expiresAt = 0;
    }
    if (preferences.maxConcurrentAgentRuns !== previousPreferences.maxConcurrentAgentRuns) {
      setMaxConcurrentRuns(preferences.maxConcurrentAgentRuns);
    }
    publishWorkspaceSince(cursor);
    if (globalInstructionsChanged || profileChanged) for (const project of store.listProjects()) for (const agent of store.listAgents(project.id)) {
      organizationEnvelopeStates.delete(agent.id);
      if (activeRuns.has(agent.id)) scheduledSessionRollovers.set(agent.id, new Date().toISOString());
      else {
        clearAgentResumeSession(agent.id, "request_context_rollover");
        const runtime = persistentRuntimeForTermination(agent.id);
        if (runtime) await teardownPersistentRuntime(agent.id, runtime, "workspace policy update", project.id);
      }
    }
    return preferences;
  });
}
