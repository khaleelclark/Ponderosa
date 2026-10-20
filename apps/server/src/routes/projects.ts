import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, promises as fs } from "@ponderosa/native-host/fs";
import path from "node:path";
import type {
  CreateProjectRequest,
  ModelOption,
  UpdateProjectRequest,
} from "@ponderosa/core";
import {
  readRepairableJsonl,
  managedWorkspacePath,
  pathEntryExists,
  ProjectDeletionInProgressError,
  stableJson,
  validateDeletionTombstone,
  writeAtomicFsyncedJsonl,
  type AgentStore,
  type WorkspaceStore,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, EngineRegistration, PersistentRuntime } from "../app-contracts.js";
import {
  chatCreationRuntimeSelection,
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
  prepareEngineModels(adapter: EngineRegistration["adapter"]): Promise<unknown>;
  cachedModelOptions(adapter: EngineRegistration["adapter"], projectId?: string): ModelOption[] | undefined;
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
  managedProjectCreationFault?: (boundary:
    | "receipt_persisted"
    | "marker_seed_persisted"
    | "preparation_directory_created"
    | "preparation_marker_installed"
    | "stage_published"
  ) => void | Promise<void>;
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
  phase: "preparing" | "staged" | "target_reserved" | "installed" |
    "content_preserved" | "cleanup_prepared" | "cleanup_authorized";
  cleanupDevice?: string;
  cleanupInode?: string;
}

type AnyManagedProjectCreationReceipt =
  | LegacyManagedProjectCreationReceipt
  | ManagedProjectCreationReceipt;

interface ManagedProjectFolderRecoveryStore {
  getProjectCreation(identity: Pick<ManagedProjectCreationIdentity,
    "idempotencyKey" | "payloadHash">): { hostPath: string } | undefined;
}

const MANAGED_PROJECT_CREATION_MARKER = ".ponderosa-project-creation.jsonl";

/** Receipts keep a stable identity; all managed IO remains under the held root.
 * Old descriptor numbers are never dereferenced during recovery. */
function managedProjectFolderPath(root: string, identity: ManagedProjectCreationIdentity): string {
  const parent = path.dirname(identity.hostPath);
  const name = path.basename(identity.hostPath);
  if ((parent !== realpathSync(root) && !/^\/proc\/self\/fd\/[0-9]+\/workspaces$/u.test(parent)) ||
      !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(name) || name === "." || name === "..") {
    throw new Error("managed Project creation receipt paths are invalid");
  }
  return path.join(root, name);
}

function managedProjectReceiptPath(root: string, idempotencyKey: string): string {
  return path.join(root, `.project-creation-${createHash("sha256").update(idempotencyKey).digest("hex")}.jsonl`);
}

