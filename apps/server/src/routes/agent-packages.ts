import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "@ponderosa/native-host/fs";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  agentPackageJsonUtf8Bytes, AGENT_PACKAGE_MAX_AGENTS, AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_ARTIFACT_MAX_BYTES,
  AGENT_PACKAGE_STAGING_MAX_BYTES, AGENT_PACKAGE_METADATA_MAX_BYTES,
  AGENT_PACKAGE_LIMIT_LABEL, AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL,
} from "@ponderosa/core";
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
  publishManagedArtifactContentsAsync,
  readManagedArtifactContentsAsync,
  readManagedArtifactContent,
  removeManagedArtifactContent,
  stableJson,
  importedAgentHistoryPath,
  type AgentStore,
  type CoordinationV3Store,
} from "@ponderosa/agents";
import type { FastifyContentTypeParser, FastifyInstance, FastifyReply,FastifyRequest } from "fastify";
import type {IncomingMessage} from 'node:http';
import {requestProduct,resourceInProduct} from '../product-scope.js';
import type { createOperationalNotifications } from "../operational-notifications.js";
import {
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
  exactObjectFields,
  validatedObject,
} from "../object-validation.js";
import {
  decodePortableArtifact,
  encodePortableArtifact,
  parsePortablePackageFile,
  portablePackageJsonChunks,
  portableImportPayloadHash,
  withAgentImportAdmission,
} from "../agent-package-codec.js";

import {validatePortableAgentPackage} from "../portable-agent-package-validation.js";
import type {BranchInstallationService} from "../branch-installation-service.js";

