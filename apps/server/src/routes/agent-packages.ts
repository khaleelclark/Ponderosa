import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentImportOperationDto,
  AgentImportPhase,
  AgentDto,
  AgentExportMode,
  AgentPortablePackageDto,
  Adapter,
  CopyAgentPackageRequest,
  ImportAgentPackageRequest,
  ImportAgentPackageResponse,
  ModelOption,
} from "@ponderosa/core";
import {
  openManagedArtifactContent,
  publishManagedArtifactContentsAsync,
  removeManagedArtifactContent,
  type AgentStore,
  type CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { createOperationalNotifications } from "../operational-notifications.js";
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
  exactTriggerFields,
  triggerObject,
} from "../trigger-validation.js";
import {
  decodePortableArtifact,
  encodePortableArtifact,
  parsePortablePackageUpload,
  stringifyPortablePackage,
} from "../agent-package-codec.js";

interface AgentPackageRoutesContext {
  dataDir: string;
  store: AgentStore;
  coordination: CoordinationV3Store;
  assets: AssetStore;
  engines: ReadonlyMap<string, { adapter: Adapter }>;
  deletingProjectIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[];
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
  createOperationalNotification: ReturnType<
    typeof createOperationalNotifications
  >["createOperationalNotification"];
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
    deletingConversationIds,
    cachedModelOptions,
    appendWorkspace,
    agentMessages,
    createOperationalNotification,
  } = context;
  const blobImportContentType = "application/vnd.ponderosa.agent-import";
  const importOperationDirectory = path.join(context.dataDir, "agent-import-operations");
  const operationPath = (id: string) => path.join(importOperationDirectory, `${id}.json`);
  const payloadPath = (id: string) => path.join(importOperationDirectory, `${id}.payload`);
  const operationByRequest = new Map<string, string>();
  const operationCache = new Map<string, AgentImportOperationDto>();
  const requestOperationKey = (projectId: string, requestId: string) =>
    `${projectId}:${requestId}`;
  const writeOperation = async (operation: AgentImportOperationDto): Promise<void> => {
    operationCache.set(operation.id, operation);
    operationByRequest.set(
      requestOperationKey(operation.projectId, operation.requestId),
      operation.id,
    );
    await fs.mkdir(importOperationDirectory, { recursive: true });
    const temporary = `${operationPath(operation.id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(operation), { mode: 0o600 });
    await fs.rename(temporary, operationPath(operation.id));
  };
  const readOperation = async (id: string): Promise<AgentImportOperationDto | undefined> => {
    if (!/^[0-9a-f-]{36}$/u.test(id)) return undefined;
    try {
      return JSON.parse(await fs.readFile(operationPath(id), "utf8")) as AgentImportOperationDto;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
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
          ? agent.conversationId === event.conversationId
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
        const runtimeIdentity = runtimeArtifact?.projectId === agent.projectId &&
          assets.authoritativeRuntimeArtifactMetadata(
            agent.projectId,
            runtimeArtifact,
          )
          ? {
              size: runtimeArtifact.byteLength,
              sha256: runtimeArtifact.blobHash,
            }
          : undefined;
        const generatedIdentity =
          artifact.kind === "generated_file" &&
          assets.authoritativeGeneratedArtifactMetadata(
            agent.projectId,
            artifact,
          ) &&
          artifact.size &&
          artifact.sha256
            ? { size: artifact.size, sha256: artifact.sha256 }
            : undefined;
        const fallbackIdentity =
          !runtimeIdentity && !generatedIdentity &&
          artifact.size && artifact.sha256
            ? { size: artifact.size, sha256: artifact.sha256 }
            : undefined;
        const identity =
          runtimeIdentity ?? generatedIdentity ?? fallbackIdentity;
        const opened = identity
          ? await openManagedArtifactContent(
              context.dataDir,
              agent.projectId,
              artifact.id,
              identity.size,
              identity.sha256,
            )
          : undefined;
        if (!opened) {
          throw new AssetError(
            409,
            `artifact ${artifact.id} content is unavailable or changed`,
          );
        }
        let data: Buffer;
        try {
          data = await opened.readRange(identity!.size);
        } finally {
          await opened.close();
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
          dataBase64: await encodePortableArtifact(data),
        };
      }));
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
    return reply
      .type("application/json; charset=utf-8")
      .send(await stringifyPortablePackage(result));
  });

  const importPackage = async (
    projectId: string,
    body: ImportAgentPackageRequest,
    reply: FastifyReply,
    onPhase?: (phase: AgentImportPhase) => Promise<void>,
  ): Promise<unknown> => {
      await onPhase?.("creating_records");
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
      if (!conversation || conversation.projectId !== project.id ||
          conversation.archived || deletingConversationIds.has(conversation.id)) {
        return reply.code(400).send({
          error: "an active destination Project Chat is required",
        });
      }
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
        "artifacts" | "history"
      > & {
        targetEngine: string;
        model?: string;
        effort?: string;
        history: NonNullable<
          AgentPortablePackageDto["agents"][number]["history"]
        >;
        artifacts: PlannedArtifact[];
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
              "history", "artifacts",
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
            )
          ) {
            throw new Error(
              "template packages cannot contain history or artifacts",
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
            const { data, sha256 } = await decodePortableArtifact(
              artifact.dataBase64,
            );
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
          return {
            ...node,
            title: node.title.trim().slice(0, 80) || "Imported Agent",
            targetEngine,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            history,
            artifacts: artifactsByNode.get(node.ref) ?? [],
          };
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error
            ? error.message
            : "invalid Ponderosa Agent package",
        });
      }

      const activeDestinationConversation = () => {
        const current = store.getConversation(conversation.id);
        return current?.projectId === project.id && !current.archived &&
          !deletingConversationIds.has(current.id)
          ? current
          : undefined;
      };
      const removeUncataloguedPublications = (
        artifacts: readonly PlannedArtifact[],
      ) => {
        for (const artifact of artifacts) {
          if (store.getProjectArtifact(project.id, artifact.destinationId)) continue;
          try {
            removeManagedArtifactContent(
              context.dataDir,
              project.id,
              artifact.destinationId,
              artifact.data.length,
              artifact.sha256,
            );
          } catch {
            // Startup repair removes any exact, uncatalogued publication that
            // could not be reclaimed here without obscuring the Chat conflict.
          }
        }
      };

      // Every deterministic decision is complete before the first mutation.
      if (deletingProjectIds.has(project.id)) {
        throw new Error("Project deletion is already in progress");
      }
      if (!activeDestinationConversation()) {
        return reply.code(409).send({
          error: "The destination Chat is no longer active",
        });
      }
      const plannedArtifacts = importNodes.flatMap((node) => node.artifacts);
      await onPhase?.("importing_artifacts");
      const publishedArtifacts = await publishManagedArtifactContentsAsync(
        context.dataDir,
        project.id,
        plannedArtifacts.map((artifact) => ({
          artifactId: artifact.destinationId,
          input: artifact.data,
        })),
      );
      const publicationById = new Map(
        plannedArtifacts.map((artifact, index) => [
          artifact.destinationId,
          publishedArtifacts[index]!,
        ]),
      );

      if (deletingProjectIds.has(project.id) ||
          !activeDestinationConversation()) {
        removeUncataloguedPublications(plannedArtifacts);
        return reply.code(409).send({
          error: deletingProjectIds.has(project.id)
            ? "Project deletion is already in progress"
            : "The destination Chat is no longer active",
        });
      }

      const created = new Map<string, AgentDto>();
      await onPhase?.("importing_agents");
      for (const node of importNodes) {
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
            assets.registerPublishedGeneratedArtifact(
              catalogArtifact as RegisteredGeneratedArtifact,
              publicationById.get(artifact.destinationId)!,
            );
          }
          catalogArtifacts.push({ artifact: catalogArtifact });
        }
      }
      store.recordProjectArtifacts(catalogArtifacts);

      await onPhase?.("importing_history");
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
      await onPhase?.("finalizing");
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
    { bodyLimit: 1024 * 1024 },
    (request, reply) => importPackage(request.params.id, request.body, reply),
  );

  const runBackgroundImport = async (operationId: string): Promise<void> => {
    let operation = await readOperation(operationId);
    if (!operation || operation.status !== "pending") return;
    const update = async (patch: Partial<AgentImportOperationDto>) => {
      operation = { ...operation!, ...patch, updatedAt: new Date().toISOString() };
      await writeOperation(operation);
      return operation;
    };
    const phase = async (next: AgentImportPhase) => {
      await update({ phase: next });
      createOperationalNotification({
        dedupeKey: `agent-import:${operationId}`,
        category: "system",
        severity: "info",
        title: "Agent import in progress",
        body: next.replaceAll("_", " "),
        projectId: operation!.projectId,
        action: { kind: "open_project", targetId: operation!.projectId },
      });
    };
    try {
      const raw = await fs.readFile(payloadPath(operationId));
      const { metadata, portable } = await parsePortablePackageUpload(raw);
      await update({ sourceLabel: portable.sourceLabel.slice(0, 240) });
      let statusCode = 200;
      let responseBody: unknown;
      const backgroundReply = {
        code(code: number) {
          statusCode = code;
          return this;
        },
        send(value: unknown) {
          responseBody = value;
          return value;
        },
      } as unknown as FastifyReply;
      await importPackage(
        operation.projectId,
        { ...metadata, package: portable },
        backgroundReply,
        phase,
      );
      if (statusCode >= 400) {
        const record = responseBody && typeof responseBody === "object"
          ? responseBody as { error?: unknown }
          : undefined;
        throw new Error(typeof record?.error === "string" ? record.error : "Import failed");
      }
      const result = responseBody as ImportAgentPackageResponse;
      await update({ phase: "completed", status: "completed", result });
      createOperationalNotification({
        dedupeKey: `agent-import:${operationId}`,
        category: "system",
        severity: "info",
        title: "Agent import completed",
        body: `${operation.sourceLabel} was imported successfully.`,
        projectId: operation.projectId,
        agentId: result.rootAgentId,
        action: { kind: "open_agent", targetId: result.rootAgentId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      await update({ phase: "failed", status: "failed", error: message.slice(0, 1_000) });
      createOperationalNotification({
        dedupeKey: `agent-import:${operationId}`,
        category: "system",
        severity: "urgent",
        title: "Agent import failed",
        body: `${operation.sourceLabel}: ${message}`.slice(0, 1_000),
        projectId: operation.projectId,
        action: { kind: "open_project", targetId: operation.projectId },
      });
    } finally {
      await fs.unlink(payloadPath(operationId)).catch(() => undefined);
    }
  };

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: Buffer;
  }>(
    "/api/projects/:id/agent-import-operations",
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      if (!store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Project deletion is already in progress" });
      }
      const requestId = request.headers["idempotency-key"]?.trim();
      if (!requestId || !/^[A-Za-z0-9_-]{8,128}$/u.test(requestId)) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      const requestKey = requestOperationKey(request.params.id, requestId);
      const existingId = operationByRequest.get(requestKey);
      if (existingId) {
        const existing = operationCache.get(existingId) ?? await readOperation(existingId);
        if (existing) {
          return reply.code(existing.status === "pending" ? 202 : 200).send(existing);
        }
        operationByRequest.delete(requestKey);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const operation: AgentImportOperationDto = {
        id,
        requestId,
        projectId: request.params.id,
        sourceLabel: "Agent import",
        phase: "queued",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      operationByRequest.set(requestKey, id);
      operationCache.set(id, operation);
      try {
        await fs.mkdir(importOperationDirectory, { recursive: true });
        await fs.writeFile(payloadPath(id), request.body, { mode: 0o600, flag: "wx" });
        await writeOperation(operation);
      } catch (error) {
        operationByRequest.delete(requestKey);
        operationCache.delete(id);
        await fs.unlink(payloadPath(id)).catch(() => undefined);
        throw error;
      }
      createOperationalNotification({
        dedupeKey: `agent-import:${id}`,
        category: "system",
        severity: "info",
        title: "Agent import queued",
        body: "The import continues in the background.",
        projectId: operation.projectId,
        action: { kind: "open_project", targetId: operation.projectId },
      });
      setImmediate(() => void runBackgroundImport(id));
      return reply.code(202).send(operation);
    },
  );

  app.get<{ Params: { id: string; operationId: string } }>(
    "/api/projects/:id/agent-import-operations/:operationId",
    async (request, reply) => {
      const operation = operationCache.get(request.params.operationId)
        ?? await readOperation(request.params.operationId);
      if (!operation || operation.projectId !== request.params.id) {
        return reply.code(404).send({ error: "import operation not found" });
      }
      return operation;
    },
  );

  void fs.mkdir(importOperationDirectory, { recursive: true }).then(async () => {
    const names = await fs.readdir(importOperationDirectory);
    for (const name of names.filter(candidate => candidate.endsWith(".json"))) {
      const operation = await readOperation(name.slice(0, -5));
      if (!operation) continue;
      operationByRequest.set(
        requestOperationKey(operation.projectId, operation.requestId),
        operation.id,
      );
      if (operation.status !== "pending") continue;
      const failed: AgentImportOperationDto = {
        ...operation,
        phase: "failed",
        status: "failed",
        error: "The server restarted before final import completion could be confirmed. Inspect the Project before retrying.",
        updatedAt: new Date().toISOString(),
      };
      await writeOperation(failed);
      createOperationalNotification({
        dedupeKey: `agent-import:${failed.id}`,
        category: "system",
        severity: "urgent",
        title: "Agent import outcome needs inspection",
        body: failed.error!,
        projectId: failed.projectId,
        action: { kind: "open_project", targetId: failed.projectId },
      });
    }
  }).catch(() => undefined);

  app.post<{
    Params: { id: string };
    Body: Buffer;
  }>(
    "/api/projects/:id/import-agent-package",
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const { metadata, portable } = await parsePortablePackageUpload(
          request.body,
        );
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
          request.body.mode !== undefined
          && request.body.mode !== "template"
          && request.body.mode !== "full"
        )
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
        request.body.mode ?? "full",
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