function readManagedProjectReceipt(
  file: string,
  repair = true,
): AnyManagedProjectCreationReceipt | undefined {
  if (pathEntryExists(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("managed Project creation receipt is not a regular file");
    }
  }
  const records = readRepairableJsonl<unknown>(
    file, "managed Project creation receipt", repair,
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
        !["preparing", "staged", "target_reserved", "installed", "content_preserved",
          "cleanup_prepared", "cleanup_authorized"]
          .includes(candidate.phase ?? "") ||
        (candidate.phase === "cleanup_authorized" &&
          (!candidate.cleanupDevice || !candidate.cleanupInode))
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

function projectCreationIdentityMatches(
  actual: ManagedProjectCreationIdentity,
  expected: ManagedProjectCreationIdentity,
): boolean {
  return actual.idempotencyKey === expected.idempotencyKey &&
    actual.payloadHash === expected.payloadHash && actual.hostPath === expected.hostPath;
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

function managedProjectOperationArtifactPath(
  root: string,
  receipt: ManagedProjectCreationReceipt,
  suffix: "staging" | "preparing" | "marker.jsonl" | "cleanup",
): string {
  const keyHash = createHash("sha256").update(receipt.idempotencyKey).digest("hex");
  return path.join(root, `.project-creation-${keyHash}-${receipt.ownershipToken}.${suffix}`);
}

function managedProjectStagePath(root: string, receipt: ManagedProjectCreationReceipt): string {
  return managedProjectOperationArtifactPath(root, receipt, "staging");
}

function managedProjectPreparationPath(root: string, receipt: ManagedProjectCreationReceipt): string {
  return managedProjectOperationArtifactPath(root, receipt, "preparing");
}

function managedProjectMarkerSeedPath(root: string, receipt: ManagedProjectCreationReceipt): string {
  return managedProjectOperationArtifactPath(root, receipt, "marker.jsonl");
}

function managedProjectCleanupPath(root: string, receipt: ManagedProjectCreationReceipt): string {
  return managedProjectOperationArtifactPath(root, receipt, "cleanup");
}

function managedProjectOwnershipIdentity(receipt: ManagedProjectCreationReceipt) {
  return {
    version: 2 as const,
    idempotencyKey: receipt.idempotencyKey,
    payloadHash: receipt.payloadHash,
    hostPath: receipt.hostPath,
    ownershipToken: receipt.ownershipToken,
  };
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inspectManagedProjectDirectory(
  directory: string,
  receipt: ManagedProjectCreationReceipt,
  label: string,
): Promise<{
  path: string;
  markerPath: string;
  hasMarker: boolean;
  dev: number;
  ino: number;
} | undefined> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} is not an owned directory`);
    }
    const entries = await fs.readdir(directory);
    const markerPath = path.join(directory, MANAGED_PROJECT_CREATION_MARKER);
    const hasMarker = entries.includes(MANAGED_PROJECT_CREATION_MARKER);
    if (hasMarker) validateDeletionTombstone(
      directory,
      MANAGED_PROJECT_CREATION_MARKER,
      managedProjectOwnershipIdentity(receipt),
      label,
      { dev: stat.dev, ino: stat.ino },
    );
    if (entries.some((entry) => entry !== MANAGED_PROJECT_CREATION_MARKER)) {
      throw new Error(`${label} contains unowned content`);
    }
    return { path: directory, markerPath, hasMarker, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function inspectManagedProjectStage(
  root: string,
  receipt: ManagedProjectCreationReceipt,
) {
  return inspectManagedProjectDirectory(
    managedProjectStagePath(root, receipt),
    receipt,
    "Managed Project creation staging",
  );
}

async function inspectManagedProjectPreparation(
  root: string,
  receipt: ManagedProjectCreationReceipt,
) {
  return inspectManagedProjectDirectory(
    managedProjectPreparationPath(root, receipt),
    receipt,
    "Managed Project creation preparation",
  );
}

function readManagedProjectMarkerSeed(
  root: string,
  receipt: ManagedProjectCreationReceipt,
): AnyManagedProjectCreationReceipt | undefined {
  const seed = readManagedProjectReceipt(managedProjectMarkerSeedPath(root, receipt));
  if (seed) assertManagedProjectMarker(seed, receipt);
  return seed;
}

async function removeManagedProjectPreparation(
  root: string,
  receipt: ManagedProjectCreationReceipt,
): Promise<void> {
  let preparation = await inspectManagedProjectPreparation(root, receipt);
  const markerSeedPath = managedProjectMarkerSeedPath(root, receipt);
  const markerSeed = readManagedProjectMarkerSeed(root, receipt);
  if (preparation?.hasMarker && markerSeed) {
    throw new Error("managed Project creation has ambiguous marker authority");
  }
  if (preparation && !preparation.hasMarker) {
    if (!markerSeed) {
      throw new Error("managed Project creation preparation is not authenticated");
    }
    await fs.rename(markerSeedPath, preparation.markerPath);
    await syncDirectory(preparation.path);
    await syncDirectory(root);
    preparation = await inspectManagedProjectPreparation(root, receipt);
  }
  if (preparation?.hasMarker) {
    validateDeletionTombstone(
      preparation.path,
      MANAGED_PROJECT_CREATION_MARKER,
      managedProjectOwnershipIdentity(receipt),
      "Managed Project creation preparation",
      { dev: preparation.dev, ino: preparation.ino },
    );
    await fs.unlink(preparation.markerPath);
    await fs.rmdir(preparation.path);
    await syncDirectory(root);
  } else if (markerSeed) {
    await fs.unlink(markerSeedPath);
    await syncDirectory(root);
  }
}

async function prepareManagedProjectFolder(
  root: string,
  identity: ManagedProjectCreationIdentity,
  fault?: ProjectRoutesContext["managedProjectCreationFault"],
): Promise<AnyManagedProjectCreationReceipt> {
  const receiptPath = managedProjectReceiptPath(root, identity.idempotencyKey);
  let receipt = readManagedProjectReceipt(receiptPath);
  if (receipt) assertManagedProjectIdentity(receipt, identity);
  else {
    try {
      await fs.lstat(managedProjectFolderPath(root, identity));
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
    await fault?.("receipt_persisted");
  }
  if (receipt.version === 2 &&
      (receipt.phase === "content_preserved" || receipt.phase === "cleanup_prepared" ||
        receipt.phase === "cleanup_authorized")) {
    await removeManagedProjectFolderCreation(root, receipt);
    return prepareManagedProjectFolder(root, identity, fault);
  }

  const markerPath = path.join(managedProjectFolderPath(root, receipt), MANAGED_PROJECT_CREATION_MARKER);
  if (receipt.version === 1) {
    const marker = readManagedProjectReceipt(markerPath);
    if (marker) {
      assertManagedProjectMarker(marker, receipt);
      return receipt;
    }
    try {
      await fs.lstat(managedProjectFolderPath(root, receipt));
      await fs.unlink(receiptPath);
      await syncDirectory(root);
      throw new Error("folder already exists and is not owned by this Project creation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.unlink(receiptPath);
    await syncDirectory(root);
    return prepareManagedProjectFolder(root, identity, fault);
  }

  const stagePath = managedProjectStagePath(root, receipt);
  const preparationPath = managedProjectPreparationPath(root, receipt);
  const markerSeedPath = managedProjectMarkerSeedPath(root, receipt);
  let stage = await inspectManagedProjectStage(root, receipt);
  let preparation = await inspectManagedProjectPreparation(root, receipt);
  if (stage && preparation) {
    throw new Error("managed Project creation has ambiguous staged and preparation storage");
  }
  if (!stage) {
    let markerSeed = readManagedProjectMarkerSeed(root, receipt);
    if (!preparation) {
      if (!markerSeed) {
        writeAtomicFsyncedJsonl(markerSeedPath, [receipt]);
        await fault?.("marker_seed_persisted");
        markerSeed = readManagedProjectMarkerSeed(root, receipt);
      }
      try {
        await fs.mkdir(preparationPath, { recursive: false });
        await fault?.("preparation_directory_created");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      preparation = await inspectManagedProjectPreparation(root, receipt);
    }
    if (!preparation?.hasMarker) {
      if (!preparation || !markerSeed) {
        throw new Error("managed Project creation preparation is not authenticated");
      }
      await fs.rename(markerSeedPath, preparation.markerPath);
      await syncDirectory(preparationPath);
      await syncDirectory(root);
      await fault?.("preparation_marker_installed");
      preparation = await inspectManagedProjectPreparation(root, receipt);
    } else if (markerSeed) {
      throw new Error("managed Project creation has ambiguous marker authority");
    }
    await fs.rename(preparationPath, stagePath);
    await syncDirectory(root);
    await fault?.("stage_published");
    stage = await inspectManagedProjectStage(root, receipt);
  }
  if (!stage?.hasMarker) {
    throw new Error("managed Project creation staging is not authenticated");
  }
  const stageMarkerPath = stage.markerPath;
  if (receipt.phase === "preparing") {
    receipt = { ...receipt, phase: "staged" };
    writeAtomicFsyncedJsonl(receiptPath, [receipt]);
    writeAtomicFsyncedJsonl(stageMarkerPath, [receipt]);
  }

  // ponytail: Node has no portable rename-no-replace for directories; the lstat
  // preflight is the ceiling until the native host exposes renameat2/RENAME_NOREPLACE.
  try {
    const targetStat = await fs.lstat(managedProjectFolderPath(root, receipt));
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error("folder already exists and is not owned by this Project creation");
    }
    const targetEntries = await fs.readdir(managedProjectFolderPath(root, receipt));
    if (targetEntries.includes(MANAGED_PROJECT_CREATION_MARKER)) {
      validateDeletionTombstone(
        managedProjectFolderPath(root, receipt),
        MANAGED_PROJECT_CREATION_MARKER,
        managedProjectOwnershipIdentity(receipt),
        "Managed Project folder",
        { dev: targetStat.dev, ino: targetStat.ino },
      );
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
    await fs.rmdir(managedProjectFolderPath(root, receipt));
    await fs.rename(stagePath, managedProjectFolderPath(root, receipt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.rename(stagePath, managedProjectFolderPath(root, receipt));
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
  const preparation = receipt.version === 2
    ? await inspectManagedProjectPreparation(root, receipt)
    : undefined;
  if (stage && preparation) {
    throw new Error("managed Project creation has ambiguous staged and preparation storage");
  }
  const markerPath = path.join(managedProjectFolderPath(root, receipt), MANAGED_PROJECT_CREATION_MARKER);
  try {
    const targetStat = receipt.version === 2 ? await fs.lstat(managedProjectFolderPath(root, receipt)) : undefined;
    if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
      throw new Error("Managed Project folder is not the owned directory");
    }
    const markerPresent = pathEntryExists(markerPath);
    if (markerPresent) {
      if (receipt.version === 2) {
        validateDeletionTombstone(
          managedProjectFolderPath(root, receipt),
          MANAGED_PROJECT_CREATION_MARKER,
          managedProjectOwnershipIdentity(receipt),
          "Managed Project folder",
          { dev: targetStat!.dev, ino: targetStat!.ino },
        );
      } else {
        assertManagedProjectMarker(readManagedProjectReceipt(markerPath), receipt);
      }
      await fs.unlink(markerPath);
      await syncDirectory(managedProjectFolderPath(root, receipt));
    } else if (receipt.version === 2 && receipt.phase !== "installed") {
      throw new Error("managed Project folder was not installed before canonical Project creation");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stage) {
    if (stage.hasMarker) {
      validateDeletionTombstone(
        stage.path,
        MANAGED_PROJECT_CREATION_MARKER,
        managedProjectOwnershipIdentity(receipt as ManagedProjectCreationReceipt),
        "Managed Project creation staging",
        { dev: stage.dev, ino: stage.ino },
      );
      await fs.unlink(stage.markerPath);
    }
    await fs.rmdir(stage.path);
  }
  if (receipt.version === 2) await removeManagedProjectPreparation(root, receipt);
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
  if (receipt.version === 2) {
    let current = receipt;
    const cleanupPath = managedProjectCleanupPath(root, current);
    let targetExists = pathEntryExists(managedProjectFolderPath(root, current));
    let cleanupExists = pathEntryExists(cleanupPath);
    let preservedTarget = false;
    const initialStage = await inspectManagedProjectStage(root, current);
    const initialPreparation = await inspectManagedProjectPreparation(root, current);
    if (initialStage && initialPreparation) {
      throw new Error("managed Project cleanup has ambiguous staged and preparation storage");
    }
    if (initialPreparation || readManagedProjectMarkerSeed(root, current)) {
      await removeManagedProjectPreparation(root, current);
    }
    if (targetExists && cleanupExists) {
      throw new Error("managed Project cleanup has ambiguous target and tombstone storage");
    }
    if (targetExists) {
      const targetStat = await fs.lstat(managedProjectFolderPath(root, current));
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        throw new Error("Managed Project folder is not the owned directory");
      }
      const entries = await fs.readdir(managedProjectFolderPath(root, current));
      if (!entries.includes(MANAGED_PROJECT_CREATION_MARKER)) {
        if (current.phase === "target_reserved" && entries.length === 0) {
          await fs.rmdir(managedProjectFolderPath(root, current));
          await syncDirectory(root);
          targetExists = false;
        } else if (current.phase === "content_preserved") {
          preservedTarget = true;
        } else {
          throw new Error("Managed Project folder has no ownership marker");
        }
      } else {
        validateDeletionTombstone(
          managedProjectFolderPath(root, current),
          MANAGED_PROJECT_CREATION_MARKER,
          managedProjectOwnershipIdentity(current),
          "Managed Project folder",
          { dev: targetStat.dev, ino: targetStat.ino },
        );
        if (entries.some(entry => entry !== MANAGED_PROJECT_CREATION_MARKER)) {
          if (current.phase !== "content_preserved") {
            current = { ...current, phase: "content_preserved" };
            writeAtomicFsyncedJsonl(receiptPath, [current]);
          }
          await fs.unlink(path.join(managedProjectFolderPath(root, current), MANAGED_PROJECT_CREATION_MARKER));
          await syncDirectory(managedProjectFolderPath(root, current));
          preservedTarget = true;
        } else {
          if (current.phase !== "cleanup_prepared" && current.phase !== "cleanup_authorized") {
            current = { ...current, phase: "cleanup_prepared" };
            writeAtomicFsyncedJsonl(receiptPath, [current]);
          }
          await fs.rename(managedProjectFolderPath(root, current), cleanupPath);
          await syncDirectory(root);
          targetExists = false;
          cleanupExists = true;
        }
      }
    }
    const stage = await inspectManagedProjectStage(root, current);
    if (stage) {
      if (!stage.hasMarker) {
        throw new Error("managed Project creation staging is not authenticated");
      }
      if (targetExists || cleanupExists || current.phase === "content_preserved" ||
          current.phase === "cleanup_authorized") {
        throw new Error("managed Project cleanup has ambiguous staged storage");
      }
      validateDeletionTombstone(
        stage.path,
        MANAGED_PROJECT_CREATION_MARKER,
        managedProjectOwnershipIdentity(current),
        "Managed Project creation staging",
        { dev: stage.dev, ino: stage.ino },
      );
      if (current.phase !== "cleanup_prepared") {
        current = { ...current, phase: "cleanup_prepared" };
        writeAtomicFsyncedJsonl(receiptPath, [current]);
      }
      await fs.rename(stage.path, cleanupPath);
      await syncDirectory(root);
      cleanupExists = true;
    }
    if (cleanupExists) {
      const cleanupStat = await fs.lstat(cleanupPath);
      if (!cleanupStat.isDirectory() || cleanupStat.isSymbolicLink()) {
        throw new Error("Managed Project cleanup tombstone is not the owned directory");
      }
      const entries = await fs.readdir(cleanupPath);
      const hasMarker = entries.includes(MANAGED_PROJECT_CREATION_MARKER);
      if (hasMarker) {
        validateDeletionTombstone(
          cleanupPath,
          MANAGED_PROJECT_CREATION_MARKER,
          managedProjectOwnershipIdentity(current),
          "Managed Project cleanup tombstone",
          { dev: cleanupStat.dev, ino: cleanupStat.ino },
        );
        if (current.phase === "cleanup_authorized" &&
            (current.cleanupDevice !== String(cleanupStat.dev) ||
              current.cleanupInode !== String(cleanupStat.ino))) {
          throw new Error("Managed Project cleanup tombstone was replaced");
        }
        if (current.phase !== "cleanup_authorized") {
          current = {
            ...current,
            phase: "cleanup_authorized",
            cleanupDevice: String(cleanupStat.dev),
            cleanupInode: String(cleanupStat.ino),
          };
          writeAtomicFsyncedJsonl(receiptPath, [current]);
        }
        validateDeletionTombstone(
          cleanupPath,
          MANAGED_PROJECT_CREATION_MARKER,
          managedProjectOwnershipIdentity(current),
          "Managed Project cleanup tombstone",
          { dev: current.cleanupDevice!, ino: current.cleanupInode! },
        );
        await fs.rm(cleanupPath, { recursive: true });
        await syncDirectory(root);
      } else {
        if (current.phase !== "cleanup_authorized" || entries.length > 0 ||
            current.cleanupDevice !== String(cleanupStat.dev) ||
            current.cleanupInode !== String(cleanupStat.ino)) {
          throw new Error("Managed Project cleanup tombstone lost its ownership marker");
        }
        await fs.rmdir(cleanupPath);
        await syncDirectory(root);
      }
    } else if (current.phase === "cleanup_prepared") {
      throw new Error("Managed Project cleanup tombstone is missing before removal authority");
    }
    if (!preservedTarget && !cleanupExists && current.phase !== "preparing" &&
        current.phase !== "cleanup_authorized") {
      throw new Error("Managed Project creation storage is missing before cleanup completed");
    }
    await fs.unlink(receiptPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(root);
    return;
  }
  const markerPath = path.join(managedProjectFolderPath(root, receipt), MANAGED_PROJECT_CREATION_MARKER);
  const marker = readManagedProjectReceipt(markerPath);
  if (marker) assertManagedProjectMarker(marker, receipt);
  try {
    if (marker) {
      await fs.unlink(markerPath);
      if ((await fs.readdir(managedProjectFolderPath(root, receipt))).length === 0) await fs.rmdir(managedProjectFolderPath(root, receipt));
    }
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.unlink(receiptPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await syncDirectory(root);
}

async function reconcileOrphanManagedProjectStages(
  root: string,
  store: ManagedProjectFolderRecoveryStore,
  reportError: (error: unknown, stagePath: string) => void,
): Promise<void> {
  const stagePattern = /^\.project-creation-([0-9a-f]{64})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging$/u;
  for (const name of await fs.readdir(root)) {
    const match = stagePattern.exec(name);
    if (!match) continue;
    const stagePath = path.join(root, name);
    try {
      const markerPath = path.join(stagePath, MANAGED_PROJECT_CREATION_MARKER);
      // A token-shaped directory is not authority: do not repair or otherwise
      // mutate its marker until its exact identity has been authenticated.
      const receipt = readManagedProjectReceipt(markerPath, false);
      if (!receipt || receipt.version !== 2 ||
          createHash("sha256").update(receipt.idempotencyKey).digest("hex") !== match[1] ||
          receipt.ownershipToken !== match[2] ||
          path.dirname(managedProjectFolderPath(root, receipt)) !== path.resolve(root)) {
        continue;
      }
      const current = readManagedProjectReceipt(
        managedProjectReceiptPath(root, receipt.idempotencyKey),
      );
      if (current?.version === 2 && current.ownershipToken === receipt.ownershipToken) continue;
      if (current) {
        assertManagedProjectIdentity(current, receipt);
      } else {
        let settled = false;
        try {
          settled = Boolean(store.getProjectCreation(receipt));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("already deleted")) throw error;
          settled = true;
        }
        if (!settled) continue;
      }
      const inspected = await inspectManagedProjectStage(root, receipt);
      if (!inspected?.hasMarker) continue;
      validateDeletionTombstone(
        inspected.path,
        MANAGED_PROJECT_CREATION_MARKER,
        managedProjectOwnershipIdentity(receipt),
        "Orphan managed Project creation staging",
        { dev: inspected.dev, ino: inspected.ino },
      );
      await fs.unlink(inspected.markerPath);
      await fs.rmdir(inspected.path);
      await syncDirectory(root);
    } catch (error) {
      reportError(error, stagePath);
    }
  }
}

async function reconcileManagedProjectFolders(
  root: string,
  store: ManagedProjectFolderRecoveryStore,
  reportError: (error: unknown, receiptFile: string) => void,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  // Reconcile token-scoped siblings while the receipt still provides durable
  // authority for aborted races where no canonical Project was committed.
  await reconcileOrphanManagedProjectStages(root, store, reportError);
  for (const name of await fs.readdir(root)) {
    if (!/^\.project-creation-[0-9a-f]{64}\.jsonl$/u.test(name)) continue;
    const receiptPath = path.join(root, name);
    try {
      const receipt = readManagedProjectReceipt(receiptPath);
      if (!receipt) continue;
      const resolvedRoot = path.resolve(root);
      if (path.dirname(managedProjectFolderPath(root, receipt)) !== resolvedRoot || managedProjectFolderPath(root, receipt) === resolvedRoot ||
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
        if (project.hostPath !== await fs.realpath(managedProjectFolderPath(root, receipt))) {
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
    cachedModelOptions,
    prepareEngineModels,
    appendWorkspace,
    refreshCommunicationReconciliation,
    managedProjectCreationFault,
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
  const projectCreationClaims = new Map<string, {
    identity: ManagedProjectCreationIdentity;
    completion: Promise<void>;
    complete: () => void;
  }>();
  const claimProjectCreation = async (
    identity: ManagedProjectCreationIdentity,
  ): Promise<() => void> => {
    for (;;) {
      const active = projectCreationClaims.get(identity.idempotencyKey);
      if (active) {
        if (!projectCreationIdentityMatches(active.identity, identity)) {
          throw new Error("Project creation key was reused with different input");
        }
        await active.completion;
        continue;
      }
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => { complete = resolve; });
      const claim = { identity, completion, complete };
      projectCreationClaims.set(identity.idempotencyKey, claim);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (projectCreationClaims.get(identity.idempotencyKey) === claim) {
          projectCreationClaims.delete(identity.idempotencyKey);
        }
        complete();
      };
    }
  };

  app.post("/api/projects", async (_request, reply) => reply.code(410).send({ code: "project_namespace_retired", error: "Create a Chat through /api/chats. Project namespaces are retained for storage compatibility." }));
  app.post<{ Body: CreateProjectRequest; Headers: { "idempotency-key"?: string } }>("/api/chats", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"]?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
      return reply.code(400).send({ error: "a valid Chat creation idempotency key is required" });
    }
    const label = request.body?.label?.trim() || "New Chat";
    if (!label) return reply.code(400).send({ error: "label is required" });
    const defaultEngine = request.body?.defaultEngine;
    if (!defaultEngine) return reply.code(400).send({ error: "a configured default engine is required" });
    if (request.body.hostPath && request.body.createFolderName) return reply.code(400).send({ error: "choose an existing folder or create a new one, not both" });
    const requestedName = request.body.createFolderName?.trim() ||
      `chat-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`;
    if (!request.body.hostPath &&
        (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u.test(requestedName) ||
          requestedName === "." || requestedName === "..")) {
      return reply.code(400).send({ error: "folder name must be a single safe name" });
    }
    let hostPath = request.body.hostPath
      ? path.resolve(request.body.hostPath)
      : managedWorkspacePath(path.dirname(managedWorkspacesRoot), requestedName);
    const creationHostPath = request.body.hostPath ? hostPath :
      store.getManagedCreationHostPath(idempotencyKey, requestedName) ?? `managed:workspaces/${requestedName}`;
    const creationIdentity = {
      idempotencyKey,
      payloadHash: createHash("sha256").update(stableJson({
        ownership: "chat",
        label,
        hostPath: creationHostPath,
        defaultEngine,
        defaultModel: request.body.defaultModel ?? null,
        defaultEffort: request.body.defaultEffort ?? null,
        defaultSpeed: request.body.defaultSpeed ?? null,
      })).digest("hex"),
    };
    const managedIdentity: ManagedProjectCreationIdentity | undefined = request.body.hostPath
      ? undefined
      : { ...creationIdentity, hostPath };
    let releaseCreationClaim: (() => void) | undefined;
    try {
      releaseCreationClaim = await claimProjectCreation({ ...creationIdentity, hostPath });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Project creation replay conflict",
      });
    }
    try {
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
      return store.getConversation(replay.lastConversationId!);
    }
    if (!engines.has(defaultEngine)) return reply.code(400).send({ error: "a configured default engine is required" });
    const creationAdapter = engines.get(defaultEngine)!.adapter;
    await prepareEngineModels(creationAdapter);
    const creationModelOptions = cachedModelOptions(creationAdapter);
    const resolvedCreation = chatCreationRuntimeSelection(creationAdapter, {
      model: request.body.defaultModel,
      effort: request.body.defaultEffort,
      speed: request.body.defaultSpeed,
    }, workspace.getPreferences().engineDefaults?.[defaultEngine], creationModelOptions);
    if (resolvedCreation.error) return reply.code(400).send({ error: resolvedCreation.error });
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
        managedReceipt = await prepareManagedProjectFolder(
          managedWorkspacesRoot,
          managedIdentity,
          managedProjectCreationFault,
        );
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
        chatOwned: true,
        hostPath,
        ...(!request.body.hostPath ? { managedWorkspaceName: requestedName, creationHostPath } : {}),
        defaultEngine,
        ...(resolvedCreation.model ? { defaultModel: resolvedCreation.model } : {}),
        ...(resolvedCreation.effort ? { defaultEffort: resolvedCreation.effort } : {}),
        defaultSpeed: resolvedCreation.speed,
      }, creationIdentity);
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
    return store.getConversation(project.lastConversationId!);
    } finally {
      releaseCreationClaim?.();
    }
  });

  app.post<{ Params: { id: string }; Body: { conversationId?: string } }>("/api/projects/:id/use", async (request, reply) => {
    try {
      const project = store.markProjectUsed(request.params.id, request.body?.conversationId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      appendWorkspace({ type: "project_changed", projectId: project.id, action: "used" });
      if (request.body?.conversationId) appendWorkspace({ type: "conversation_changed", projectId: project.id, conversationId: request.body.conversationId, action: "used" });
      return project;
    } catch (error) {
      if (error instanceof ProjectDeletionInProgressError) throw error;
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
    return reply.code(410).send({ code: "project_namespace_retired", error: "Update the owning Chat through /api/conversations/:id. Project namespace settings are retired." });
  });

  return { reconcileManagedProjectFolders: reconcileManagedFolders };
}
