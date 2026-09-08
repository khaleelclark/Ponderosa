import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreateProjectRequest,
  ModelOption,
  UpdateProjectRequest,
} from "@ponderosa/core";
import {
  readRepairableJsonl,
  stableJson,
  writeAtomicFsyncedJsonl,
  type AgentStore,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, EngineRegistration, PersistentRuntime } from "../app-contracts.js";
import {
  concreteRuntimeSelection,
  runtimeSelectionError,
} from "../runtime-selection.js";
import {
  registerProjectFolderRoutes,
  type ProjectFolderPathBoundary,
} from "./project-folders.js";

interface ProjectRoutesContext {
  store: AgentStore;
  workspace: WorkspaceStore;
  engines: ReadonlyMap<string, EngineRegistration>;
  managedWorkspacesRoot: string;
  projectFolderPathBoundary: ProjectFolderPathBoundary;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  scheduledSessionRollovers: Map<string, string>;
  organizationEnvelopeStates: Map<string, { sessionId: string; hash: string }>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[];
  appendWorkspace(event: Parameters<WorkspaceStore["append"]>[0]): unknown;
  refreshCommunicationReconciliation(projectId: string): void;
  clearAgentResumeSession(agentId: string, reason: string): void;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  teardownPersistentRuntime(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
    projectId: string,
  ): Promise<void>;
}

interface ManagedProjectCreationIdentity {
  idempotencyKey: string;
  payloadHash: string;
  hostPath: string;
}

interface LegacyManagedProjectCreationReceipt extends ManagedProjectCreationIdentity {
  version: 1;
}

interface ManagedProjectCreationReceipt extends ManagedProjectCreationIdentity {
  version: 2;
  ownershipToken: string;
  phase: "preparing" | "staged" | "target_reserved" | "installed";
}

type AnyManagedProjectCreationReceipt =
  | LegacyManagedProjectCreationReceipt
  | ManagedProjectCreationReceipt;

interface ManagedProjectFolderRecoveryStore {
  getProjectCreation(identity: Pick<ManagedProjectCreationIdentity,
    "idempotencyKey" | "payloadHash">): { hostPath: string } | undefined;
}

const MANAGED_PROJECT_CREATION_MARKER = ".ponderosa-project-creation.jsonl";

function managedProjectReceiptPath(root: string, idempotencyKey: string): string {
  return path.join(root, `.project-creation-${createHash("sha256").update(idempotencyKey).digest("hex")}.jsonl`);
}

function readManagedProjectReceipt(file: string): AnyManagedProjectCreationReceipt | undefined {
  const records = readRepairableJsonl<unknown>(
    file, "managed Project creation receipt", true,
  );
  if (records.length === 0) return undefined;
  if (records.length !== 1) throw new Error("managed Project creation receipt is invalid");
  const receipt = records[0];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("managed Project creation receipt is invalid");
  }
  const candidate = receipt as Partial<AnyManagedProjectCreationReceipt>;
  if ((candidate.version !== 1 && candidate.version !== 2) ||
      typeof candidate.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(candidate.idempotencyKey) ||
      typeof candidate.payloadHash !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.payloadHash) ||
      typeof candidate.hostPath !== "string" || !path.isAbsolute(candidate.hostPath) ||
      (candidate.version === 2 && (
        typeof candidate.ownershipToken !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate.ownershipToken) ||
        !["preparing", "staged", "target_reserved", "installed"].includes(candidate.phase ?? "")
      ))) throw new Error("managed Project creation receipt is invalid");
  return candidate as AnyManagedProjectCreationReceipt;
}

function assertManagedProjectReceipt(
  actual: AnyManagedProjectCreationReceipt | undefined,
  expected: AnyManagedProjectCreationReceipt,
): void {
  if (!actual || stableJson(actual) !== stableJson(expected)) {
    throw new Error("managed Project creation key was reused with different input");
  }
}

function assertManagedProjectIdentity(
  actual: AnyManagedProjectCreationReceipt | undefined,
  expected: ManagedProjectCreationIdentity,
): asserts actual is AnyManagedProjectCreationReceipt {
  if (!actual || actual.idempotencyKey !== expected.idempotencyKey ||
      actual.payloadHash !== expected.payloadHash || actual.hostPath !== expected.hostPath) {
    throw new Error("managed Project creation key was reused with different input");
  }
}