export type BranchPackageEngine = Parameters<BranchInstallationService["setEngine"]>[0];
export interface BranchImportHooks {
  plan(agentIds: string[], creationOperationId?: string): void;
  commit(result: ImportAgentPackageResponse): void;
}

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
  cachedModelOptions: (adapter: Adapter, projectId?: string) => ModelOption[] | undefined;
  appendWorkspace: (event: {
    type: "project_changed";
    projectId: string;
    action: "updated";
  } | {
    type: "conversation_changed";
    projectId: string;
    conversationId: string;
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
): {packageEngine:BranchPackageEngine} {
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
  const copySnapshotPath = (id: string) => path.join(importOperationDirectory, `${id}.copy.payload`);
  const removeCopySnapshot = async (id: string): Promise<void> => {
    let removed = false;
    await fs.unlink(copySnapshotPath(id))
      .then(() => { removed = true; })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    if (removed) {
      releaseStagedReservation(operationReservations.get(`${id}.copy`));
      operationReservations.delete(`${id}.copy`);
    }
    if (removed && process.platform !== "win32") {
      const directory = await fs.open(importOperationDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  };
  const operationByRequest = new Map<string, string>();
  const operationCache = new Map<string, AgentImportOperationDto>();
  const quarantinedOperationIds = new Set<string>();
  const projectImportTails = new Map<string, Promise<void>>();
  const activeCopyOperations = new Set<string>();
  type StagedImportUpload = {
    pathname: string;
    sha256: string;
    size: number;
    reservationId: string;
    metadata?:Omit<ImportAgentPackageRequest,'package'>;
  };
  const ownedUploads=new WeakSet<StagedImportUpload>();
  const pendingUploads=new WeakMap<IncomingMessage,StagedImportUpload>();
  const completedUploadRequests=new WeakSet<IncomingMessage>();
  const maximumImportBytes = AGENT_PACKAGE_MAX_BYTES + AGENT_PACKAGE_METADATA_MAX_BYTES + 1;
  const maximumJsonImportBytes = AGENT_PACKAGE_MAX_BYTES + AGENT_PACKAGE_METADATA_MAX_BYTES + 12;
  const maximumStagedImportBytes = AGENT_PACKAGE_STAGING_MAX_BYTES;
  let stagedImportBytes = 0;
  const stagedReservations = new Map<string, number>();
  const operationReservations = new Map<string, string>();
  const reserveStagedBytes = (reservationId: string, bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid staging reservation");
    if (bytes === 0) return;
    if (stagedImportBytes + bytes > maximumStagedImportBytes) {
      throw Object.assign(
        new Error("Agent import staging capacity is currently full"),
        { statusCode: 503 },
      );
    }
    stagedImportBytes += bytes;
    stagedReservations.set(
      reservationId,
      (stagedReservations.get(reservationId) ?? 0) + bytes,
    );
  };
  const releaseStagedReservation = (reservationId: string | undefined): void => {
    if (!reservationId) return;
    const bytes = stagedReservations.get(reservationId);
    if (bytes === undefined) return;
    stagedReservations.delete(reservationId);
    stagedImportBytes = Math.max(0, stagedImportBytes - bytes);
  };
  const cleanupUpload=async(staged:StagedImportUpload):Promise<void>=>{
    // Only parser-created objects reach this helper. Failure retains the byte
    // reservation until observed removal or restart inventory reconciliation.
    try{await fs.unlink(staged.pathname);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    releaseStagedReservation(staged.reservationId);ownedUploads.delete(staged);
  };
  const abandonUpload=async(request:FastifyRequest):Promise<void>=>{
    completedUploadRequests.add(request.raw);
    const staged=pendingUploads.get(request.raw);if(!staged)return;
    pendingUploads.delete(request.raw);
    try{await cleanupUpload(staged);}catch(error){request.log.error({err:error},'Unclaimed Agent upload cleanup remains pending');}
  };
  app.addHook('onResponse',abandonUpload);
  app.addHook('onError',abandonUpload);
  const claimUpload=async(request:FastifyRequest,reply:FastifyReply):Promise<unknown>=>{
    const staged=request.body as StagedImportUpload;
    if(!ownedUploads.has(staged))return reply.code(400).send({error:'An Agent package requires a parser-owned binary upload'});
    pendingUploads.delete(request.raw);
  };
  const sha256File = async (pathname: string): Promise<string> => {
    const hash = createHash("sha256");
    const handle = await fs.open(pathname, "r");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    try {
      for (let offset = 0;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  };
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
  const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const importPhases = new Set<AgentImportPhase>([
    "queued", "creating_records", "importing_agents", "importing_history",
    "importing_artifacts", "finalizing", "completed", "failed",
  ]);
  const validatedOperation = (value: unknown, expectedId: string): AgentImportOperationDto => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("operation record must be an object");
    }
    const operation = value as Partial<AgentImportOperationDto>;
    if (operation.id !== expectedId || !operationIdPattern.test(operation.id) ||
        typeof operation.requestId !== "string" || !validIdempotencyKey(operation.requestId) ||
        typeof operation.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(operation.payloadHash) ||
        typeof operation.projectId !== "string" || !operation.projectId || operation.projectId.length > 200 ||
        typeof operation.conversationId!=='string'||!operation.conversationId||operation.conversationId.length>200||
        (operation.product!=='dev'&&operation.product!=='branches')||
        typeof operation.sourceLabel !== "string" || operation.sourceLabel.length > 240 ||
        typeof operation.phase !== "string" || !importPhases.has(operation.phase as AgentImportPhase) ||
        !["pending", "completed", "failed"].includes(operation.status ?? "") ||
        typeof operation.createdAt !== "string" || operation.createdAt.length > 100 ||
        typeof operation.updatedAt !== "string" || operation.updatedAt.length > 100 ||
        (operation.error !== undefined && (typeof operation.error !== "string" || operation.error.length > 1_000)) ||
        (operation.result !== undefined && (
          !operation.result || typeof operation.result !== "object" ||
          typeof operation.result.rootAgentId !== "string" || !operation.result.rootAgentId ||
          operation.result.rootAgentId.length > 200 ||
          !Array.isArray(operation.result.agentIds) ||
          operation.result.agentIds.length > AGENT_PACKAGE_MAX_AGENTS ||
          operation.result.agentIds.some((id) => typeof id !== "string" || !id || id.length > 200)
        ))) {
      throw new Error("operation record fields are invalid or do not match its filename");
    }
    return operation as AgentImportOperationDto;
  };
  const quarantineOperation = async (id: string, error: unknown): Promise<void> => {
    quarantinedOperationIds.add(id);
    const source = operationPath(id);
    let destination = `${source}.corrupt`;
    try {
      await fs.access(destination);
      destination = `${source}.corrupt.${randomUUID()}`;
    } catch { /* the stable quarantine name is available */ }
    try {
      await fs.rename(source, destination);
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
        error = new AggregateError([error, renameError], "Import journal quarantine failed");
      }
    }
    try {
      createOperationalNotification({
        dedupeKey: `agent-import-corrupt:${id}`,
        category: "system",
        severity: "urgent",
        title: "Agent import recovery needs attention",
        body: `Import operation ${id} was quarantined; its payload was preserved. ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 1_000),
      });
    } catch { /* quarantine and payload preservation remain authoritative */ }
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
    if (!operationIdPattern.test(id)) return undefined;
    try {
      return validatedOperation(JSON.parse(await fs.readFile(operationPath(id), "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await quarantineOperation(id, error);
      return undefined;
    }
  };
  const operationHydration = fs.mkdir(importOperationDirectory, { recursive: true })
    .then(async () => {
      const names = await fs.readdir(importOperationDirectory);
      for (const name of names) {
        const match = /^([0-9a-f-]{36})\.json\.corrupt(?:\..+)?$/u.exec(name);
        if (match && operationIdPattern.test(match[1]!)) quarantinedOperationIds.add(match[1]!);
      }
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
        const copyMatch = /^(agent-create-[0-9a-f]{64})\.copy\.payload$/u.exec(name);
        const temporary = name.endsWith(".tmp");
        const abandonedUpload = name.startsWith(".incoming-");
        const liveCopy = copyMatch
          ? store.getAgentCreationOperation(copyMatch[1]!)
          : undefined;
        if (!temporary && !abandonedUpload && (
          (payloadMatch && (
            quarantinedOperationIds.has(payloadMatch[1]!) ||
            (durableIds.has(payloadMatch[1]!) &&
              operationCache.get(payloadMatch[1]!)?.status === "pending")
          )) ||
          (copyMatch && liveCopy && liveCopy.status !== "completed") ||
          (!payloadMatch && !copyMatch)
        )) continue;
        await fs.unlink(path.join(importOperationDirectory, name))
          .then(() => { cleaned = true; })
          .catch(() => undefined);
      }
      if (cleaned && process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      // Pending payloads consume the same bounded staging budget after a
      // restart. Admission is initialized before new uploads are accepted.
      for (const name of await fs.readdir(importOperationDirectory)) {
        if (!name.endsWith(".payload") && !name.endsWith(".tmp") && !name.startsWith(".incoming-")) continue;
        const stat = await fs.stat(path.join(importOperationDirectory, name)).catch(() => undefined);
        if (!stat?.isFile()) continue;
        const id = name.slice(0, -".payload".length);
        const reservationId = `retained:${id}`;
        // Retained/quarantined data is never discarded to make space. Existing
        // bytes above capacity block new admission until recovery releases them.
        stagedImportBytes += stat.size;
        stagedReservations.set(reservationId, stat.size);
        if (name.endsWith(".payload")) operationReservations.set(id, reservationId);
      }
    });
  const stagedImportParser = (jsonEnvelope = false): FastifyContentTypeParser => (request, payload, done) => {
      void (async () => {
        const allowedRoutes = jsonEnvelope ? ['/api/projects/:id/import-agents'] : ['/api/projects/:id/agent-import-operations','/api/projects/:id/import-agent-package'];
        if(request.method!=='POST'||!allowedRoutes.includes(request.routeOptions.url??''))throw Object.assign(new Error('Agent package media is only accepted by upload routes'),{statusCode:415});
        await operationHydration;
        await fs.mkdir(importOperationDirectory, { recursive: true });
        const pathname = path.join(importOperationDirectory, `.incoming-${randomUUID()}`);
        const reservationId = `upload:${randomUUID()}`;
        const handle = await fs.open(pathname, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        let metadataBytes: number | undefined;
        let headerBytes = 0;
        const headerParts:Buffer[]=[];
        let metadata:StagedImportUpload['metadata']|undefined;
        try {
          for await (const chunk of payload) {
            if(completedUploadRequests.has(request.raw))throw new Error('Agent upload request already completed');
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (!jsonEnvelope && metadataBytes === undefined) {
              const separator = bytes.indexOf(0x0a);
              if (separator >= 0) metadataBytes = headerBytes + separator + 1;
              else headerBytes += bytes.length;
              if ((metadataBytes ?? headerBytes) > AGENT_PACKAGE_METADATA_MAX_BYTES + 1) {
                throw Object.assign(new Error("Agent package upload metadata is invalid"), { statusCode: 400 });
              }
              headerParts.push(Buffer.from(bytes.subarray(0,separator<0?bytes.length:separator)));
              if(separator>=0){
                const value=validatedObject(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(headerParts))),'Agent upload metadata');
                exactObjectFields(value,['conversationId','engineMapping','acknowledgeElevatedManagementPermissions','chatInstructionsResolution'],'Agent upload metadata');
                const projectId=(request.params as {id:string}).id,destination=typeof value.conversationId==='string'?store.getConversation(value.conversationId):undefined;
                if(!destination||destination.projectId!==projectId||!resourceInProduct(store,'conversation',destination.id,requestProduct(request)))throw Object.assign(new Error('The destination Chat is unavailable in this product'),{statusCode:404});
                metadata=value as unknown as StagedImportUpload['metadata'];
              }
            }
            if (jsonEnvelope ? size > maximumJsonImportBytes : size - (metadataBytes ?? headerBytes) > AGENT_PACKAGE_MAX_BYTES) {
              throw Object.assign(new Error(`Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL}`), { statusCode: 413 });
            }
            reserveStagedBytes(reservationId, bytes.length);
            hash.update(bytes);
            await handle.write(bytes);
          }
          if((!jsonEnvelope&&!metadata)||completedUploadRequests.has(request.raw))throw Object.assign(new Error('Agent upload metadata is unavailable'),{statusCode:400});
          await handle.sync();
          await handle.close();
          if(completedUploadRequests.has(request.raw))throw new Error('Agent upload request already completed');
          const staged:StagedImportUpload={
            pathname,
            sha256: hash.digest("hex"),
            size,
            reservationId,
            metadata,
          };
          ownedUploads.add(staged);pendingUploads.set(request.raw,staged);
          done(null,staged);
        } catch (error) {
          await handle.close().catch(() => undefined);
          // This pathname was allocated by this parser. Retain its byte charge
          // if removal fails, just as handler-owned staged uploads do.
          try {
            await fs.unlink(pathname);
            releaseStagedReservation(reservationId);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') releaseStagedReservation(reservationId);
            else request.log.error({ err: cleanupError }, 'Rejected Agent upload cleanup remains pending');
          }
          request.log.warn({ err: error }, "Agent package upload was rejected before admission");
          done(error as Error);
        }
      })().catch((error) => done(error as Error));
    };
  app.addContentTypeParser(blobImportContentType, stagedImportParser());

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
    if (nodes.length > AGENT_PACKAGE_MAX_AGENTS) {
      throw new AssetError(413, `Agent package contains ${nodes.length} Agents; the limit is ${AGENT_PACKAGE_MAX_AGENTS}`);
    }
    if (nodes.some((agent) => store.agentCreationPending(agent.id))) {
      throw new AssetError(409, "Agent creation is still being recovered");
    }
    const included = new Set(nodes.map((agent) => agent.id));
    const chat = store.getConversation(root.conversationId);
    const project = { ...store.getProject(root.projectId)!, label: chat?.title ?? root.title, instructions: chat?.instructions };
    let portableArtifactBytes = 0;
    const canonicalUserDocuments = mode === "template"
      ? []
      : store.readCommunicationEvents(root.projectId)
        .filter((event) =>
          event.sender.kind === "user" && Boolean(event.document?.artifactId));
    type ImportedHistory = {
      messages: NonNullable<AgentPortablePackageDto["agents"][number]["history"]>;
      initialInstructions?: string;
    };
    const importedHistories = new Map<string, ImportedHistory>();
    let retainedImportedBytes = 0;
    for (const agent of nodes) {
      const pathname = importedAgentHistoryPath(context.dataDir, agent.projectId, agent.id);
      try {
        await fs.access(pathname);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const { portable } = await parsePortablePackageFile(pathname, { packageOnly: true });
      const imported = portable as unknown as ImportedHistory;
      // Bound the total retained text while loading, rather than loading up to
      // 10,000 separately admitted archives before the export can be refused.
      // These values are a lower bound of the eventual package's JSON bytes.
      const messages = mode === "template" ? [] : imported.messages;
      const importedInstructions = (agent.role ?? agent.spawnPrompt ?? agent.presetSnapshot?.guidance) !== undefined
        ? undefined : imported.initialInstructions;
      if (mode !== "template") retainedImportedBytes += agentPackageJsonUtf8Bytes(messages);
      if (importedInstructions !== undefined) retainedImportedBytes += agentPackageJsonUtf8Bytes(importedInstructions);
      if (retainedImportedBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedImportedBytes} serialized UTF-8 bytes)`);
      importedHistories.set(agent.id, { messages, ...(importedInstructions !== undefined ? { initialInstructions: importedInstructions } : {}) });
    }
    const histories = new Map<string, ImportedHistory["messages"]>();
    let retainedHistoryBytes = 0;
    for (const [index, agent] of (mode === "template" ? [] : nodes).entries()) {
      const history = [
        ...(importedHistories.get(agent.id)?.messages ?? []),
        ...agentMessages(agent.id).map((message) => ({
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      ];
      for (const event of canonicalUserDocuments) {
        // Chat location is presentation, never authority to export a private DM.
        const visible = (!event.conversationId || agent.conversationId === event.conversationId)
          && (event.intent === "broadcast"
            ? event.audience.kind === "organization" && event.audience.organizationId === agent.projectId
            : event.intent === "user_dm"
              ? (event.audience.kind === "user_agent"
                  ? event.audience.agentId === agent.id
                  : event.audience.kind === "user_agents" && event.audience.agentIds.includes(agent.id))
              : event.intent === "collaboration"
                && event.audience.kind === "agents" && event.audience.agentIds.includes(agent.id));
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
      retainedHistoryBytes += agentPackageJsonUtf8Bytes(history);
      if (retainedHistoryBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedHistoryBytes} serialized UTF-8 bytes)`);
      histories.set(agent.id, history);
      if (index % 32 === 0) await yieldToLoop();
    }
    const projectArtifacts = mode === "template"
      ? []
      : store.getProjectArtifacts(root.projectId);
    const artifactOwner = new Map<string, string>();
    if (mode !== "template") {
      for (const artifact of projectArtifacts) {
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
    const agents: AgentPortablePackageDto["agents"] = [];
    const artifactsByOwner = new Map<string, typeof projectArtifacts>();
    for (const artifact of projectArtifacts) {
      const owner = artifactOwner.get(artifact.id);
      if (!owner) continue;
      const owned = artifactsByOwner.get(owner) ?? [];
      owned.push(artifact);
      artifactsByOwner.set(owner, owned);
    }
    let retainedAgentBytes = 0;
    for (const agent of nodes) {
      const history = histories.get(agent.id) ?? [];
      const selectedArtifacts = mode === "template"
        ? []
        : artifactsByOwner.get(agent.id) ?? [];
      const artifacts: NonNullable<AgentPortablePackageDto["agents"][number]["artifacts"]> = [];
      const pendingArtifacts: Array<{
        artifact: typeof selectedArtifacts[number];
        identity: { size: number; sha256: string };
      }> = [];
      let reservedArtifactBytes = portableArtifactBytes;
      const flushArtifacts = async (): Promise<void> => {
        if (pendingArtifacts.length === 0) return;
        const batch = pendingArtifacts.splice(0);
        const bodies = await readManagedArtifactContentsAsync(
          context.dataDir,
          agent.projectId,
          batch.map(({ artifact, identity }) => ({
            artifactId: artifact.id,
            expectedSize: identity.size,
            expectedSha256: identity.sha256,
          })),
        );
        for (const [index, { artifact }] of batch.entries()) {
          const data = bodies[index];
          if (!data) {
            throw new AssetError(409, `artifact ${artifact.id} content is unavailable or changed`);
          }
          artifacts.push({
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
          });
        }
      };
      for (const artifact of selectedArtifacts) {
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
        if (identity && reservedArtifactBytes + identity.size > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
          throw new AssetError(
            413,
            `portable Agent package artifacts exceed the ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL} export limit`,
          );
        }
        if (!identity) {
          throw new AssetError(409, `artifact ${artifact.id} content is unavailable or changed`);
        }
        reservedArtifactBytes += identity.size;
        pendingArtifacts.push({ artifact, identity });
        if (pendingArtifacts.length >= 128) await flushArtifacts();
      }
      await flushArtifacts();
      portableArtifactBytes = reservedArtifactBytes;
      const initialInstructions = agent.role ?? agent.spawnPrompt ?? agent.presetSnapshot?.guidance
        ?? importedHistories.get(agent.id)?.initialInstructions;
      const portableAgent: AgentPortablePackageDto["agents"][number] = {
        ref: agent.id,
        title: agent.title,
        engine: agent.activeEngine,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        managementPermissions: agent.managementPermissions,
        ...(initialInstructions !== undefined ? { initialInstructions } : {}),
        ...(agent.managerAgentId && included.has(agent.managerAgentId)
          ? { managerRef: agent.managerAgentId }
          : {}),
        ...(mode !== "template" ? { history } : {}),
        ...(artifacts.length ? { artifacts } : {}),
      };
      retainedAgentBytes += agentPackageJsonUtf8Bytes(portableAgent);
      if (retainedAgentBytes > AGENT_PACKAGE_MAX_BYTES) throw new AssetError(413, `Agent package exceeds ${AGENT_PACKAGE_LIMIT_LABEL} (${retainedAgentBytes} serialized UTF-8 bytes)`);
      agents.push(portableAgent);
      await yieldToLoop();
    }
    const portable: AgentPortablePackageDto = {
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
    agentPackageJsonUtf8Bytes(portable);
    return portable;
  };

  type PreparedCopySnapshot = {
    phase: "prepared_copy";
    snapshotSha256: string;
  };
  const preparedCopySnapshot = (result: unknown): PreparedCopySnapshot | undefined =>
    result && typeof result === "object" &&
    (result as { phase?: unknown }).phase === "prepared_copy" &&
    typeof (result as { snapshotSha256?: unknown }).snapshotSha256 === "string"
      ? result as PreparedCopySnapshot
      : undefined;
  const readCopySnapshot = async (
    operationId: string,
    expectedSha256?: string,
  ): Promise<{ portable: AgentPortablePackageDto; sha256: string } | undefined> => {
    try { await fs.access(copySnapshotPath(operationId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const sha256 = await sha256File(copySnapshotPath(operationId));
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error("Agent copy snapshot no longer matches its durable operation");
    }
    const { portable } = await parsePortablePackageFile(copySnapshotPath(operationId), { packageOnly: true });
    return { portable, sha256 };
  };
  const installCopySnapshot = async (
    operationId: string,
    portable: AgentPortablePackageDto,
  ): Promise<{ portable: AgentPortablePackageDto; sha256: string }> => {
    const existing = await readCopySnapshot(operationId);
    if (existing) return existing;
    await fs.mkdir(importOperationDirectory, { recursive: true });
    const finalPath = copySnapshotPath(operationId);
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        for await (const chunk of portablePackageJsonChunks(portable)) {
          const bytes = Buffer.from(chunk, "utf8");
          reserveStagedBytes(`copy:${operationId}`, bytes.length);
          await handle.writeFile(bytes);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, finalPath);
      if (process.platform !== "win32") {
        const directory = await fs.open(importOperationDirectory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      const removed = await fs.unlink(temporary).then(() => true).catch(() => false);
      if (removed) releaseStagedReservation(`copy:${operationId}`);
      throw error;
    }
    operationReservations.set(`${operationId}.copy`, `copy:${operationId}`);
    const installed = await readCopySnapshot(operationId);
    if (!installed) throw new Error("Agent copy snapshot was not durably installed");
    return installed;
  };

  app.get<{
    Params: { id: string };
    Querystring: {
      mode?: AgentExportMode;
      organization?: string;
      download?: string;
    };
  }>("/api/agents/:id/export", async (request, reply) => withAgentImportAdmission(async () => {
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
    // Serialize to admitted, owned staging before starting the response so an
    // over-limit export fails honestly; the download then streams with backpressure.
    await operationHydration;
    const reservationId = `export:${randomUUID()}`;
    const pathname = path.join(importOperationDirectory, `.incoming-${randomUUID()}`);
    const handle = await fs.open(pathname, "wx", 0o600);
    try {
      for await (const chunk of portablePackageJsonChunks(result)) {
        const bytes = Buffer.from(chunk, "utf8");
        reserveStagedBytes(reservationId, bytes.length);
        await handle.writeFile(bytes);
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      const removed = await fs.unlink(pathname).then(() => true).catch(() => false);
      if (removed) releaseStagedReservation(reservationId);
      throw error;
    }
    const stream = createReadStream(pathname);
    stream.once("close", () => {
      void fs.unlink(pathname).then(() => releaseStagedReservation(reservationId)).catch(() => undefined);
    });
    reply.raw.once("close", () => stream.destroy());
    return reply.type("application/json; charset=utf-8").send(stream);
  }));

  const validChatInstructionsResolution = (value: unknown): boolean => {
    if (value === undefined) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 2 &&
      (record.action === "keep_destination" || record.action === "use_source") &&
      typeof record.expectedDestinationSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(record.expectedDestinationSha256);
  };

  const importPackage = async (
    projectId: string,
    body: ImportAgentPackageRequest,
    reply: FastifyReply,
    onPhase?: (phase: AgentImportPhase) => Promise<void>,
    creationOperationId?: string,
    creationRequest?: { idempotencyKey: string; rawPayloadHash?: string },
    branchHooks?: BranchImportHooks,
    signal?: AbortSignal,
  ): Promise<unknown> => withProjectImportLock(projectId, async () => {
      signal?.throwIfAborted();
      let importBody: Record<string, unknown>;
      try {
        importBody = validatedObject(body, "Agent import request");
        exactObjectFields(
          importBody,
          ["package", "conversationId", "engineMapping", "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution"],
          "Agent import request",
        );
        if (!validChatInstructionsResolution(importBody.chatInstructionsResolution) ||
            typeof importBody.conversationId !== "string" ||
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
      if (!creationOperationId) {
        if (!creationRequest) throw new Error("Agent import idempotency identity is required");
        const normalizedEngineMapping = Object.fromEntries(
          Object.entries(importBody.engineMapping as Record<string, string>)
            .map(([source, target]) => [source, target.trim()]),
        );
        let payloadHash: string;
        try {
          if (!creationRequest.rawPayloadHash) {
            const { package: portable, ...metadata } = importBody;
            agentPackageJsonUtf8Bytes(portable);
            agentPackageJsonUtf8Bytes(metadata, AGENT_PACKAGE_METADATA_MAX_BYTES);
          }
          payloadHash = creationRequest.rawPayloadHash ?? await portableImportPayloadHash({
            package: importBody.package,
            conversationId: importBody.conversationId,
            engineMapping: normalizedEngineMapping,
            ...(importBody.chatInstructionsResolution ? { chatInstructionsResolution: importBody.chatInstructionsResolution } : {}),
            acknowledgeElevatedManagementPermissions:
              importBody.acknowledgeElevatedManagementPermissions ?? false,
          }, signal);
        } catch (error) {
          return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "invalid Agent import identity" });
        }
        try {
          creationOperationId = store.beginAgentCreationOperation({
            projectId,
            actorScope: "user:local-operator",
            kind: "import",
            idempotencyKey: creationRequest.idempotencyKey,
            payloadHash,
            conversationId: body.conversationId,
          }).operation.id;
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error ? error.message : "Agent import replay conflict",
          });
        }
      }
      const durableOperation = store.getAgentCreationOperation(creationOperationId);
      if (!durableOperation) throw new Error("Agent import creation operation is unavailable");
      if (durableOperation.projectId !== projectId || durableOperation.conversationId !== body.conversationId) {
        return reply.code(409).send({error:"Agent import destination does not match its durable owner"});
      }
      if (durableOperation.status === "completed" && durableOperation.result) {
        return reply.code(200).send(durableOperation.result);
      }
      if (durableOperation.status === "canonical_committed" || durableOperation.status === "rolling_back") {
        return reply.code(409).send({
          error: "A prior import attempt is still being recovered; retry after recovery completes",
          operationId: durableOperation.id,
        });
      }
      if (durableOperation.agentIds.length > 0) {
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
      const project = store.getProject(projectId);
      const conversation = body?.conversationId
        ? store.getConversation(body.conversationId)
        : undefined;
      if (!project) {
        abandonMutationFreeOperation("project not found");
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(project.id)) {
        abandonMutationFreeOperation("Project deletion is already in progress");
        return reply.code(409).send({
          error: "Project deletion is already in progress",
        });
      }
      if (!conversation || conversation.projectId !== project.id ||
          deletingConversationIds.has(conversation.id)) {
        abandonMutationFreeOperation("an active destination Project Chat is required");
        return reply.code(400).send({
          error: "an active destination Project Chat is required",
        });
      }
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
      let appliedChatInstructions: string | undefined;
      try {
      await onPhase?.("creating_records");
      signal?.throwIfAborted();

      let portablePackage: AgentPortablePackageDto;
      let importNodes: PlannedNode[];
      let importSourceLabel: string;
      const artifactRefMap = new Map<string, string>();
      try {
        const validated = validatePortableAgentPackage(body?.package);
        portablePackage = validated.package;
        importSourceLabel = portablePackage.sourceLabel.slice(0,240);
        const elevatedAgentRefs = portablePackage.agents.filter(node =>
          node.managementPermissions.allowAutomaticDescendantDeletion ||
          node.managementPermissions.allowAutomaticDescendantReorganization).map(node=>node.ref);
        const sourceEngines = new Set(portablePackage.agents.map(node=>node.engine));
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
            const artifact = artifactCandidate;
            const encodedBytes = validated.artifactBytes.get(artifact)!;
            if (artifactBytes + encodedBytes > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
              abandonMutationFreeOperation(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`);
              return reply.code(413).send({ error: `portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}` });
            }
            const { data, sha256 } = await decodePortableArtifact(artifact.dataBase64);
            artifactBytes += data.length;
            if (artifactBytes > AGENT_PACKAGE_ARTIFACT_MAX_BYTES) {
              abandonMutationFreeOperation(`portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`);
              return reply.code(413).send({
                error:
                  `portable Agent package artifacts exceed ${AGENT_PACKAGE_ARTIFACT_LIMIT_LABEL}`,
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

        importNodes = [];
        for (const node of portablePackage.agents) {
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
          const initialInstructions = node.initialInstructions === undefined ? undefined
            : rewritePortableArtifactReferences(node.initialInstructions, artifactRefMap);
          // Initial guidance has its own portable authority. Its private-context
          // entry is derived by the store, never added to exportable history.
          const history = [...(node.history ?? [])];
          for (let index = 0; index < history.length; index++) {
            const message = history[index]!;
            history[index] = { ...message, text: rewritePortableArtifactReferences(message.text, artifactRefMap) };
            if (index % 16 === 0) await yieldToLoop();
          }
          importNodes.push({
            ...node,
            title: node.title.trim().slice(0, 80) || "Imported Agent",
            initialInstructions,
            targetEngine,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            history,
            artifacts: artifactsByNode.get(node.ref) ?? [],
          });
          await yieldToLoop();
        }
      } catch (error) {
        abandonMutationFreeOperation(error instanceof Error ? error.message : "invalid Ponderosa Agent package");
        return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({
          error: error instanceof Error ? error.message : "invalid Ponderosa Agent package",
        });
      }

      const activeDestinationConversation = () => {
        const current = store.getConversation(conversation.id);
        return current?.projectId === project.id &&
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
      const sourceInstructions = portablePackage.mode === "full"
        ? portablePackage.sourceProjectInstructions : undefined;
      const destinationInstructions = conversation.instructions ?? "";
      const resolution = body.chatInstructionsResolution;
      const destinationSha256 = createHash("sha256").update(destinationInstructions).digest("hex");
      if ((resolution && resolution.expectedDestinationSha256 !== destinationSha256) ||
          (sourceInstructions && destinationInstructions &&
            sourceInstructions !== destinationInstructions && !resolution)) {
        abandonMutationFreeOperation("Chat instructions need an explicit conflict choice");
        return reply.code(409).send({
          error: resolution ? "Destination Chat instructions changed. Review them and choose again."
            : "This Chat has different instructions. Choose whether to keep them or use the imported instructions.",
        });
      }
      const importedChatInstructions = sourceInstructions &&
        sourceInstructions !== destinationInstructions && resolution?.action !== "keep_destination"
        ? rewritePortableArtifactReferences(sourceInstructions, artifactRefMap) : undefined;
      if (importedChatInstructions && importedChatInstructions.length > 100_000) {
        abandonMutationFreeOperation("Imported Chat instructions exceed 100000 characters");
        return reply.code(400).send({ error: "Imported Chat instructions exceed 100000 characters" });
      }
      try {
        // Remapping a short colliding reference can grow otherwise admitted
        // text. Admit the complete persisted values before reserving records,
        // publishing bytes or changing the destination Chat.
        agentPackageJsonUtf8Bytes({
          ...portablePackage,
          ...(importedChatInstructions !== undefined ? { sourceProjectInstructions: importedChatInstructions } : {}),
          agents: importNodes.map((node, index) => ({
            ...portablePackage.agents[index],
            ...(node.initialInstructions !== undefined ? { initialInstructions: node.initialInstructions } : {}),
            ...(portablePackage.mode === "full" ? { history: node.history } : {}),
            ...(node.artifacts.length ? { artifacts: node.artifacts.map((artifact, artifactIndex) => ({
              ...portablePackage.agents[index]!.artifacts![artifactIndex],
              ref: artifact.destinationId,
              path: artifact.managedPath,
            })) } : {}),
          })),
        });
        for (const node of importNodes) {
          agentPackageJsonUtf8Bytes({
            source: importSourceLabel,
            importedAt: new Date().toISOString(),
            ...(node.initialInstructions !== undefined ? { initialInstructions: node.initialInstructions, initialInstructionsSeparated: true } : {}),
            messages: node.history,
          }, AGENT_PACKAGE_MAX_BYTES - 1);
        }
      } catch (error) {
        abandonMutationFreeOperation(error instanceof Error ? error.message : "Agent package exceeds its byte limit");
        return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "Agent package exceeds its byte limit" });
      }
      const plannedArtifacts = importNodes.flatMap((node) => node.artifacts);
      rollbackArtifacts = plannedArtifacts;
      store.sqlite.transaction(() => {
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
            artifactIdentities: importNodes.flatMap((node, nodeIndex) =>
              node.artifacts.map((artifact) => ({
                id: artifact.destinationId,
                byteLength: artifact.data.length,
                sha256: artifact.sha256,
                ...(artifact.kind === "generated_file"
                  ? {
                      generated: {
                        agentId: operationAgentIds[nodeIndex]!,
                        originAgentId: operationAgentIds[nodeIndex]!,
                        path: artifact.managedPath,
                        ...(artifact.sourcePath
                          ? { sourcePath: artifact.sourcePath }
                          : {}),
                        summary: artifact.summary,
                        createdAt: artifact.createdAt,
                        mediaType: artifact.mediaType,
                      },
                    }
                  : {}),
              })),
            ),
          });
        } else {
          if (creationOperation.agentIds.length !== importNodes.length) {
            throw new Error("Agent import creation plan does not match the package");
          }
          operationAgentIds = creationOperation.agentIds;
          for (const agentId of operationAgentIds) deletingAgentIds.add(agentId);
        }
      }
      branchHooks?.plan(operationAgentIds, creationOperationId);
      })();
      signal?.throwIfAborted();
      await onPhase?.("importing_artifacts");
      signal?.throwIfAborted();
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

      signal?.throwIfAborted();
      const created = new Map<string, AgentDto>();
      await onPhase?.("importing_agents");
      signal?.throwIfAborted();
      for (const [index, node] of importNodes.entries()) {
        signal?.throwIfAborted();
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
        await yieldToLoop();
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
        if (node.history.length || node.initialInstructions !== undefined) {
          await store.setImportedHistoryAsync(
            agent.id,
            importSourceLabel,
            node.history,
            node.initialInstructions,
          );
        }
      }
      signal?.throwIfAborted();
      // All imported Agents start detached. Attach descendants before their
      // managers so each existing ancestry check stays bounded even for a
      // 10,000-deep organization supplied in arbitrary package order.
      const childrenByManager = new Map<string, PlannedNode[]>();
      for (const node of importNodes) {
        if (!node.managerRef) continue;
        const siblings = childrenByManager.get(node.managerRef) ?? [];
        siblings.push(node);
        childrenByManager.set(node.managerRef, siblings);
      }
      const assignmentOrder = [importNodes.find(node => node.ref === portablePackage.rootRef)!];
      for (let index = 0; index < assignmentOrder.length; index++) {
        for (const child of childrenByManager.get(assignmentOrder[index]!.ref) ?? []) assignmentOrder.push(child);
      }
      for (const node of assignmentOrder.reverse()) {
        signal?.throwIfAborted();
        if (node.managerRef) {
          store.updateAgentOrganization(
            created.get(node.ref)!.id,
            { managerAgentId: created.get(node.managerRef)!.id },
          );
        }
        await yieldToLoop();
      }
      for (const { artifact } of catalogArtifacts) {
        if (artifact.kind !== "generated_file") continue;
        assets.registerPublishedGeneratedArtifact(
          artifact as RegisteredGeneratedArtifact,
          publicationById.get(artifact.id)!,
        );
      }
      const response: ImportAgentPackageResponse = {
        rootAgentId: created.get(portablePackage.rootRef)!.id,
        agentIds: [...created.values()].map((agent) => agent.id),
      };
      if (creationOperationId) {
        // Copy snapshots are retry authority only until the canonical import
        // commits. Remove and fsync them before acknowledging completion so the
        // caller cannot observe success with stale recovery data.
        await removeCopySnapshot(creationOperationId);
        if (importedChatInstructions !== undefined) {
          const currentDestination = activeDestinationConversation();
          if (!currentDestination || (currentDestination.instructions ?? "") !== destinationInstructions) {
            throw Object.assign(new Error("Destination Chat instructions changed. Review them and choose again."), { statusCode: 409 });
          }
          appliedChatInstructions = importedChatInstructions;
          if (!store.updateConversation(conversation.id, { instructions: importedChatInstructions })) {
            throw new Error("The destination Chat is no longer active");
          }
        }
        signal?.throwIfAborted();
        store.sqlite.transaction(() => {
          branchHooks?.commit(response);
          store.updateAgentCreationOperation(creationOperationId!, {
            status: "completed", result: response, lastError: null,
          });
        })();
        for (const agentId of operationAgentIds) deletingAgentIds.delete(agentId);
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
      if (appliedChatInstructions !== undefined) {
        try {
          appendWorkspace({ type: "conversation_changed", projectId: project.id,
            conversationId: conversation.id, action: "updated" });
        } catch { /* Clients reconcile durable Chat metadata on refresh. */ }
      }
      return reply.code(201).send(response);
      } catch (error) {
        let rollbackComplete = true;
        if (appliedChatInstructions !== undefined) {
          try {
            if (store.getConversation(conversation.id)?.instructions === appliedChatInstructions) {
              store.updateConversation(conversation.id, { instructions: conversation.instructions ?? "" });
            }
          } catch { rollbackComplete = false; }
        }
        const authorityBlockedArtifactIds = new Set<string>();
        try {
          // Pending members are intentionally absent from the public directory.
          // Resolve and delete the entire owned organization in one preview.
          const liveIds=rollbackAgentIds.filter(id=>store.getAgent(id));
          if(liveIds.length){
            const preview=store.previewAgentDeletion(liveIds);
            if(preview.affectedAgents.some(agent=>!rollbackAgentIds.includes(agent.id)))throw new Error("Import rollback would affect an unowned Agent");
            store.deleteAgentSubtrees(liveIds,preview.previewHash,id=>coordinationV3.handleAgentDeletion(id));
          }
        } catch {
          // Exact cleanup authority remains durable for startup recovery.
          rollbackComplete=false;
        }
        const operationAgentsRemain = operationAgentIds.some((agentId) => store.getAgent(agentId));
        if (creationOperationId) {
          for (const identity of store.getAgentCreationOperation(creationOperationId)!
            .artifactIdentities) {
            try {
              if (operationAgentsRemain ||
                  !assets.removeCreationGeneratedArtifact(project.id, identity)) {
                authorityBlockedArtifactIds.add(identity.id);
                rollbackComplete = false;
              }
            } catch {
              authorityBlockedArtifactIds.add(identity.id);
              rollbackComplete = false;
            }
          }
        }
        for (const artifact of rollbackArtifacts) {
          if (authorityBlockedArtifactIds.has(artifact.destinationId)) continue;
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
        if (operationAgentsRemain) rollbackComplete = false;
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

  const importStagedPackage = async (
    request: FastifyRequest<{ Params: { id: string }; Headers: { "idempotency-key"?: string }; Body: StagedImportUpload }>,
    reply: FastifyReply,
    jsonEnvelope = false,
  ): Promise<unknown> => {
    try {
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) return reply.code(400).send({ error: "a valid import idempotency key is required" });
      return await withAgentImportAdmission(async () => {
        if (await sha256File(request.body.pathname) !== request.body.sha256) throw new Error("Agent upload changed after admission");
        const { metadata, portable, canonicalPayloadHash } = await parsePortablePackageFile(request.body.pathname, { jsonEnvelope });
        if (jsonEnvelope && !canonicalPayloadHash) throw new Error("Agent import canonical identity is unavailable");
        if ((!jsonEnvelope && metadata.conversationId !== request.body.metadata?.conversationId) ||
            !resourceInProduct(store, "conversation", metadata.conversationId, requestProduct(request))) {
          return reply.code(404).send({ error: "The destination Chat is unavailable in this product" });
        }
        return importPackage(request.params.id, { ...metadata, package: portable }, reply, undefined, undefined, {
          idempotencyKey,
          // JSON callers retain their original canonical payload identity;
          // binary uploads retain their exact owned-upload identity.
          rawPayloadHash: jsonEnvelope ? canonicalPayloadHash : request.body.sha256,
        });
      });
    } catch (error) {
      return reply.code((error as {statusCode?:number})?.statusCode ?? 400).send({ error: error instanceof Error ? error.message : "invalid Ponderosa Agent package" });
    } finally {
      await cleanupUpload(request.body);
    }
  };

  // Scope the legacy JSON envelope to the existing owned staging and codec.
  // Ordinary JSON routes keep their parser and request budgets unchanged.
  void app.register(async scope => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", stagedImportParser(true));
    scope.post<{ Params: { id: string }; Headers: { "idempotency-key"?: string }; Body: StagedImportUpload }>(
      "/api/projects/:id/import-agents",
      { bodyLimit: maximumJsonImportBytes, preHandler: claimUpload },
      (request, reply) => importStagedPackage(request, reply, true),
    );
  });

  const runBackgroundImport = async (operationId: string): Promise<void> =>
    withAgentImportAdmission(async () => {
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
          conversationId:operation!.conversationId,
          action: { kind: "open_project", targetId: operation!.projectId },
        });
      } catch { /* phase state is durable; notification is best effort */ }
    };
    let committedResult: ImportAgentPackageResponse | undefined;
    let retainPayloadForRecovery = false;
    try {
      const durablePayloadPath = payloadPath(operationId);
      if (await sha256File(durablePayloadPath) !== operation.payloadHash) {
        throw new Error("Import payload no longer matches its durable operation");
      }
      const { metadata, portable } = await parsePortablePackageFile(durablePayloadPath);
      if(metadata.conversationId!==operation.conversationId||!resourceInProduct(store,'conversation',operation.conversationId,operation.product))throw new Error('Import destination no longer matches its admitted product');
      await update({ sourceLabel: portable.sourceLabel.slice(0, 240) });
      const creationOperation = store.beginAgentCreationOperation({
        projectId: operation.projectId,
        actorScope: "user:local-operator",
        kind: "import",
        idempotencyKey: operation.requestId,
        payloadHash: operation.payloadHash,
        conversationId: metadata.conversationId,
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
          title: "Import complete",
          informational: true,
          body: `${operation.sourceLabel} was imported successfully. Reviewing its preserved history is optional; the Agent is ready to use.`,
          projectId: operation.projectId,
          conversationId:operation.conversationId,
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
          conversationId:operation.conversationId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* failure state is durable */ }
    } finally {
      if (!retainPayloadForRecovery) {
        const removed = await fs.unlink(payloadPath(operationId))
          .then(() => true)
          .catch(() => false);
        if (removed) {
          releaseStagedReservation(operationReservations.get(operationId));
          operationReservations.delete(operationId);
        }
      }
    }
  });

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: StagedImportUpload;
  }>(
    "/api/projects/:id/agent-import-operations",
    { bodyLimit: maximumImportBytes,preHandler:claimUpload },
    async (request, reply) => withProjectImportLock(request.params.id, async () => {
      const staged = request.body;
      let transferredReservation = false;
      try {
        await operationHydration;
        const requestId = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!requestId) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      const destination=store.getConversation(staged.metadata!.conversationId),product=requestProduct(request);
      if(!destination||destination.projectId!==request.params.id||!resourceInProduct(store,'conversation',destination.id,product))return reply.code(404).send({error:'The destination Chat is unavailable in this product'});
      const requestKey = requestOperationKey(request.params.id, requestId);
      const requestPayloadHash = staged.sha256;
      const existingId = operationByRequest.get(requestKey);
      if (existingId) {
        const existing = operationCache.get(existingId) ?? await readOperation(existingId);
        if (existing) {
          if(existing.conversationId!==destination.id||existing.product!==product)return reply.code(404).send({error:'import operation not found'});
          if (existing.payloadHash !== requestPayloadHash) {
            return reply.code(409).send({
              error: "Import idempotency key was reused with different input",
            });
          }
          return reply.code(existing.status === "pending" ? 202 : 200).send(existing);
        }
        operationByRequest.delete(requestKey);
      }
      if (!store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (deletingProjectIds.has(request.params.id)) {
        return reply.code(409).send({ error: "Project deletion is already in progress" });
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const operation: AgentImportOperationDto = {
        id,
        requestId,
        payloadHash: requestPayloadHash,
        projectId: request.params.id,
        conversationId:destination.id,
        product,
        sourceLabel: "Agent import",
        phase: "queued",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await fs.mkdir(importOperationDirectory, { recursive: true });
        await fs.rename(staged.pathname, payloadPath(id));
        operationReservations.set(id, staged.reservationId);
        transferredReservation = true;
        if (process.platform !== "win32") {
          const directory = await fs.open(importOperationDirectory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
        await writeOperation(operation);
      } catch (error) {
        operationByRequest.delete(requestKey);
        operationCache.delete(id);
        const removed = await fs.unlink(payloadPath(id))
          .then(() => true)
          .catch(() => false);
        if (removed) {
          releaseStagedReservation(operationReservations.get(id));
          operationReservations.delete(id);
        }
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
          conversationId:operation.conversationId,
          action: { kind: "open_project", targetId: operation.projectId },
        });
      } catch { /* the durable queue and scheduled worker remain authoritative */ }
      return reply.code(202).send(operation);
      } finally {
        if(!transferredReservation)await cleanupUpload(staged);
        else ownedUploads.delete(staged);
      }
    }),
  );

  app.get<{ Params: { id: string; operationId: string } }>(
    "/api/projects/:id/agent-import-operations/:operationId",
    async (request, reply) => {
      await operationHydration;
      const operation = operationCache.get(request.params.operationId)
        ?? await readOperation(request.params.operationId);
      if (!operation || operation.projectId !== request.params.id || operation.product!==requestProduct(request) || !resourceInProduct(store,'conversation',operation.conversationId,requestProduct(request))) {
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
    Body: StagedImportUpload;
  }>(
    "/api/projects/:id/import-agent-package",
    { bodyLimit: maximumImportBytes,preHandler:claimUpload },
    (request, reply) => importStagedPackage(request, reply),
  );

  app.post<{
    Params: { id: string };
    Headers: { "idempotency-key"?: string };
    Body: CopyAgentPackageRequest;
  }>(
    "/api/projects/:id/copy-agent",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => withAgentImportAdmission(async () => {
      await operationHydration;
      const idempotencyKey = validIdempotencyKey(request.headers["idempotency-key"]);
      if (!idempotencyKey) {
        return reply.code(400).send({ error: "a valid import idempotency key is required" });
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
          Object.keys(request.body).some((key) => ![
            "sourceAgentId", "conversationId", "rootTitle", "mode", "organization",
            "acknowledgeElevatedManagementPermissions", "chatInstructionsResolution",
          ].includes(key)) ||
          !validChatInstructionsResolution(request.body.chatInstructionsResolution) ||
          typeof request.body.sourceAgentId !== "string" ||
          typeof request.body.conversationId !== "string") {
        return reply.code(400).send({ error: "copy request fields are invalid" });
      }
      const sourceAgentId = request.body.sourceAgentId.trim();
      const conversationId = request.body.conversationId.trim();
      const rootTitle = typeof request.body.rootTitle === "string"
        ? request.body.rootTitle.trim()
        : undefined;
      if (
        !sourceAgentId
        || !conversationId
        || (
          request.body.rootTitle !== undefined
          && (
            typeof request.body.rootTitle !== "string"
            || !rootTitle
            || rootTitle.length > 80
          )
        )
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
      const payloadHash = createHash("sha256").update(stableJson({
        sourceAgentId,
        conversationId,
        ...(request.body.chatInstructionsResolution ? { chatInstructionsResolution: request.body.chatInstructionsResolution } : {}),
        ...(rootTitle ? { rootTitle } : {}),
        mode: request.body.mode ?? "full",
        organization: request.body.organization ?? false,
        acknowledgeElevatedManagementPermissions:
          request.body.acknowledgeElevatedManagementPermissions ?? false,
      })).digest("hex");
      let creationOperation;
      try {
        creationOperation = store.beginAgentCreationOperation({
          projectId: request.params.id,
          actorScope: "user:local-operator",
          kind: "import",
          idempotencyKey,
          payloadHash,
          conversationId,
        }).operation;
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "Agent copy replay conflict",
        });
      }
      if (creationOperation.status === "completed" && creationOperation.result) {
        return reply.code(200).send(creationOperation.result);
      }
      if (creationOperation.status === "canonical_committed" ||
          creationOperation.status === "rolling_back" ||
          creationOperation.agentIds.length > 0) {
        return reply.code(409).send({
          error: "A prior copy attempt is still being recovered; retry after recovery completes",
          operationId: creationOperation.id,
        });
      }
      if (activeCopyOperations.has(creationOperation.id)) {
        return reply.code(409).send({
          error: "Agent copy is still in progress; retry with the same idempotency key",
          operationId: creationOperation.id,
        });
      }
      activeCopyOperations.add(creationOperation.id);
      const abandonMutationFreeCopy = (reason: string): boolean => {
        const current = store.getAgentCreationOperation(creationOperation.id);
        if (!current || current.agentIds.length > 0) return false;
        store.updateAgentCreationOperation(current.id, {
          status: "rolled_back",
          lastError: reason,
        });
        return true;
      };
      let portable: AgentPortablePackageDto;
      try {
        const savedSnapshot = preparedCopySnapshot(creationOperation.result);
        let prepared = await readCopySnapshot(
          creationOperation.id,
          savedSnapshot?.snapshotSha256,
        );
        if (!prepared) {
          if (savedSnapshot) {
            throw new Error("Agent copy snapshot is unavailable");
          }
          const source = store.getAgent(sourceAgentId);
          if (!source) {
            activeCopyOperations.delete(creationOperation.id);
            if (!abandonMutationFreeCopy("agent not found")) {
              return reply.code(409).send({
                error: "A prior copy attempt is still being recovered; retry after recovery completes",
                operationId: creationOperation.id,
              });
            }
            return reply.code(404).send({ error: "agent not found" });
          }
          prepared = await installCopySnapshot(
            creationOperation.id,
            await buildPortablePackage(
              source.id,
              request.body.mode ?? "full",
              request.body.organization === true,
            ),
          );
        }
        portable = rootTitle
          ? {
              ...prepared.portable,
              agents: prepared.portable.agents.map((node) =>
                node.ref === prepared.portable.rootRef
                  ? { ...node, title: rootTitle }
                  : node),
            }
          : prepared.portable;
        if (!savedSnapshot) {
          store.updateAgentCreationOperation(creationOperation.id, {
            result: {
              phase: "prepared_copy",
              snapshotSha256: prepared.sha256,
            } satisfies PreparedCopySnapshot,
          });
        }
      } catch (error) {
        activeCopyOperations.delete(creationOperation.id);
        if (!abandonMutationFreeCopy(
          error instanceof Error ? error.message : "Agent copy could not be prepared",
        )) {
          return reply.code(409).send({
            error: "A prior copy attempt is still being recovered; retry after recovery completes",
            operationId: creationOperation.id,
          });
        }
        throw error;
      }
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
          ...(request.body.chatInstructionsResolution ? { chatInstructionsResolution: request.body.chatInstructionsResolution } : {}),
          ...(request.body.acknowledgeElevatedManagementPermissions === true
            ? { acknowledgeElevatedManagementPermissions: true }
            : {}),
        },
        reply,
        undefined,
        creationOperation.id,
      ).finally(async () => {
        activeCopyOperations.delete(creationOperation.id);
        if (store.getAgentCreationOperation(creationOperation.id)?.status === "completed") {
          await removeCopySnapshot(creationOperation.id);
        }
      });
    }),
  );
  return {packageEngine:{
    validateAgent(pkg,mapping) {
      for (const node of validatePortableAgentPackage(pkg).package.agents) {
        const target=mapping[node.engine]?.trim(), registration=target?engines.get(target):undefined;
        if(!registration)throw new Error(`Choose an available Engine for ${node.engine}`);
        const error=runtimeSelectionError(registration.adapter,node.model?.trim()||undefined,node.effort?.trim()||undefined,cachedModelOptions(registration.adapter));
        if(error)throw new Error(`${node.title}: ${error}`);
      }
    },
    exportAgent:(id,mode)=>withAgentImportAdmission(()=>buildPortablePackage(id,mode,false)),
    importAgent:(projectId,chatId,pkg,engineMapping,key,options)=>withAgentImportAdmission(async()=>{
      let status=200,body:unknown;
      const response={code(value:number){status=value;return this;},send(value:unknown){body=value;return value;}} as unknown as FastifyReply;
      await importPackage(projectId,{package:pkg,conversationId:chatId,engineMapping,acknowledgeElevatedManagementPermissions:true},response,undefined,undefined,{idempotencyKey:key},options?.branchHooks,options?.signal);
      if(status>=400)throw Object.assign(new Error(typeof body==='object'&&body&&'error' in body?String(body.error):'Agent import failed'),{statusCode:status,provisionRejected:status===400||status===404});
      return body as ImportAgentPackageResponse;
    }),
  }};

}
