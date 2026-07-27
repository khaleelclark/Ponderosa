import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentDto,
  AgentExportMode,
  AgentPortablePackageDto,
  Adapter,
  CopyAgentPackageRequest,
  CreateTriggerRequest,
  ImportAgentPackageRequest,
  ImportAgentPackageResponse,
  ModelOption,
  TriggerScheduleConfig,
  TriggerSourceConfig,
  TriggerSourceKind,
} from "@ponderosa/core";
import {
  publishManagedArtifactContents,
  readManagedArtifactContent,
  type AgentStore,
  type CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CANONICAL_ARTIFACT_ID,
  portableAgentTopologyError,
  rewritePortableArtifactReferences,
} from "../artifact-refs.js";
import {
  AssetError,
  type AssetStore,
  generatedArtifactMetadataIsValid,
  type RegisteredGeneratedArtifact,
} from "../assets.js";
import { runtimeSelectionError } from "../runtime-selection.js";
import {
  normalizeTriggerSourceConfig,
  type TriggerSourceService,
} from "../trigger-service.js";
import {
  exactTriggerFields,
  parseCreateTrigger,
  triggerObject,
} from "../trigger-validation.js";

interface AgentPackageRoutesContext {
  dataDir: string;
  store: AgentStore;
  coordination: CoordinationV3Store;
  assets: AssetStore;
  engines: ReadonlyMap<string, { adapter: Adapter }>;
  deletingProjectIds: ReadonlySet<string>;
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[];
  triggerSources: Pick<TriggerSourceService, "createWebhookSecret" | "refresh">;
  appendWorkspace: (event: {
    type: "project_changed";
    projectId: string;
    action: "updated";
  }) => unknown;
  agentMessages: (agentId: string) => Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
  }>;
}