function assertManagedProjectMarker(
  marker: AnyManagedProjectCreationReceipt | undefined,
  receipt: AnyManagedProjectCreationReceipt,
): void {
  assertManagedProjectIdentity(marker, receipt);
  if (marker.version !== receipt.version ||
      (marker.version === 2 && receipt.version === 2 &&
        marker.ownershipToken !== receipt.ownershipToken)) {
    throw new Error("managed Project creation marker does not match its receipt");
  }
}

function managedProjectStagePath(root: string, receipt: ManagedProjectCreationReceipt): string {
  const keyHash = createHash("sha256").update(receipt.idempotencyKey).digest("hex");
  return path.join(root, `.project-creation-${keyHash}-${receipt.ownershipToken}.staging`);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inspectManagedProjectStage(
  root: string,
  receipt: ManagedProjectCreationReceipt,
): Promise<{ path: string; markerPath: string; hasMarker: boolean } | undefined> {
  const stagePath = managedProjectStagePath(root, receipt);
  try {
    const entries = await fs.readdir(stagePath);
    const markerPath = path.join(stagePath, MANAGED_PROJECT_CREATION_MARKER);
    const hasMarker = entries.includes(MANAGED_PROJECT_CREATION_MARKER);
    if (hasMarker) assertManagedProjectMarker(readManagedProjectReceipt(markerPath), receipt);
    if (entries.some((entry) => entry !== MANAGED_PROJECT_CREATION_MARKER)) {
      throw new Error("managed Project creation staging contains unowned content");
    }
    return { path: stagePath, markerPath, hasMarker };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepareManagedProjectFolder(
  root: string,
  identity: ManagedProjectCreationIdentity,
): Promise<AnyManagedProjectCreationReceipt> {
  const receiptPath = managedProjectReceiptPath(root, identity.idempotencyKey);
  let receipt = readManagedProjectReceipt(receiptPath);
  if (receipt) assertManagedProjectIdentity(receipt, identity);
  else {
    try {
      await fs.lstat(identity.hostPath);
      throw new Error("folder already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    receipt = {
      version: 2,
      ...identity,
      ownershipToken: randomUUID(),
      phase: "preparing",
    };
    writeAtomicFsyncedJsonl(receiptPath, [receipt]);
  }

  const markerPath = path.join(receipt.hostPath, MANAGED_PROJECT_CREATION_MARKER);
  if (receipt.version === 1) {
    const marker = readManagedProjectReceipt(markerPath);
    if (marker) {
      assertManagedProjectMarker(marker, receipt);
      return receipt;
    }
    try {
      await fs.lstat(receipt.hostPath);
      await fs.unlink(receiptPath);
      await syncDirectory(root);
      throw new Error("folder already exists and is not owned by this Project creation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.unlink(receiptPath);
    await syncDirectory(root);
    return prepareManagedProjectFolder(root, identity);
  }

  const stagePath = managedProjectStagePath(root, receipt);
  const stageMarkerPath = path.join(stagePath, MANAGED_PROJECT_CREATION_MARKER);
  try {
    await fs.mkdir(stagePath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stage = await inspectManagedProjectStage(root, receipt);
  if (!stage?.hasMarker) {
    writeAtomicFsyncedJsonl(stageMarkerPath, [receipt]);
    await syncDirectory(stagePath);
  }
  if (receipt.phase === "preparing") {
    receipt = { ...receipt, phase: "staged" };
    writeAtomicFsyncedJsonl(receiptPath, [receipt]);
    writeAtomicFsyncedJsonl(stageMarkerPath, [receipt]);
  }

  try {
    const targetEntries = await fs.readdir(receipt.hostPath);
    if (targetEntries.includes(MANAGED_PROJECT_CREATION_MARKER)) {
      assertManagedProjectMarker(readManagedProjectReceipt(markerPath), receipt);
      if (receipt.phase !== "installed") {
        receipt = { ...receipt, phase: "installed" };
        writeAtomicFsyncedJsonl(receiptPath, [receipt]);
        writeAtomicFsyncedJsonl(markerPath, [receipt]);
      }
      return receipt;
    }
    if (receipt.phase !== "target_reserved" || targetEntries.length > 0) {
      throw new Error("folder already exists and is not owned by this Project creation");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(receipt.hostPath, { recursive: false });
    receipt = { ...receipt, phase: "target_reserved" };
    writeAtomicFsyncedJsonl(receiptPath, [receipt]);
  }

  try {
    await fs.rename(stagePath, receipt.hostPath);
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") &&
        receipt.phase === "target_reserved" &&
        (await fs.readdir(receipt.hostPath)).length === 0) {
      await fs.rmdir(receipt.hostPath);
      await fs.rename(stagePath, receipt.hostPath);
    } else {
      throw error;
    }
  }
  await syncDirectory(root);
  receipt = { ...receipt, phase: "installed" };
  writeAtomicFsyncedJsonl(receiptPath, [receipt]);
  writeAtomicFsyncedJsonl(markerPath, [receipt]);
  return receipt;
}

async function finishManagedProjectFolder(
  root: string,
  identity: ManagedProjectCreationIdentity,
): Promise<void> {
  const receiptPath = managedProjectReceiptPath(root, identity.idempotencyKey);
  const receipt = readManagedProjectReceipt(receiptPath);
  if (!receipt) return;
  assertManagedProjectIdentity(receipt, identity);
  const stage = receipt.version === 2
    ? await inspectManagedProjectStage(root, receipt)
    : undefined;
  const markerPath = path.join(receipt.hostPath, MANAGED_PROJECT_CREATION_MARKER);
  try {
    const marker = readManagedProjectReceipt(markerPath);
    if (marker) {
      assertManagedProjectMarker(marker, receipt);
      await fs.unlink(markerPath);
      await syncDirectory(receipt.hostPath);
    } else if (receipt.version === 2 && receipt.phase !== "installed") {
      throw new Error("managed Project folder was not installed before canonical Project creation");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stage) {
    if (stage.hasMarker) await fs.unlink(stage.markerPath);
    await fs.rmdir(stage.path);
  }
  await fs.unlink(receiptPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(root);
}

async function removeManagedProjectFolderCreation(
  root: string,
  receipt: AnyManagedProjectCreationReceipt,
): Promise<void> {
  const receiptPath = managedProjectReceiptPath(root, receipt.idempotencyKey);
  assertManagedProjectReceipt(readManagedProjectReceipt(receiptPath), receipt);
  const markerPath = path.join(receipt.hostPath, MANAGED_PROJECT_CREATION_MARKER);
  const marker = readManagedProjectReceipt(markerPath);
  if (marker) assertManagedProjectMarker(marker, receipt);
  const stage = receipt.version === 2
    ? await inspectManagedProjectStage(root, receipt)
    : undefined;
  try {
    if (marker) {
      await fs.unlink(markerPath);
      if ((await fs.readdir(receipt.hostPath)).length === 0) await fs.rmdir(receipt.hostPath);
    }
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stage) {
    if (stage.hasMarker) await fs.unlink(stage.markerPath);
    await fs.rmdir(stage.path);
  }
  await fs.unlink(receiptPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(root);
}

async function reconcileManagedProjectFolders(
  root: string,
  store: ManagedProjectFolderRecoveryStore,
  reportError: (error: unknown, receiptFile: string) => void,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const name of await fs.readdir(root)) {
    if (!/^\.project-creation-[0-9a-f]{64}\.jsonl$/u.test(name)) continue;
    const receiptPath = path.join(root, name);
    try {
      const receipt = readManagedProjectReceipt(receiptPath);
      if (!receipt) continue;
      const resolvedRoot = path.resolve(root);
      if (path.dirname(receipt.hostPath) !== resolvedRoot || receipt.hostPath === resolvedRoot ||
          managedProjectReceiptPath(resolvedRoot, receipt.idempotencyKey) !== receiptPath) {
        throw new Error("managed Project creation receipt paths are invalid");
      }
      let project: { hostPath: string } | undefined;
      try {
        project = store.getProjectCreation(receipt);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("already deleted")) throw error;
      }
      if (project) {
        if (project.hostPath !== receipt.hostPath) {
          throw new Error("managed Project creation Project path does not match its receipt");
        }
        await finishManagedProjectFolder(root, receipt);
      } else {
        await removeManagedProjectFolderCreation(root, receipt);
      }
    } catch (error) {
      reportError(error, receiptPath);
    }
  }
}

export function registerProjectRoutes(
  app: FastifyInstance,
  context: ProjectRoutesContext,
): { reconcileManagedProjectFolders(): Promise<void> } {
  const {
    store,
    workspace,
    engines,
    managedWorkspacesRoot,
    projectFolderPathBoundary,
    activeRuns,
    scheduledSessionRollovers,
    organizationEnvelopeStates,
    cachedModelOptions,
    appendWorkspace,
    refreshCommunicationReconciliation,
    clearAgentResumeSession,
    persistentRuntimeForTermination,
    teardownPersistentRuntime,
  } = context;

  registerProjectFolderRoutes(app, {
    managedWorkspacesRoot,
    pathBoundary: projectFolderPathBoundary,
    store,
  });
  const reconcileManagedFolders = () => reconcileManagedProjectFolders(
    managedWorkspacesRoot,
    store,
    (error, receiptFile) => app.log.error(
      { err: error, receiptFile },
      "Managed Project folder recovery requires attention",
    ),
  );
  app.addHook("onReady", reconcileManagedFolders);

  app.post<{ Body: CreateProjectRequest; Headers: { "idempotency-key"?: string } }>("/api/projects", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"]?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
      return reply.code(400).send({ error: "a valid Project creation idempotency key is required" });
    }
    const label = request.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: "label is required" });
    const defaultEngine = request.body?.defaultEngine;
    if (!defaultEngine) return reply.code(400).send({ error: "a configured default engine is required" });
    if (request.body.hostPath && request.body.createFolderName) return reply.code(400).send({ error: "choose an existing folder or create a new one, not both" });
    const requestedName = request.body.createFolderName?.trim() ||
      `project-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`;
    if (!request.body.hostPath &&
        (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(requestedName) ||
          requestedName === "." || requestedName === "..")) {
      return reply.code(400).send({ error: "folder name must be a single safe name" });
    }
    let hostPath = request.body.hostPath
      ? path.resolve(request.body.hostPath)
      : path.join(managedWorkspacesRoot, requestedName);
    const creationIdentity = {
      idempotencyKey,
      payloadHash: createHash("sha256").update(stableJson({
        label,
        hostPath,
        defaultEngine,
        defaultModel: request.body.defaultModel ?? null,
        defaultEffort: request.body.defaultEffort ?? null,
      })).digest("hex"),
    };
    const managedIdentity: ManagedProjectCreationIdentity | undefined = request.body.hostPath
      ? undefined
      : { ...creationIdentity, hostPath };
    let replay;
    try {
      replay = store.getProjectCreation(creationIdentity);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Project creation replay conflict",
      });
    }
    if (replay) {
      if (managedIdentity) await finishManagedProjectFolder(managedWorkspacesRoot, managedIdentity);
      return replay;
    }
    if (!engines.has(defaultEngine)) return reply.code(400).send({ error: "a configured default engine is required" });
    const creationAdapter = engines.get(defaultEngine)!.adapter;
    const creationModelOptions = cachedModelOptions(creationAdapter);
    const selectionError = runtimeSelectionError(
      creationAdapter,
      request.body.defaultModel,
      request.body.defaultEffort,
      creationModelOptions,
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    await fs.mkdir(managedWorkspacesRoot, { recursive: true });
    if (request.body.hostPath) {
      try {
        const stat = await fs.stat(hostPath);
        if (!stat.isDirectory()) return reply.code(400).send({ error: "hostPath must be a directory" });
        const validated = await projectFolderPathBoundary.validatedBrowsePath(hostPath);
        hostPath = validated.candidate;
      } catch {
        return reply.code(400).send({ error: "hostPath does not exist" });
      }
    }
    let managedReceipt: AnyManagedProjectCreationReceipt | undefined;
    if (managedIdentity) {
      try {
        managedReceipt = await prepareManagedProjectFolder(managedWorkspacesRoot, managedIdentity);
      } catch (error) {
        if (error instanceof Error && (error.message.includes("reused with different input") ||
            error.message.includes("folder already exists"))) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
    let project;
    try {
      project = store.createProject({
        label,
        hostPath,
        defaultEngine,
        ...(request.body.defaultModel ? { defaultModel: request.body.defaultModel } : {}),
        ...(request.body.defaultEffort ? { defaultEffort: request.body.defaultEffort } : {}),
      }, creationIdentity);
      if (project.lastConversationId) {
        const resolved = concreteRuntimeSelection(creationAdapter, [
          { model: project.defaultModel, effort: project.defaultEffort },
          workspace.getPreferences().engineDefaults?.[defaultEngine],
        ], creationModelOptions);
        store.updateConversation(project.lastConversationId, {
          defaultEngine,
          defaultModel: resolved.model ?? null,
          defaultEffort: resolved.effort ?? null,
        });
      }
    } catch (error) {
      const committed = store.getProjectCreation(creationIdentity);
      if (committed) project = committed;
      else {
        if (managedReceipt) {
          await removeManagedProjectFolderCreation(managedWorkspacesRoot, managedReceipt);
        }
        throw error;
      }
    }
    if (managedIdentity) await finishManagedProjectFolder(managedWorkspacesRoot, managedIdentity);
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "created" });
    refreshCommunicationReconciliation(project.id);
    if (project.lastConversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: project.lastConversationId, action: "created" });
    return project;
  });

  app.post<{ Params: { id: string }; Body: { conversationId?: string } }>("/api/projects/:id/use", async (request, reply) => {
    try {
      const project = store.markProjectUsed(request.params.id, request.body?.conversationId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      appendWorkspace({ type: "project_changed", projectId: project.id, action: "used" });
      if (request.body?.conversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: request.body.conversationId, action: "used" });
      return project;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be selected" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = store.getProject(request.params.id);
    return project ?? reply.code(404).send({ error: "project not found" });
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>("/api/projects/:id", async (request, reply) => {
    const current = store.getProject(request.params.id);
    if (!current) return reply.code(404).send({ error: "project not found" });
    const label = request.body?.label?.trim() ?? current.label;
    if (!label) return reply.code(400).send({ error: "label is required" });
    if (request.body.instructions !== undefined && typeof request.body.instructions !== "string") return reply.code(400).send({ error: "instructions must be a string" });
    const defaultEngine = request.body.defaultEngine ?? current.defaultEngine;
    const engineChanged = defaultEngine !== current.defaultEngine;
    if (!engines.has(defaultEngine)) return reply.code(400).send({ error: "unknown engine" });
    const defaultModel = request.body.defaultModel === null ? undefined : request.body.defaultModel ?? (engineChanged ? undefined : current.defaultModel);
    const defaultEffort = request.body.defaultEffort === null ? undefined : request.body.defaultEffort ?? (engineChanged ? undefined : current.defaultEffort);
    const projectAdapter = engines.get(defaultEngine)!.adapter;
    const selectionError = runtimeSelectionError(
      projectAdapter,
      defaultModel,
      defaultEffort,
      cachedModelOptions(projectAdapter, current.id),
    );
    if (selectionError) return reply.code(400).send({ error: selectionError });
    const instructionsChanged = request.body.instructions !== undefined && request.body.instructions !== (current.instructions ?? "");
    const project = store.updateProject(request.params.id, {
      label,
      defaultEngine,
      defaultModel: defaultModel ?? null,
      defaultEffort: defaultEffort ?? null,
      ...(request.body.instructions !== undefined ? { instructions: request.body.instructions } : {}),
    });
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (instructionsChanged) for (const agent of store.listAgents(project.id)) {
      organizationEnvelopeStates.delete(agent.id);
      if (activeRuns.has(agent.id)) scheduledSessionRollovers.set(agent.id, new Date().toISOString());
      else {
        clearAgentResumeSession(agent.id, "request_context_rollover");
        const runtime = persistentRuntimeForTermination(agent.id);
        if (runtime) await teardownPersistentRuntime(agent.id, runtime, "Project instruction update", project.id);
      }
    }
    appendWorkspace({ type: "project_changed", projectId: project.id, action: "updated" });
    return project;
  });

  return { reconcileManagedProjectFolders: reconcileManagedFolders };
}
