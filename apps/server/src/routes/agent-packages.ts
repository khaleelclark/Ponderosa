import { createHash, randomUUID } from "node:crypto";
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
  readManagedArtifactContent,
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
  deletingAgentIds: Set<string>;
  agentCreationConversationLeases: Map<string, number>;
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
    deletingAgentIds,
    agentCreationConversationLeases,
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
  const projectImportTails = new Map<string, Promise<void>>();
  const withProjectImportLock = async <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const previous = projectImportTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    projectImportTails.set(projectId, tail);
    await previous.catch(() => undefined);
    try { return await work(); } finally {
      release();
      if (projectImportTails.get(projectId) === tail) projectImportTails.delete(projectId);
    }
  };
  const requestOperationKey = (projectId: string, requestId: string) =>
    `${projectId}:${requestId}`;
  const validIdempotencyKey = (value: string | undefined): string | undefined => {
    const key = value?.trim();
    return key && /^[A-Za-z0-9_-]{8,128}$/u.test(key) ? key : undefined;
  };
  const writeOperation = async (operation: AgentImportOperationDto): Promise<void> => {
    await fs.mkdir(importOperationDirectory, { recursive: true });
    const finalPath = operationPath(operation.id);
    const previous = await fs.readFile(finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    let installed = false;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(operation));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, finalPath);
      installed = true;
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      if (installed) {
        try {
          if (previous) {
            const rollback = `${finalPath}.${randomUUID()}.tmp`;
            const handle = await fs.open(rollback, "wx", 0o600);
            try {
              await handle.writeFile(previous);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(rollback, finalPath);
          } else {
            await fs.unlink(finalPath);
          }
          if (process.platform !== "win32") {
            const directory = await fs.open(importOperationDirectory, "r");
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } catch (rollbackError) {
          const recovered = await readOperation(operation.id).catch(() => undefined);
          if (recovered && JSON.stringify(recovered) === JSON.stringify(operation)) {
            operationCache.set(recovered.id, recovered);
            operationByRequest.set(
              requestOperationKey(recovered.projectId, recovered.requestId),
              recovered.id,
            );
            return;
          }
          throw new AggregateError([error, rollbackError], "Import operation durability and rollback both failed");
        }
      }
      throw error;
    }
    operationCache.set(operation.id, operation);
    operationByRequest.set(
      requestOperationKey(operation.projectId, operation.requestId),
      operation.id,
    );
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
  const operationHydration = fs.mkdir(importOperationDirectory, { recursive: true })
    .then(async () => {
      const names = await fs.readdir(importOperationDirectory);
      for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
        const operation = await readOperation(name.slice(0, -5));
        if (!operation) continue;
        operationCache.set(operation.id, operation);
        operationByRequest.set(
          requestOperationKey(operation.projectId, operation.requestId),
          operation.id,
        );
      }
      const durableIds = new Set(operationCache.keys());
      let cleaned = false;
      for (const name of names) {
        const payloadMatch = /^([0-9a-f-]{36})\.payload$/u.exec(name);
        const temporary = name.endsWith(".tmp");
        if (!temporary && (!payloadMatch ||
            (durableIds.has(payloadMatch[1]!) &&
              operationCache.get(payloadMatch[1]!)?.status === "pending"))) continue;
        await fs.unlink(path.join(importOperationDirectory, name))
          .then(() => { cleaned = true; })
          .catch(() => undefined);
      }
      if (cleaned && process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    });
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
    if (!root || store.agentCreationPending(agentId)) throw new AssetError(404, "agent not found");
    // Context packages were an early V3.3 spelling of a full portable Agent.
    const mode: AgentExportMode = requestedMode === "context" ? "full" : requestedMode;
    const nodes = organization
      ? store.listAgentSubtree(root.id)
      : [root];
    if (nodes.some((agent) => store.agentCreationPending(agent.id))) {
      throw new AssetError(409, "Agent creation is still being recovered");
    }
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
                  : event.audience.kind === "user_agents" && event.audience.agentIds.includes(agent.id))
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
    creationOperationId?: string,
    creationRequest?: { idempotencyKey: string; payloadHash: string },
  ): Promise<unknown> => withProjectImportLock(projectId, async () => {
      let importBody: Record<string, unknown>;
      try {
        importBody = triggerObject(body, "Agent import request");
        exactTriggerFields(
          importBody,
          ["package", "conversationId", "engineMapping", "acknowledgeElevatedManagementPermissions"],
          "Agent import request",
        );
        if (typeof importBody.conversationId !== "string" ||
            !importBody.engineMapping || typeof importBody.engineMapping !== "object" ||
            Array.isArray(importBody.engineMapping) ||
            Object.values(importBody.engineMapping as Record<string, unknown>)
              .some((value) => typeof value !== "string") ||
            (importBody.acknowledgeElevatedManagementPermissions !== undefined &&
              typeof importBody.acknowledgeElevatedManagementPermissions !== "boolean")) {
          throw new Error("Agent import request fields are invalid");
        }
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid Agent import request",
        });
      }
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
      if (!creationOperationId) {
        if (!creationRequest) throw new Error("Agent import idempotency identity is required");
        try {
          creationOperationId = store.beginAgentCreationOperation({
            projectId,
            actorScope: "user:local-operator",
            kind: "import",
            idempotencyKey: creationRequest.idempotencyKey,
            payloadHash: creationRequest.payloadHash,
          }).operation.id;
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error ? error.message : "Agent import replay conflict",
          });
        }
      }
      const durableOperation = store.getAgentCreationOperation(creationOperationId);
      if (!durableOperation) throw new Error("Agent import creation operation is unavailable");
      if (durableOperation.status === "completed" && durableOperation.result) {
        return reply.code(200).send(durableOperation.result);
      }
      if (durableOperation.status === "canonical_committed" || durableOperation.status === "rolling_back") {
        return reply.code(409).send({
          error: "A prior import attempt is still being recovered; retry after recovery completes",
          operationId: durableOperation.id,
        });
      }
      const abandonMutationFreeOperation = (reason: string) => {
        const current = store.getAgentCreationOperation(durableOperation.id);
        if (!current || current.agentIds.some((agentId) => store.getAgent(agentId))) return;
        store.updateAgentCreationOperation(current.id, {
          status: "rolled_back",
          lastError: reason,
        });
        for (const agentId of current.agentIds) deletingAgentIds.delete(agentId);
      };
      agentCreationConversationLeases.set(
        conversation.id,
        (agentCreationConversationLeases.get(conversation.id) ?? 0) + 1,
      );
      let creationLeaseReleased = false;
      const releaseCreationLease = () => {
        if (creationLeaseReleased) return;
        creationLeaseReleased = true;
        const remaining = (agentCreationConversationLeases.get(conversation.id) ?? 1) - 1;
        if (remaining > 0) agentCreationConversationLeases.set(conversation.id, remaining);
        else agentCreationConversationLeases.delete(conversation.id);
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

      const rollbackAgentIds: string[] = [];
      let operationAgentIds: string[] = [];
      let rollbackArtifacts: PlannedArtifact[] = [];
      try {
      await onPhase?.("creating_records");

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
          abandonMutationFreeOperation("elevated management permissions were not acknowledged");
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
          abandonMutationFreeOperation("required engine mappings were not supplied");
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
        let artifactPosition = 0;
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
              abandonMutationFreeOperation("portable Agent package artifacts exceed 64 MiB");
              return reply.code(413).send({
                error:
                  "portable Agent package artifacts exceed 64 MiB",
              });
            }
            const replayDestinationId = durableOperation.artifactIds[artifactPosition];
            let destinationId = replayDestinationId ?? artifact.ref;
            if (!replayDestinationId && (
              store.getProjectArtifact(project.id, destinationId)
              || reservedDestinationIds.has(destinationId)
              || (
                artifact.kind === "generated_file"
                && !/^[A-Za-z0-9_-]{1,128}$/u.test(destinationId)
              )
            )) {
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
            artifactPosition += 1;
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
        if (durableOperation.artifactIds.length > 0 &&
            durableOperation.artifactIds.length !== artifactPosition) {
          throw new Error("Agent import artifact recovery plan does not match the package");
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
        abandonMutationFreeOperation(error instanceof Error ? error.message : "invalid Ponderosa Agent package");
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
      ): boolean => {
        let removed = true;
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
            if (readManagedArtifactContent(
              context.dataDir,
              project.id,
              artifact.destinationId,
              artifact.data.length,
              artifact.sha256,
            )) removed = false;
          } catch {
            removed = false;
          }
        }
        return removed;
      };

      // Every deterministic decision is complete before the first mutation.
      if (deletingProjectIds.has(project.id)) {
        throw new Error("Project deletion is already in progress");
      }
      if (!activeDestinationConversation()) {
        abandonMutationFreeOperation("The destination Chat is no longer active");
        return reply.code(409).send({
          error: "The destination Chat is no longer active",
        });
      }
      const plannedArtifacts = importNodes.flatMap((node) => node.artifacts);
      rollbackArtifacts = plannedArtifacts;
      if (creationOperationId) {
        const creationOperation = store.getAgentCreationOperation(creationOperationId);
        if (!creationOperation) throw new Error("Agent import creation operation is unavailable");
        if (creationOperation.agentIds.length === 0) {
          operationAgentIds = importNodes.map(() => randomUUID());
          operationAgentIds.forEach((agentId, position) => {
            store.addAgentCreationOperationMember(creationOperationId!, agentId, position);
            deletingAgentIds.add(agentId);
          });
          store.updateAgentCreationOperation(creationOperationId!, {
            artifactIds: plannedArtifacts.map((artifact) => artifact.destinationId),
            artifactIdentities: plannedArtifacts.map((artifact) => ({
              id: artifact.destinationId,
              byteLength: artifact.data.length,
              sha256: artifact.sha256,
            })),
          });
        } else {
          if (creationOperation.agentIds.length !== importNodes.length) {
            throw new Error("Agent import creation plan does not match the package");
          }
          operationAgentIds = creationOperation.agentIds;
          for (const agentId of operationAgentIds) deletingAgentIds.add(agentId);
        }
      }
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
        const rollbackComplete = removeUncataloguedPublications(plannedArtifacts);
        const reason = deletingProjectIds.has(project.id)
          ? "Project deletion is already in progress"
          : "The destination Chat is no longer active";
        if (rollbackComplete) abandonMutationFreeOperation(reason);
        else store.updateAgentCreationOperation(durableOperation.id, {
          status: "rolling_back",
          lastError: `${reason}; published artifact cleanup remains pending`,
        });
        return reply.code(409).send({
          error: reason,
        });
      }

      const created = new Map<string, AgentDto>();
      await onPhase?.("importing_agents");
      for (const [index, node] of importNodes.entries()) {
        const agent = store.createAgent(project.id, {
          title: node.title,
          engine: node.targetEngine,
          conversationId: conversation.id,
          ...(node.model ? { model: node.model } : {}),
          ...(node.effort ? { effort: node.effort } : {}),
          managementPermissions: node.managementPermissions,
        }, undefined, operationAgentIds[index]);
        created.set(node.ref, agent);
        rollbackAgentIds.push(agent.id);
        deletingAgentIds.add(agent.id);
      }

      const catalogArtifacts: Array<{
        artifact: Parameters<AgentStore["recordProjectArtifact"]>[0];
      }> = [];
      await onPhase?.("importing_history");
      await onPhase?.("finalizing");
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
      for (const { artifact } of catalogArtifacts) {
        if (artifact.kind !== "generated_file") continue;
        assets.registerPublishedGeneratedArtifact(
          artifact as RegisteredGeneratedArtifact,
          publicationById.get(artifact.id)!,
        );
      }
      try {
        appendWorkspace({
          type: "project_changed",
          projectId: project.id,
          action: "updated",
        });
      } catch {
        // Clients reconcile the durable import on their next refresh.
      }
      const response: ImportAgentPackageResponse = {
        rootAgentId: created.get(portablePackage.rootRef)!.id,
        agentIds: [...created.values()].map((agent) => agent.id),
      };
      if (creationOperationId) {
        store.updateAgentCreationOperation(creationOperationId, {
          status: "completed",
          result: response,
          lastError: null,
        });
        for (const agentId of operationAgentIds) deletingAgentIds.delete(agentId);
      }
      return reply.code(201).send(response);
      } catch (error) {
        let rollbackComplete = true;
        for (const agentId of [...rollbackAgentIds].reverse()) {
          try {
            if (!store.deleteAgent(agentId, (id) => coordinationV3.handleAgentDeletion(id)) &&
                store.getAgent(agentId)) rollbackComplete = false;
          } catch {
            rollbackComplete = false;
            // Preserve the original import failure. Startup deletion recovery
            // completes any rollback whose durable deletion already committed.
          }
        }
        for (const artifact of rollbackArtifacts) {
          try {
            const catalogued = store.getProjectArtifact(project.id, artifact.destinationId);
            if (catalogued && (!catalogued.originAgentId ||
                !operationAgentIds.includes(catalogued.originAgentId))) {
              continue;
            }
            if (catalogued) {
              store.deleteProjectArtifact(project.id, artifact.destinationId, "Agent import rolled back");
            }
            if (store.getProjectArtifact(project.id, artifact.destinationId)) {
              rollbackComplete = false;
            } else {
              removeManagedArtifactContent(
                context.dataDir,
                project.id,
                artifact.destinationId,
                artifact.data.length,
                artifact.sha256,
              );
              if (readManagedArtifactContent(
                context.dataDir,
                project.id,
                artifact.destinationId,
                artifact.data.length,
                artifact.sha256,
              )) rollbackComplete = false;
            }
          } catch {
            rollbackComplete = false;
          }
        }
        if (operationAgentIds.some((agentId) => store.getAgent(agentId))) {
          rollbackComplete = false;
        }
        if (creationOperationId) {
          store.updateAgentCreationOperation(creationOperationId, {
            status: rollbackComplete ? "rolled_back" : "rolling_back",
            lastError: error instanceof Error ? error.message : "Agent import failed",
          });
        }
        throw error;
      } finally {
        for (const agentId of operationAgentIds.length ? operationAgentIds : rollbackAgentIds) {
          if (!store.getAgent(agentId)) deletingAgentIds.delete(agentId);
        }
        releaseCreationLease();
      }
  });

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: ImportAgentPackageRequest;
  }>(
    "/api/projects/:id/import-agents",
    { bodyLimit: 1024 * 1024 },
    (request, reply) => {
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      return importPackage(request.params.id, request.body, reply, undefined, undefined, {
        idempotencyKey,
        payloadHash: createHash("sha256").update(JSON.stringify(request.body)).digest("hex"),
      });
    },
  );

  const runBackgroundImport = async (operationId: string): Promise<void> => {
    await operationHydration;
    let operation = await readOperation(operationId);
    if (!operation || operation.status !== "pending") return;
    const update = async (patch: Partial<AgentImportOperationDto>) => {
      operation = { ...operation!, ...patch, updatedAt: new Date().toISOString() };
      await writeOperation(operation);
      return operation;
    };
    const phase = async (next: AgentImportPhase) => {
      await update({ phase: next });
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${operationId}`,
          category: "system",
          severity: "info",
          title: "Agent import in progress",
          body: next.replaceAll("_", " "),
          projectId: operation!.projectId,
          action: { kind: "open_project", targetId: operation!.projectId },
        });
      } catch { /* phase state is durable; notification is best effort */ }
    };
    let committedResult: ImportAgentPackageResponse | undefined;
    let retainPayloadForRecovery = false;
    try {
      const raw = await fs.readFile(payloadPath(operationId));
      if (createHash("sha256").update(raw).digest("hex") !== operation.payloadHash) {
        throw new Error("Import payload no longer matches its durable operation");
      }
      const { metadata, portable } = await parsePortablePackageUpload(raw);
      await update({ sourceLabel: portable.sourceLabel.slice(0, 240) });
      const creationOperation = store.beginAgentCreationOperation({
        projectId: operation.projectId,
        actorScope: "user:local-operator",
        kind: "import",
        idempotencyKey: operation.requestId,
        payloadHash: operation.payloadHash,
      }).operation;
      if (creationOperation.status === "completed" && creationOperation.result) {
        const result = creationOperation.result as ImportAgentPackageResponse;
        committedResult = result;
        await update({ phase: "completed", status: "completed", result });
        for (const agentId of creationOperation.agentIds) deletingAgentIds.delete(agentId);
        return;
      }
      if (creationOperation.agentIds.length) {
        throw new Error("A prior import attempt is still being recovered; retry after startup recovery completes");
      }
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
        creationOperation.id,
      );
      if (statusCode >= 400) {
        const record = responseBody && typeof responseBody === "object"
          ? responseBody as { error?: unknown }
          : undefined;
        throw new Error(typeof record?.error === "string" ? record.error : "Import failed");
      }
      const result = responseBody as ImportAgentPackageResponse;
      committedResult = result;
      await update({ phase: "completed", status: "completed", result });
      try {
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
      } catch { /* completion remains authoritative */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed";
      if (committedResult) {
        // The imported Agents are authoritative. If the acknowledgement write
        // failed, leave the durable operation pending so startup can replay it;
        // never rewrite a committed import as an ordinary failure.
        try {
          await update({ phase: "completed", status: "completed", result: committedResult });
        } catch {
          retainPayloadForRecovery = true;
          // Startup hydration and creation-operation replay recover the acknowledgement.
        }
        return;
      }
      try {
        await update({ phase: "failed", status: "failed", error: message.slice(0, 1_000) });
      } catch {
        retainPayloadForRecovery = true;
        return;
      }
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${operationId}`,
          category: "system",
          severity: "urgent",
          title: "Agent import failed",
          body: `${operation.sourceLabel}: ${message}`.slice(0, 1_000),
          projectId: operation.projectId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* failure state is durable */ }
    } finally {
      if (!retainPayloadForRecovery) {
        await fs.unlink(payloadPath(operationId)).catch(() => undefined);
      }
    }
  };

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: Buffer;
  }>(
    "/api/projects/:id/agent-import-operations",
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => withProjectImportLock(request.params.id, async () => {
      await operationHydration;
      if (!store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Project deletion is already in progress" });
      }
      const requestId = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!requestId) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      const requestKey = requestOperationKey(request.params.id, requestId);
      const requestPayloadHash = createHash("sha256").update(request.body).digest("hex");
      const existingId = operationByRequest.get(requestKey);
      if (existingId) {
        const existing = operationCache.get(existingId) ?? await readOperation(existingId);
        if (existing) {
          if (existing.payloadHash !== requestPayloadHash) {
            return reply.code(409).send({
              error: "Import idempotency key was reused with different input",
            });
          }
          return reply.code(existing.status === "pending" ? 202 : 200).send(existing);
        }
        operationByRequest.delete(requestKey);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const operation: AgentImportOperationDto = {
        id,
        requestId,
        payloadHash: requestPayloadHash,
        projectId: request.params.id,
        sourceLabel: "Agent import",
        phase: "queued",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await fs.mkdir(importOperationDirectory, { recursive: true });
        const payload = await fs.open(payloadPath(id), "wx", 0o600);
        try {
          await payload.writeFile(request.body);
          await payload.sync();
        } finally {
          await payload.close();
        }
        await writeOperation(operation);
      } catch (error) {
        operationByRequest.delete(requestKey);
        operationCache.delete(id);
        await fs.unlink(payloadPath(id)).catch(() => undefined);
        throw error;
      }
      setImmediate(() => void runBackgroundImport(id));
      try {
        createOperationalNotification({
          dedupeKey: `agent-import:${id}`,
          category: "system",
          severity: "info",
          title: "Agent import queued",
          body: "The import continues in the background.",
          projectId: operation.projectId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* the durable queue and scheduled worker remain authoritative */ }
      return reply.code(202).send(operation);
    }),
  );

  app.get<{ Params: { id: string; operationId: string } }>(
    "/api/projects/:id/agent-import-operations/:operationId",
    async (request, reply) => {
      await operationHydration;
      const operation = operationCache.get(request.params.operationId)
        ?? await readOperation(request.params.operationId);
      if (!operation || operation.projectId !== request.params.id) {
        return reply.code(404).send({ error: "import operation not found" });
      }
      return operation;
    },
  );

  void operationHydration.then(() => {
    for (const operation of operationCache.values()) {
      if (operation.status === "pending") {
        setImmediate(() => void app.ready().then(() => runBackgroundImport(operation.id)));
      }
    }
  }).catch(() => undefined);

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: Buffer;
  }>(
    "/api/projects/:id/import-agent-package",
    { bodyLimit: 96 * 1024 * 1024 },
    async (request, reply) => {
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      try {
        const { metadata, portable } = await parsePortablePackageUpload(
          request.body,
        );
        return importPackage(
          request.params.id,
          { ...metadata, package: portable },
          reply,
          undefined,
          undefined,
          {
            idempotencyKey,
            payloadHash: createHash("sha256").update(request.body).digest("hex"),
          },
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
    Headers: { "idempotency-key"?: string };
    Body: CopyAgentPackageRequest;
  }>(
    "/api/projects/:id/copy-agent",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
          Object.keys(request.body).some((key) => ![
            "sourceAgentId", "conversationId", "mode", "organization",
            "acknowledgeElevatedManagementPermissions",
          ].includes(key)) ||
          typeof request.body.sourceAgentId !== "string" ||
          typeof request.body.conversationId !== "string") {
        return reply.code(400).send({ error: "copy request fields are invalid" });
      }
      const sourceAgentId = request.body.sourceAgentId.trim();
      const conversationId = request.body.conversationId.trim();
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
        undefined,
        undefined,
        {
          idempotencyKey,
          payloadHash: createHash("sha256").update(JSON.stringify(request.body)).digest("hex"),
        },
      );
    },
  );
}