export function registerAgentPackageRoutes(
  app: FastifyInstance,
  context: AgentPackageRoutesContext,
): void {
  const {
    store,
    coordination: coordinationV3,
    assets,
    engines,
    deletingProjectIds,
    cachedModelOptions,
    triggerSources,
    appendWorkspace,
    agentMessages,
  } = context;
  const blobImportContentType = "application/vnd.ponderosa.agent-import";
  app.addContentTypeParser(
    blobImportContentType,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  const buildPortablePackage = async (
    agentId: string,
    requestedMode: AgentExportMode,
    organization: boolean,
  ): Promise<AgentPortablePackageDto> => {
    const root = store.getAgent(agentId);
    if (!root) throw new AssetError(404, "agent not found");
    // Context packages were an early V3.3 spelling of a full portable Agent.
    const mode: AgentExportMode = requestedMode === "context" ? "full" : requestedMode;
    const nodes = organization
      ? store.listAgentSubtree(root.id)
      : [root];
    const included = new Set(nodes.map((agent) => agent.id));
    const project = store.getProject(root.projectId)!;
    let portableArtifactBytes = 0;
    const canonicalUserDocuments = store.readCommunicationEvents(root.projectId)
      .filter((event) =>
        event.sender.kind === "user" && Boolean(event.document?.artifactId));
    const histories = new Map(nodes.map((agent) => {
      const history = [
        ...(store.getImportedHistory(agent.id)?.messages ?? []),
        ...agentMessages(agent.id).map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      ];
      for (const event of canonicalUserDocuments) {
        const visible = event.conversationId
          ? agent.conversationIds.includes(event.conversationId)
          : event.intent === "collaboration"
            ? event.audience.agentIds.includes(agent.id)
            : event.intent === "user_dm"
              ? (event.audience.kind === "user_agent"
                  ? event.audience.agentId === agent.id
                  : event.audience.agentIds.includes(agent.id))
              : false;
        if (
          visible
          && !history.some((message) =>
            message.text.includes(event.document!.artifactId!))
        ) {
          history.push({
            role: "user" as const,
            text: event.text,
            createdAt: event.createdAt,
          });
        }
      }
      return [agent.id, history] as const;
    }));
    const artifactOwner = new Map<string, string>();
    if (mode !== "template") {
      for (const artifact of store.getProjectArtifacts(root.projectId)) {
        if (artifact.originAgentId && included.has(artifact.originAgentId)) {
          artifactOwner.set(artifact.id, artifact.originAgentId);
          continue;
        }
        const referencingAgent = nodes.find((agent) =>
          (histories.get(agent.id) ?? []).some((message) =>
            message.text.includes(artifact.id)));
        if (referencingAgent) artifactOwner.set(artifact.id, referencingAgent.id);
      }
    }
    const agents = await Promise.all(nodes.map(async (agent) => {
      const history = histories.get(agent.id) ?? [];
      const historyText = history.map((message) => message.text).join("\n");
      const projectArtifacts = mode === "template"
        ? []
        : store.getProjectArtifacts(agent.projectId).filter((artifact) =>
          artifactOwner.get(artifact.id) === agent.id
          && (
            mode === "full"
            || artifact.pinned
            || artifact.visibility === "published"
            || historyText.includes(artifact.id)
          ));
      const artifacts = await Promise.all(projectArtifacts.map(async (artifact) => {
        const runtimeArtifact = coordinationV3.runtimeArtifact(artifact.id);
        const runtime = runtimeArtifact?.projectId === agent.projectId
          ? assets.authoritativeRuntimeArtifact(agent.projectId, runtimeArtifact)
          : undefined;
        const generated = artifact.kind === "generated_file"
          ? assets.authoritativeGeneratedArtifact(agent.projectId, artifact)
          : undefined;
        const fallback = !runtime && !generated && artifact.size && artifact.sha256
          ? readManagedArtifactContent(
              context.dataDir,
              agent.projectId,
              artifact.id,
              artifact.size,
              artifact.sha256,
            )?.body
          : undefined;
        const data = runtime?.body ?? generated?.body ?? fallback;
        if (!data) {
          throw new AssetError(
            409,
            `artifact ${artifact.id} content is unavailable or changed`,
          );
        }
        portableArtifactBytes += data.length;
        if (portableArtifactBytes > 64 * 1024 * 1024) {
          throw new AssetError(
            413,
            "portable Agent package artifacts exceed the 64 MiB export limit",
          );
        }
        return {
          ref: artifact.id,
          kind: artifact.kind,
          path: artifact.path,
          ...(artifact.summary ? { summary: artifact.summary } : {}),
          createdAt: artifact.createdAt,
          ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
          ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
          ...(artifact.pinned !== undefined ? { pinned: artifact.pinned } : {}),
          ...(artifact.sourcePath ? { sourcePath: artifact.sourcePath } : {}),
          dataBase64: data.toString("base64"),
        };
      }));
      const triggers = mode === "full"
        ? coordinationV3.listTriggerDefinitions(agent.id).map((trigger) => ({
            name: trigger.name,
            instructions: trigger.instructions,
            sourceKind: trigger.sourceKind,
            sourceConfig: trigger.sourceConfig,
            enabled: false as const,
            ...(trigger.runBudget ? { runBudget: trigger.runBudget } : {}),
          }))
        : undefined;
      return {
        ref: agent.id,
        title: agent.title,
        engine: agent.activeEngine,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        managementPermissions: agent.managementPermissions,
        ...(agent.spawnPrompt || agent.presetSnapshot?.guidance
          ? {
              initialInstructions:
                agent.spawnPrompt ?? agent.presetSnapshot?.guidance,
            }
          : {}),
        ...(agent.managerAgentId && included.has(agent.managerAgentId)
          ? { managerRef: agent.managerAgentId }
          : {}),
        ...(mode !== "template" ? { history } : {}),
        ...(artifacts.length ? { artifacts } : {}),
        ...(triggers?.length ? { triggers } : {}),
      };
    }));
    return {
      schema: "ponderosa.agent-package.v1",
      mode,
      kind: nodes.length === 1 ? "agent" : "organization",
      exportedAt: new Date().toISOString(),
      sourceLabel: `${project.label} / ${root.title}`,
      ...(mode === "full" && project.instructions
        ? { sourceProjectInstructions: project.instructions }
        : {}),
      rootRef: root.id,
      agents,
    };
  };

  app.get<{
    Params: { id: string };
    Querystring: {
      mode?: AgentExportMode;
      organization?: string;
      download?: string;
    };
  }>("/api/agents/:id/export", async (request, reply) => {
    const requestedMode: AgentExportMode = ["template", "context", "full"]
      .includes(request.query.mode ?? "")
      ? request.query.mode!
      : "full";
    const result = await buildPortablePackage(
      request.params.id,
      requestedMode,
      request.query.organization === "true",
    );
    if (request.query.download === "1") {
      const safeTitle = result.sourceLabel
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .toLocaleLowerCase()
        .slice(0, 80);
      reply.header(
        "content-disposition",
        `attachment; filename="${safeTitle || "agent"}-${result.mode}.ponderosa.json"`,
      );
    }
    return result;
  });

  const importPackage = async (
    projectId: string,
    body: ImportAgentPackageRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
      const project = store.getProject(projectId);
      const conversation = body?.conversationId
        ? store.getConversation(body.conversationId)
        : undefined;
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (deletingProjectIds.has(project.id)) {
        return reply.code(409).send({
          error: "Project deletion is already in progress",
        });
      }
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(400).send({
          error: "destination Project chat is required",
        });
      }
      type PlannedTrigger = {
        name: string;
        instructions: string;
        sourceKind: TriggerSourceKind;
        sourceConfig: TriggerSourceConfig;
        runBudget?: NonNullable<CreateTriggerRequest["runBudget"]>;
        nextFireAt?: string;
      };
      type PlannedArtifact =
        NonNullable<AgentPortablePackageDto["agents"][number]["artifacts"]>[number]
        & {
          data: Buffer;
          destinationId: string;
          managedPath: string;
          createdAt: string;
          summary: string;
          mediaType: string;
          sha256: string;
        };
      type PlannedNode = Omit<
        AgentPortablePackageDto["agents"][number],
        "artifacts" | "history" | "triggers"
      > & {
        targetEngine: string;
        model?: string;
        effort?: string;
        history: NonNullable<
          AgentPortablePackageDto["agents"][number]["history"]
        >;
        artifacts: PlannedArtifact[];
        triggers: PlannedTrigger[];
      };

      let portablePackage: AgentPortablePackageDto;
      let importNodes: PlannedNode[];
      let importSourceLabel: string;
      const artifactRefMap = new Map<string, string>();
      try {
        const packageRecord = triggerObject(body?.package, "Agent package");
        exactTriggerFields(
          packageRecord,
          [
            "schema", "mode", "kind", "exportedAt", "sourceLabel",
            "sourceProjectInstructions", "rootRef", "agents",
          ],
          "Agent package",
        );
        if (
          packageRecord.schema !== "ponderosa.agent-package.v1"
          || (
            packageRecord.mode !== "template"
            && packageRecord.mode !== "full"
          )
          || !Array.isArray(packageRecord.agents)
          || packageRecord.agents.length < 1
          || packageRecord.agents.length > 100
        ) {
          throw new Error("invalid Ponderosa Agent package");
        }
        if (
          typeof packageRecord.exportedAt !== "string"
          || !Number.isFinite(Date.parse(packageRecord.exportedAt))
          || typeof packageRecord.sourceLabel !== "string"
          || (
            packageRecord.sourceProjectInstructions !== undefined
            && typeof packageRecord.sourceProjectInstructions !== "string"
          )
        ) {
          throw new Error("Agent package metadata is invalid");
        }
        if (
          packageRecord.mode === "template"
          && packageRecord.sourceProjectInstructions !== undefined
        ) {
          throw new Error(
            "template packages cannot contain full-mode Project context",
          );
        }
        portablePackage = packageRecord as unknown as AgentPortablePackageDto;
        importSourceLabel = portablePackage.sourceLabel.slice(0, 240);
        const topologyError = portableAgentTopologyError(portablePackage);
        if (topologyError) throw new Error(topologyError);

        const elevatedAgentRefs: string[] = [];
        const sourceEngines = new Set<string>();
        for (const candidate of portablePackage.agents as unknown[]) {
          const node = triggerObject(candidate, "Agent package node");
          exactTriggerFields(
            node,
            [
              "ref", "title", "engine", "model", "effort",
              "initialInstructions", "managerRef", "managementPermissions",
              "history", "artifacts", "triggers",
            ],
            "Agent package node",
          );
          if (
            typeof node.ref !== "string"
            || typeof node.title !== "string"
            || typeof node.engine !== "string"
            || !node.engine.trim()
            || (node.model !== undefined && typeof node.model !== "string")
            || (node.effort !== undefined && typeof node.effort !== "string")
            || (
              node.initialInstructions !== undefined
              && typeof node.initialInstructions !== "string"
            )
          ) {
            throw new Error(
              "every imported Agent must declare valid identity and runtime fields",
            );
          }
          const permissions = triggerObject(
            node.managementPermissions,
            "managementPermissions",
          );
          exactTriggerFields(
            permissions,
            [
              "allowAutomaticDescendantDeletion",
              "allowAutomaticDescendantReorganization",
            ],
            "managementPermissions",
          );
          if (
            typeof permissions.allowAutomaticDescendantDeletion !== "boolean"
            || typeof permissions.allowAutomaticDescendantReorganization
              !== "boolean"
          ) {
            throw new Error(
              "every imported Agent must declare exact boolean management permissions",
            );
          }
          if (
            permissions.allowAutomaticDescendantDeletion
            || permissions.allowAutomaticDescendantReorganization
          ) elevatedAgentRefs.push(node.ref);
          sourceEngines.add(node.engine);
          if (
            portablePackage.mode === "template"
            && (
              node.history !== undefined
              || node.artifacts !== undefined
              || node.triggers !== undefined
            )
          ) {
            throw new Error(
              "template packages cannot contain history, artifacts, or Triggers",
            );
          }
          if (node.history !== undefined && !Array.isArray(node.history)) {
            throw new Error("Agent history must be an array");
          }
          for (
            const messageCandidate of
              (node.history as unknown[] | undefined) ?? []
          ) {
            const message = triggerObject(
              messageCandidate,
              "history message",
            );
            exactTriggerFields(
              message,
              ["role", "text", "createdAt"],
              "history message",
            );
            if (
              !["user", "assistant", "system"].includes(String(message.role))
              || typeof message.text !== "string"
              || (
                message.createdAt !== undefined
                && (
                  typeof message.createdAt !== "string"
                  || !Number.isFinite(Date.parse(message.createdAt))
                )
              )
            ) {
              throw new Error("Agent history messages have an invalid shape");
            }
          }
          if (node.artifacts !== undefined && !Array.isArray(node.artifacts)) {
            throw new Error("Agent artifacts must be an array");
          }
          if (node.triggers !== undefined && !Array.isArray(node.triggers)) {
            throw new Error("Agent Triggers must be an array");
          }
        }
        if (
          elevatedAgentRefs.length > 0
          && body.acknowledgeElevatedManagementPermissions !== true
        ) {
          return reply.code(409).send({
            error:
              "explicit acknowledgement is required to import autonomous destructive management permissions",
            elevatedAgentRefs,
          });
        }
        const missingMappings = [...sourceEngines].filter((engine) =>
          typeof body.engineMapping?.[engine] !== "string"
          || !body.engineMapping[engine]!.trim());
        if (missingMappings.length) {
          return reply.code(409).send({
            error: "explicit engine mapping is required",
            requiredEngines: missingMappings,
          });
        }
        for (const source of sourceEngines) {
          const target = body.engineMapping[source]!.trim();
          if (!engines.has(target)) {
            throw new Error(`mapped engine is not configured: ${target}`);
          }
        }

        let artifactBytes = 0;
        const reservedDestinationIds = new Set<string>();
        const artifactsByNode = new Map<string, PlannedArtifact[]>();
        for (const node of portablePackage.agents) {
          const plannedArtifacts: PlannedArtifact[] = [];
          for (const artifactCandidate of node.artifacts ?? []) {
            const artifact = triggerObject(
              artifactCandidate,
              "portable artifact",
            );
            exactTriggerFields(
              artifact,
              [
                "ref", "kind", "path", "summary", "createdAt", "mediaType",
                "visibility", "pinned", "sourcePath", "dataBase64",
              ],
              "portable artifact",
            );
            if (
              typeof artifact.ref !== "string"
              || !CANONICAL_ARTIFACT_ID.test(artifact.ref)
              || artifactRefMap.has(artifact.ref)
            ) {
              throw new Error(
                "artifact refs must be unique canonical identifiers",
              );
            }
            if (
              ![
                "diff", "test_report", "pr_summary", "log", "document",
                "screenshot", "generated_file",
              ].includes(String(artifact.kind))
              || typeof artifact.path !== "string"
              || !artifact.path
              || typeof artifact.createdAt !== "string"
              || !Number.isFinite(Date.parse(artifact.createdAt))
              || typeof artifact.dataBase64 !== "string"
              || (
                artifact.summary !== undefined
                && typeof artifact.summary !== "string"
              )
              || (
                artifact.mediaType !== undefined
                && typeof artifact.mediaType !== "string"
              )
              || (
                artifact.visibility !== undefined
                && artifact.visibility !== "project"
                && artifact.visibility !== "published"
              )
              || (
                artifact.pinned !== undefined
                && typeof artifact.pinned !== "boolean"
              )
              || (
                artifact.sourcePath !== undefined
                && typeof artifact.sourcePath !== "string"
              )
            ) {
              throw new Error(
                `artifact ${String(artifact.ref)} has an invalid shape`,
              );
            }
            const data = Buffer.from(artifact.dataBase64, "base64");
            if (
              data.toString("base64").replace(/=+$/u, "")
              !== artifact.dataBase64.replace(/=+$/u, "")
            ) {
              throw new Error(`artifact ${artifact.ref} has invalid data`);
            }
            artifactBytes += data.length;
            if (artifactBytes > 64 * 1024 * 1024) {
              return reply.code(413).send({
                error:
                  "portable Agent package artifacts exceed 64 MiB",
              });
            }
            let destinationId = artifact.ref;
            if (
              store.getProjectArtifact(project.id, destinationId)
              || reservedDestinationIds.has(destinationId)
              || (
                artifact.kind === "generated_file"
                && !/^[A-Za-z0-9_-]{1,128}$/u.test(destinationId)
              )
            ) {
              do destinationId = randomUUID();
              while (
                store.getProjectArtifact(project.id, destinationId)
                || reservedDestinationIds.has(destinationId)
              );
            }
            const extension = path.extname(artifact.path).toLowerCase()
              .slice(0, 16);
            const managedPath = `imported/${destinationId}${extension}`;
            const createdAt = new Date(artifact.createdAt).toISOString();
            const summary = artifact.summary?.trim()
              || path.basename(artifact.path).trim()
              || "Imported artifact";
            const mediaType = artifact.mediaType?.trim()
              || "application/octet-stream";
            const sha256 = createHash("sha256").update(data).digest("hex");
            if (
              artifact.kind === "generated_file"
              && !generatedArtifactMetadataIsValid({
                id: destinationId,
                projectId: project.id,
                agentId: project.id,
                originAgentId: project.id,
                kind: "generated_file",
                path: managedPath,
                ...(artifact.sourcePath
                  ? { sourcePath: artifact.sourcePath }
                  : {}),
                summary,
                createdAt,
                mediaType,
                size: data.length,
                sha256,
              })
            ) {
              throw new Error(
                `generated artifact ${artifact.ref} has invalid immutable metadata`,
              );
            }
            artifactRefMap.set(artifact.ref, destinationId);
            reservedDestinationIds.add(destinationId);
            plannedArtifacts.push({
              ...(artifactCandidate as PlannedArtifact),
              data,
              destinationId,
              managedPath,
              createdAt,
              summary,
              mediaType,
              sha256,
            });
          }
          artifactsByNode.set(node.ref, plannedArtifacts);
        }

        importNodes = portablePackage.agents.map((node) => {
          const targetEngine = body.engineMapping[node.engine]!.trim();
          const model = node.model?.trim() || undefined;
          const effort = node.effort?.trim() || undefined;
          const importAdapter = engines.get(targetEngine)!.adapter;
          const selectionError = runtimeSelectionError(
            importAdapter,
            model,
            effort,
            cachedModelOptions(importAdapter, project.id),
          );
          if (selectionError) {
            throw new Error(`${node.title}: ${selectionError}`);
          }
          const history = [
            ...(node.initialInstructions
              ? [{
                  role: "system" as const,
                  text:
                    `Imported initial instructions:\n${node.initialInstructions}`,
                  createdAt: new Date(portablePackage.exportedAt).toISOString(),
                }]
              : []),
            ...(node.history ?? []).map((message) => ({
              ...message,
              ...(message.createdAt
                ? { createdAt: new Date(message.createdAt).toISOString() }
                : {}),
            })),
          ].map((message) => ({
            ...message,
            text: rewritePortableArtifactReferences(
              message.text,
              artifactRefMap,
            ).slice(0, 100_000),
          }));
          const triggers = (node.triggers ?? []).map(
            (candidate): PlannedTrigger => {
              const trigger = triggerObject(candidate, "portable Trigger");
              exactTriggerFields(
                trigger,
                [
                  "name", "instructions", "sourceKind", "sourceConfig",
                  "enabled", "runBudget",
                ],
                "portable Trigger",
              );
              const parsed = parseCreateTrigger({
                ...trigger,
                conversationId: conversation.id,
              });
              if (candidate.enabled !== false) {
                throw new Error(
                  "imported Triggers must be explicitly disabled",
                );
              }
              if (
                !parsed.name.trim()
                || parsed.name.trim().length > 120
                || !parsed.instructions.trim()
                || parsed.instructions.trim().length > 20_000
              ) {
                throw new Error(
                  "imported Trigger name or instructions exceed supported limits",
                );
              }
              if (
                parsed.runBudget
                && (
                  !Number.isSafeInteger(parsed.runBudget.limit)
                  || parsed.runBudget.limit < 1
                  || parsed.runBudget.limit > 1_000_000
                )
              ) {
                throw new Error(
                  "Trigger Run budget limit must be an integer between 1 and 1000000",
                );
              }
              const schedule = parsed.sourceKind === "schedule"
                ? parsed.sourceConfig as TriggerScheduleConfig
                : undefined;
              const oneTime = schedule?.scheduleKind === "once";
              const validationTime = oneTime
                ? new Date(Date.parse(schedule.at) - 1)
                : new Date();
              const normalized = normalizeTriggerSourceConfig(
                parsed.sourceKind,
                parsed.sourceConfig,
                validationTime,
              );
              return {
                name: parsed.name.trim(),
                instructions: parsed.instructions.trim(),
                sourceKind: parsed.sourceKind,
                sourceConfig: normalized.config,
                ...(parsed.runBudget ? { runBudget: parsed.runBudget } : {}),
                ...(
                  !oneTime && normalized.nextFireAt
                    ? { nextFireAt: normalized.nextFireAt }
                    : {}
                ),
              };
            },
          );
          if (
            triggers.length > 100
            || triggers.filter((trigger) =>
              trigger.sourceKind === "filesystem").length > 25
          ) {
            throw new Error("imported Agent exceeds supported Trigger limits");
          }
          return {
            ...node,
            title: node.title.trim().slice(0, 80) || "Imported Agent",
            targetEngine,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            history,
            artifacts: artifactsByNode.get(node.ref) ?? [],
            triggers,
          };
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error
            ? error.message
            : "invalid Ponderosa Agent package",
        });
      }

      // Every deterministic decision is complete before the first mutation.
      if (deletingProjectIds.has(project.id)) {
        throw new Error("Project deletion is already in progress");
      }
      const plannedArtifacts = importNodes.flatMap((node) => node.artifacts);
      await publishManagedArtifactContents(
        context.dataDir,
        project.id,
        plannedArtifacts.map((artifact) => ({
          artifactId: artifact.destinationId,
          input: artifact.data,
        })),
      );

      const created = new Map<string, AgentDto>();
      for (const node of importNodes) {
        if (deletingProjectIds.has(project.id)) {
          throw new Error("Project deletion is already in progress");
        }
        const agent = store.createAgent(project.id, {
          title: node.title,
          engine: node.targetEngine,
          conversationId: conversation.id,
          ...(node.model ? { model: node.model } : {}),
          ...(node.effort ? { effort: node.effort } : {}),
          managementPermissions: node.managementPermissions,
        });
        created.set(node.ref, agent);
      }

      const catalogArtifacts: Array<{
        artifact: Parameters<AgentStore["recordProjectArtifact"]>[0];
      }> = [];
      for (const node of importNodes) {
        const agent = created.get(node.ref)!;
        for (const artifact of node.artifacts) {
          const catalogArtifact = {
            id: artifact.destinationId,
            projectId: project.id,
            agentId: agent.id,
            originAgentId: agent.id,
            kind: artifact.kind,
            path: artifact.managedPath,
            summary: artifact.summary,
            createdAt: artifact.createdAt,
            mediaType: artifact.mediaType,
            visibility: artifact.visibility ?? "project",
            pinned: artifact.pinned ?? false,
            ...(artifact.sourcePath
              ? { sourcePath: artifact.sourcePath }
              : {}),
            size: artifact.data.length,
            sha256: artifact.sha256,
          };
          if (catalogArtifact.kind === "generated_file") {
            assets.registerGeneratedArtifact(
              catalogArtifact as RegisteredGeneratedArtifact,
            );
          }
          catalogArtifacts.push({ artifact: catalogArtifact });
        }
      }
      store.recordProjectArtifacts(catalogArtifacts);

      for (const node of importNodes) {
        const agent = created.get(node.ref)!;
        if (node.history.length) {
          store.setImportedHistory(
            agent.id,
            importSourceLabel,
            node.history,
          );
        }
      }
      for (const node of importNodes) {
        if (node.managerRef) {
          store.updateAgentOrganization(
            created.get(node.ref)!.id,
            { managerAgentId: created.get(node.managerRef)!.id },
          );
        }
      }
      for (const node of importNodes) {
        for (const importedTrigger of node.triggers) {
          const agent = created.get(node.ref)!;
          const webhookSecret = importedTrigger.sourceKind === "webhook"
            ? triggerSources.createWebhookSecret()
            : undefined;
          coordinationV3.createTriggerDefinition({
            projectId: project.id,
            conversationId: conversation.id,
            agentId: agent.id,
            name: importedTrigger.name,
            instructions: importedTrigger.instructions,
            sourceKind: importedTrigger.sourceKind,
            sourceConfig: importedTrigger.sourceConfig,
            enabled: false,
            runBudget: importedTrigger.runBudget,
            nextFireAt: importedTrigger.nextFireAt,
            secretCiphertext: webhookSecret?.ciphertext,
            secretFingerprint: webhookSecret?.fingerprint,
          });
        }
      }
      await triggerSources.refresh();
      appendWorkspace({
        type: "project_changed",
        projectId: project.id,
        action: "updated",
      });
      const response: ImportAgentPackageResponse = {
        rootAgentId: created.get(portablePackage.rootRef)!.id,
        agentIds: [...created.values()].map((agent) => agent.id),
      };
      return reply.code(201).send(response);
  };

  app.post<{
    Params: { id: string };
    Body: ImportAgentPackageRequest;
  }>(
    "/api/projects/:id/import-agents",
    { bodyLimit: 96 * 1024 * 1024 },
    (request, reply) => importPackage(request.params.id, request.body, reply),
  );

  app.post<{
    Params: { id: string };
    Body: Buffer;
  }>(
    "/api/projects/:id/import-agent-package",
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      const separator = request.body.indexOf(0x0a);
      if (separator < 1 || separator > 16 * 1024) {
        return reply.code(400).send({
          error: "Agent package upload metadata is invalid",
        });
      }
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const metadata = JSON.parse(
          decoder.decode(request.body.subarray(0, separator)),
        ) as Omit<ImportAgentPackageRequest, "package">;
        const portable = JSON.parse(
          decoder.decode(request.body.subarray(separator + 1)),
        ) as AgentPortablePackageDto;
        return importPackage(
          request.params.id,
          { ...metadata, package: portable },
          reply,
        );
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error
            ? error.message
            : "invalid Ponderosa Agent package",
        });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: CopyAgentPackageRequest;
  }>(
    "/api/projects/:id/copy-agent",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const sourceAgentId = request.body?.sourceAgentId?.trim();
      const conversationId = request.body?.conversationId?.trim();
      if (
        !sourceAgentId
        || !conversationId
        || (
          request.body.organization !== undefined
          && typeof request.body.organization !== "boolean"
        )
        || (
          request.body.acknowledgeElevatedManagementPermissions !== undefined
          && typeof request.body.acknowledgeElevatedManagementPermissions
            !== "boolean"
        )
      ) {
        return reply.code(400).send({
          error: "copy request fields are invalid",
        });
      }
      const source = store.getAgent(sourceAgentId);
      if (!source) return reply.code(404).send({ error: "agent not found" });
      const portable = await buildPortablePackage(
        source.id,
        "full",
        request.body.organization === true,
      );
      const engineMapping = Object.fromEntries(
        [...new Set(portable.agents.map((node) => node.engine))]
          .map((engineId) => [engineId, engineId]),
      );
      return importPackage(
        request.params.id,
        {
          package: portable,
          conversationId,
          engineMapping,
          ...(request.body.acknowledgeElevatedManagementPermissions === true
            ? { acknowledgeElevatedManagementPermissions: true }
            : {}),
        },
        reply,
      );
    },
  );
}
