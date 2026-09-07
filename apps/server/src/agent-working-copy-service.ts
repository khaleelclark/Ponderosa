import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AgentWorkingCopyUnavailableError,
  resolveAgentWorkingCopy,
  sharedWorkingCopy,
  type AgentStore,
  type ResolvedAgentWorkingCopy,
} from "@ponderosa/agents";
import type {
  AgentDto,
  AgentWorkingCopyDto,
  AgentWorkingCopyMode,
  ProjectDto,
} from "@ponderosa/core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const CREATION_OWNERSHIP_REF = /^refs\/ponderosa\/working-copy-creation\/[0-9a-f]{32}$/u;
const CLEANUP_OWNERSHIP_REF = /^refs\/ponderosa\/working-copy-cleanup\/[0-9a-f]{32}$/u;

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) delete environment[name];
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`);
}

function separateBranch(agent: Pick<AgentDto, "id" | "title">): string {
  const label = agent.title.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32) || "agent";
  return `ponderosa/${label}-${agent.id.replaceAll("-", "").slice(0, 10)}`;
}

function creationOwnershipRef(): string {
  return `refs/ponderosa/working-copy-creation/${randomUUID().replaceAll("-", "")}`;
}

function cleanupOwnershipRef(): string {
  return `refs/ponderosa/working-copy-cleanup/${randomUUID().replaceAll("-", "")}`;
}

function deleteOwnedBranchReferences(
  projectRoot: string,
  branch: string,
  ownershipRef: string,
  branchHead: string,
): void {
  execFileSync("git", ["--no-optional-locks", "update-ref", "--stdin"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    input: [
      "start",
      `delete refs/heads/${branch} ${branchHead}`,
      `delete ${ownershipRef} ${branchHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  });
}

function safeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Git could not prepare the folder.";
  const firstLine = detail.split(/[\r\n]/u, 1)[0]?.trim();
  return `Separate Git copy is unavailable. ${firstLine || "Git could not prepare the folder."}`.slice(0, 600);
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function exitedWithStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === status;
}

async function gitBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (exitedWithStatus(error, 1)) return false;
    throw error;
  }
}

async function gitBranchHead(projectRoot: string, branch: string): Promise<string> {
  return runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
}

async function gitReferenceHead(projectRoot: string, reference: string): Promise<string | undefined> {
  try {
    return await runGit(projectRoot, ["rev-parse", "--verify", `${reference}^{commit}`]);
  } catch (error) {
    if (exitedWithStatus(error, 128)) return undefined;
    throw error;
  }
}

function createOwnedBranchReferences(
  projectRoot: string,
  branch: string,
  ownershipRef: string,
  branchHead: string,
): void {
  execFileSync("git", ["--no-optional-locks", "update-ref", "--stdin"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    input: [
      "start",
      `create refs/heads/${branch} ${branchHead}`,
      `create ${ownershipRef} ${branchHead}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  });
}

async function gitWorktreeBranchRoots(
  projectRoot: string,
  branch: string,
): Promise<string[]> {
  const output = await runGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  const expectedBranch = `refs/heads/${branch}`;
  return output.split("\0\0").flatMap((record) => {
    let root: string | undefined;
    let registeredBranch: string | undefined;
    for (const field of record.split("\0")) {
      if (field.startsWith("worktree ")) root = field.slice("worktree ".length);
      if (field.startsWith("branch ")) registeredBranch = field.slice("branch ".length);
    }
    return root !== undefined && registeredBranch === expectedBranch
      ? [path.resolve(root)]
      : [];
  });
}

async function gitWorktreeRegistrationExact(
  projectRoot: string,
  expectedRoot: string,
  branch: string,
): Promise<boolean> {
  const roots = await gitWorktreeBranchRoots(projectRoot, branch);
  return roots.length === 1 && samePath(roots[0]!, expectedRoot);
}

async function gitWorktreeRootRegistered(
  projectRoot: string,
  expectedRoot: string,
): Promise<boolean> {
  const output = await runGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  return output.split("\0\0").some((record) =>
    record.split("\0").some((field) =>
      field.startsWith("worktree ") &&
      samePath(path.resolve(field.slice("worktree ".length)), expectedRoot)));
}

export class AgentWorkingCopyService {
  private readonly managedRoot: string;
  private readonly modeChanges = new Map<string, {
    completion: Promise<void>;
    complete: () => void;
  }>();
  private readonly activeUses = new Map<string, {
    count: number;
    completion: Promise<void>;
    complete: () => void;
  }>();

  constructor(
    dataDir: string,
    private readonly store: Pick<
      AgentStore,
      "getAgent" | "listProjectWorkingCopies" | "updateAgentWorkingCopy" |
      "updateDeletedAgentWorkingCopy"
    >,
  ) {
    this.managedRoot = path.resolve(dataDir, "working-copies");
  }

  async resolve(
    agent: Pick<AgentDto, "id" | "projectId" | "workingCopy">,
    project: Pick<ProjectDto, "id" | "hostPath">,
  ): Promise<ResolvedAgentWorkingCopy> {
    const resolved = resolveAgentWorkingCopy(agent, project);
    try {
      const metadata = await lstat(resolved.rootPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("the configured root is not a retained directory");
      }
      const canonical = await realpath(resolved.rootPath);
      if (!samePath(canonical, path.resolve(resolved.rootPath))) {
        throw new Error("the configured root resolves somewhere else");
      }
      if (resolved.mode === "separate_git") {
        if (!inside(this.managedRoot, canonical)) {
          throw new Error("the configured Separate Git copy is outside managed storage");
        }
        const projectRoot = await realpath(project.hostPath);
        const projectTopLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
        if (!samePath(projectRoot, projectTopLevel)) {
          throw new Error("the Project Shared folder is not the root of its Git repository");
        }
        if (!resolved.branch || !await gitWorktreeRegistrationExact(projectRoot, canonical, resolved.branch)) {
          throw new Error("the configured Separate Git copy is not registered by its Project repository");
        }
        const [topLevel, branch] = await Promise.all([
          runGit(canonical, ["rev-parse", "--show-toplevel"]),
          runGit(canonical, ["rev-parse", "--abbrev-ref", "HEAD"]),
        ]);
        if (!samePath(await realpath(topLevel), canonical) || branch !== resolved.branch) {
          throw new Error("the configured Separate Git copy no longer matches its branch");
        }
      }
      return { ...resolved, rootPath: canonical };
    } catch (error) {
      if (error instanceof AgentWorkingCopyUnavailableError) throw error;
      throw new AgentWorkingCopyUnavailableError(
        agent.workingCopy,
        safeFailure(error),
      );
    }
  }

  async setMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
  ): Promise<AgentDto> {
    if (!this.modeChanges.has(agent.id)) {
      throw new Error("Working-folder change was not fenced before it began");
    }
    const current = this.store.getAgent(agent.id);
    if (!current || current.projectId !== project.id) {
      throw new Error("Agent became unavailable while changing its working folder");
    }
    return this.applyMode(current, project, mode);
  }

  beginModeChange(agentId: string): () => void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is already changing");
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    this.modeChanges.set(agentId, { completion, complete });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const change = this.modeChanges.get(agentId);
      this.modeChanges.delete(agentId);
      change?.complete();
    };
  }

  beginUse(agentId: string): () => void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is changing; retry the provider command safely");
    }
    let use = this.activeUses.get(agentId);
    if (!use) {
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => { complete = resolve; });
      use = { count: 0, completion, complete };
      this.activeUses.set(agentId, use);
    }
    use.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.activeUses.get(agentId);
      if (!current) return;
      current.count -= 1;
      if (current.count === 0) {
        this.activeUses.delete(agentId);
        current.complete();
      }
    };
  }

  async awaitModeChanges(agentIds: ReadonlySet<string>): Promise<void> {
    const pending = [...agentIds].flatMap((agentId) => {
      const change = this.modeChanges.get(agentId);
      return change ? [change.completion] : [];
    });
    await Promise.all(pending);
  }

  async awaitUses(agentIds: ReadonlySet<string>): Promise<void> {
    const pending = [...agentIds].flatMap((agentId) => {
      const use = this.activeUses.get(agentId);
      return use ? [use.completion] : [];
    });
    await Promise.all(pending);
  }

  assertRunAdmission(
    agentId: string,
    expected: Pick<ResolvedAgentWorkingCopy, "id" | "mode" | "rootPath">,
  ): void {
    if (this.modeChanges.has(agentId)) {
      throw new Error("This Agent's working folder is changing; retry the Run safely");
    }
    const current = this.store.getAgent(agentId);
    if (!current || current.workingCopy.state !== "ready" ||
        current.workingCopy.id !== expected.id ||
        current.workingCopy.mode !== expected.mode ||
        current.workingCopy.rootPath !== expected.rootPath) {
      throw new Error("This Agent's working folder changed before the Run started; retry safely");
    }
  }

  /** Permanently remove a deleted Agent's explicitly retained Git copy. */
  async cleanupRetained(
    agentId: string,
    workingCopy: AgentWorkingCopyDto,
    project: Pick<ProjectDto, "id" | "hostPath">,
    options: {
      allowSourceUnavailable?: boolean;
      deleted?: boolean;
      afterWorktreeRemoval?: () => void;
      beforeBranchRemoval?: () => void;
      afterBranchRemoval?: () => void;
      afterContainerRemoval?: () => void;
    } = {},
  ): Promise<AgentWorkingCopyDto> {
    if (workingCopy.mode !== "separate_git") {
      throw new Error("This deleted Agent has no retained Separate Git copy");
    }
    if (workingCopy.state === "removed") return workingCopy;
    const expectedRoot = path.join(this.managedRoot, project.id, agentId, "root");
    if (!samePath(path.resolve(workingCopy.rootPath), expectedRoot) ||
        !inside(this.managedRoot, expectedRoot)) {
      throw new Error("The retained Separate Git copy is outside its managed location");
    }
    let rootExists = false;
    try {
      const metadata = await lstat(expectedRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("The retained Separate Git copy is not a managed directory");
      }
      const canonical = await realpath(expectedRoot);
      if (!samePath(canonical, expectedRoot)) {
        throw new Error("The retained Separate Git copy resolves somewhere else");
      }
      rootExists = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Preparation can fail before Git creates a branch or registration (for
    // example when Shared is not a Git repository). That state has no Git
    // authority to clean; removing its empty managed container is sufficient.
    if (!rootExists && !workingCopy.baseHead && !workingCopy.branchOwned &&
        !workingCopy.branchCreationIntent && !workingCopy.branchCreationReceipt &&
        !workingCopy.cleanupReceipt) {
      try {
        await rmdir(path.join(this.managedRoot, project.id, agentId));
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      return this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "removed",
        cleanupReceipt: undefined,
        failure: undefined,
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }
    let projectRoot: string;
    try {
      projectRoot = await realpath(project.hostPath);
    } catch (error) {
      if (!options.allowSourceUnavailable || !missingPath(error)) throw error;
      throw new Error("The Project Shared folder is unavailable; the retained Git copy was preserved");
    }
    const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
    if (!samePath(projectRoot, topLevel)) {
      throw new Error("The Project Shared folder is not the root of its Git repository");
    }
    if (!workingCopy.branch) {
      throw new Error("The retained Separate Git copy has no durable branch identity");
    }
    const cleanupReceipt = workingCopy.cleanupReceipt;
    if (cleanupReceipt && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== true ||
      workingCopy.branchCreationIntent !== undefined ||
      workingCopy.branchCreationReceipt !== undefined ||
      !["worktree_removal_authorized", "branch_marker_authorized", "branch_removal_authorized"].includes(cleanupReceipt.phase) ||
      !/^[0-9a-f]{40,64}$/u.test(cleanupReceipt.branchHead) ||
      (cleanupReceipt.creationOwnershipRef !== undefined &&
        !CREATION_OWNERSHIP_REF.test(cleanupReceipt.creationOwnershipRef)) ||
      (cleanupReceipt.cleanupOwnershipRef === undefined
        ? cleanupReceipt.phase === "branch_marker_authorized"
        : !CLEANUP_OWNERSHIP_REF.test(cleanupReceipt.cleanupOwnershipRef))
    )) {
      throw new Error("The retained Git copy has an invalid cleanup receipt");
    }
    const creationReceipt = workingCopy.branchCreationReceipt;
    if (creationReceipt && (
      workingCopy.state !== "unavailable" || workingCopy.branchOwned !== undefined ||
      workingCopy.branchCreationIntent !== true || !workingCopy.baseHead ||
      creationReceipt.branchHead !== workingCopy.baseHead ||
      !/^[0-9a-f]{40,64}$/u.test(creationReceipt.branchHead) ||
      !CREATION_OWNERSHIP_REF.test(creationReceipt.ownershipRef)
    )) {
      throw new Error("The retained Git copy has an invalid branch-creation receipt");
    }
    let branchOwned = workingCopy.branchOwned === true;
    let branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
    const registeredRoots = branchExists
      ? await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)
      : [];
    let registeredAtExpectedRoot = branchExists && registeredRoots.length === 1 &&
      samePath(registeredRoots[0]!, expectedRoot);
    if (rootExists && registeredAtExpectedRoot) {
      let currentRootMatches = false;
      try {
        const [rootTopLevel, rootBranch] = await Promise.all([
          runGit(expectedRoot, ["rev-parse", "--show-toplevel"]),
          runGit(expectedRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        ]);
        currentRootMatches = samePath(await realpath(rootTopLevel), expectedRoot) &&
          rootBranch === workingCopy.branch;
      } catch { /* Preserve an unreadable or replaced working folder. */ }
      if (!currentRootMatches) {
        throw new Error("The retained Git working folder was replaced and was preserved");
      }
    }
    let creationOwnershipRef: string | undefined;
    if (!branchOwned && workingCopy.branchCreationIntent === true && branchExists &&
        workingCopy.baseHead) {
      const branchHead = await gitBranchHead(projectRoot, workingCopy.branch);
      if (creationReceipt) {
        const ownershipHead = await gitReferenceHead(projectRoot, creationReceipt.ownershipRef);
        if (branchHead === creationReceipt.branchHead &&
            ownershipHead === creationReceipt.branchHead &&
            registeredRoots.every((root) => samePath(root, expectedRoot))) {
          branchOwned = true;
          creationOwnershipRef = creationReceipt.ownershipRef;
        }
      } else if (registeredAtExpectedRoot && branchHead === workingCopy.baseHead) {
        branchOwned = true;
      }
    }
    if (creationReceipt && !branchExists && !rootExists && registeredRoots.length === 0) {
      if (await gitWorktreeRootRegistered(projectRoot, expectedRoot)) {
        throw new Error("The retained Separate Git copy still has a working-folder registration and was preserved");
      }
      try {
        await rmdir(path.join(this.managedRoot, project.id, agentId));
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      const ownershipHead = await gitReferenceHead(projectRoot, creationReceipt.ownershipRef);
      if (ownershipHead === creationReceipt.branchHead) {
        await runGit(projectRoot, [
          "update-ref", "-d", creationReceipt.ownershipRef, creationReceipt.branchHead,
        ]);
      }
      return this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "removed",
        branchCreationIntent: undefined,
        branchCreationReceipt: undefined,
        cleanupReceipt: undefined,
        failure: undefined,
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }

    let durable = workingCopy;
    let phase = cleanupReceipt?.phase;
    let expectedBranchHead = cleanupReceipt?.branchHead;
    // Persist exact identity before removing the registration, then advance
    // once its absence is proven. A restart may trust only these monotonic
    // phases, never infer ownership from missing filesystem or Git state.
    if (!phase) {
      if (!rootExists && !branchExists && !workingCopy.branchOwned && !cleanupReceipt) {
        return this.persistCleanupState(agentId, {
          ...workingCopy,
          state: "removed",
          branchCreationIntent: undefined,
          branchCreationReceipt: undefined,
          cleanupReceipt: undefined,
          failure: undefined,
          updatedAt: new Date().toISOString(),
        }, options.deleted === true);
      }
      if (!branchExists || !branchOwned ||
          (rootExists ? !registeredAtExpectedRoot : registeredRoots.length > 0 || !creationOwnershipRef)) {
        throw new Error("The retained Git copy no longer matches its durable branch and working-folder identity");
      }
      expectedBranchHead = await gitBranchHead(projectRoot, workingCopy.branch);
      durable = this.persistCleanupState(agentId, {
        ...workingCopy,
        state: "unavailable",
        branchOwned: true,
        branchCreationIntent: undefined,
        branchCreationReceipt: undefined,
        cleanupReceipt: {
          phase: "worktree_removal_authorized",
          branchHead: expectedBranchHead,
          ...(creationOwnershipRef ? { creationOwnershipRef } : {}),
        },
        failure: "Separate Git copy removal is in progress. Runs remain paused.",
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
      phase = "worktree_removal_authorized";
    }

    if (branchExists && await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
      throw new Error("The retained Git branch changed after cleanup was authorized and was preserved");
    }

    if (phase === "worktree_removal_authorized") {
      if (rootExists && !registeredAtExpectedRoot) {
        throw new Error("The retained Git working folder was replaced and was preserved");
      }
      if (registeredAtExpectedRoot) {
        await runGit(projectRoot, ["worktree", "remove", "--force", expectedRoot]);
        options.afterWorktreeRemoval?.();
      }
      if (await gitWorktreeRootRegistered(projectRoot, expectedRoot) ||
          (await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)).length > 0) {
        throw new Error("The retained Git worktree registration remains after cleanup");
      }
      try {
        await lstat(expectedRoot);
        throw new Error("The retained Git working folder was replaced and was preserved");
      } catch (error) {
        if (!missingPath(error)) throw error;
      }
      durable = this.persistCleanupState(agentId, {
        ...durable,
        cleanupReceipt: {
          phase: "branch_marker_authorized",
          branchHead: expectedBranchHead!,
          cleanupOwnershipRef: cleanupOwnershipRef(),
          ...(durable.cleanupReceipt?.creationOwnershipRef
            ? { creationOwnershipRef: durable.cleanupReceipt.creationOwnershipRef }
            : {}),
        },
        updatedAt: new Date().toISOString(),
      }, options.deleted === true);
    }

    if (await gitWorktreeRootRegistered(projectRoot, expectedRoot) ||
        (await gitWorktreeBranchRoots(projectRoot, workingCopy.branch)).length > 0) {
      throw new Error("The retained Git worktree registration changed after cleanup and was preserved");
    }
    try {
      await lstat(expectedRoot);
      throw new Error("The retained Git working folder was replaced and was preserved");
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
    const cleanupRef = durable.cleanupReceipt?.cleanupOwnershipRef;
    if (!cleanupRef) {
      if (await gitBranchExists(projectRoot, workingCopy.branch)) {
        throw new Error("The retained Git branch has no cleanup ownership marker and was preserved");
      }
    } else {
      branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
      let cleanupHead = await gitReferenceHead(projectRoot, cleanupRef);
      if (durable.cleanupReceipt?.phase === "branch_marker_authorized") {
        if (!branchExists || await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
          throw new Error("The retained Git branch changed before cleanup ownership was recorded and was preserved");
        }
        if (cleanupHead === undefined) {
          await runGit(projectRoot, ["update-ref", cleanupRef, expectedBranchHead!, "0000000000000000000000000000000000000000"]);
        } else if (cleanupHead !== expectedBranchHead) {
          throw new Error("The retained Git cleanup ownership marker changed and was preserved");
        }
        durable = this.persistCleanupState(agentId, {
          ...durable,
          cleanupReceipt: { ...durable.cleanupReceipt, phase: "branch_removal_authorized" },
          updatedAt: new Date().toISOString(),
        }, options.deleted === true);
        cleanupHead = expectedBranchHead;
      }
      branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
      cleanupHead = await gitReferenceHead(projectRoot, cleanupRef);
      if (branchExists && cleanupHead === expectedBranchHead) {
        if (await gitBranchHead(projectRoot, workingCopy.branch) !== expectedBranchHead) {
          throw new Error("The retained Git branch changed after cleanup was authorized and was preserved");
        }
        await runGit(projectRoot, ["check-ref-format", "--branch", workingCopy.branch]);
        options.beforeBranchRemoval?.();
        deleteOwnedBranchReferences(projectRoot, workingCopy.branch, cleanupRef, expectedBranchHead!);
        options.afterBranchRemoval?.();
      } else if (branchExists || cleanupHead !== undefined) {
        throw new Error("The retained Git cleanup ownership proof changed and the branch was preserved");
      }
    }
    if (durable.cleanupReceipt?.creationOwnershipRef &&
        await gitReferenceHead(projectRoot, durable.cleanupReceipt.creationOwnershipRef) === expectedBranchHead) {
      await runGit(projectRoot, [
        "update-ref", "-d", durable.cleanupReceipt.creationOwnershipRef, expectedBranchHead!,
      ]);
    }
    try {
      await rmdir(path.join(this.managedRoot, project.id, agentId));
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
    options.afterContainerRemoval?.();
    return this.persistCleanupState(agentId, {
      ...durable,
      state: "removed",
      branchCreationIntent: undefined,
      branchCreationReceipt: undefined,
      cleanupReceipt: undefined,
      failure: undefined,
      updatedAt: new Date().toISOString(),
    }, options.deleted === true);
  }

  /** Remove every managed Git copy before Project authority is committed away. */
  async cleanupProject(project: ProjectDto): Promise<void> {
    for (const record of this.store.listProjectWorkingCopies(project.id)) {
      if (record.workingCopy.mode !== "separate_git" || record.workingCopy.state === "removed") continue;
      await this.cleanupRetained(record.agentId, record.workingCopy, project, {
        allowSourceUnavailable: true,
        deleted: record.deleted,
      });
    }
    try {
      await rmdir(path.join(this.managedRoot, project.id));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private async applyMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
  ): Promise<AgentDto> {
    if (agent.workingCopy.mode === "separate_git" && agent.workingCopy.cleanupReceipt) {
      const recovered = await this.cleanupRetained(agent.id, agent.workingCopy, project);
      agent = { ...agent, workingCopy: recovered };
    }
    if (mode === "shared") {
      if (agent.workingCopy.mode === "separate_git" && agent.workingCopy.state !== "removed") {
        await this.cleanupRetained(agent.id, agent.workingCopy, project);
      }
      return this.requireUpdated(agent.id, sharedWorkingCopy(project, new Date().toISOString()));
    }
    const identity = agent.workingCopy.mode === "separate_git"
      ? agent.workingCopy.id
      : `copy:${randomUUID()}`;
    const rootPath = path.join(this.managedRoot, project.id, agent.id, "root");
    const branch = agent.workingCopy.mode === "separate_git" && agent.workingCopy.branch
      ? agent.workingCopy.branch
      : separateBranch(agent);
    let branchOwned = agent.workingCopy.mode === "separate_git" &&
      agent.workingCopy.branchOwned === true;
    let branchCreationIntent = agent.workingCopy.mode === "separate_git" &&
      agent.workingCopy.branchCreationIntent === true;
    let branchCreationReceipt = agent.workingCopy.mode === "separate_git"
      ? agent.workingCopy.branchCreationReceipt
      : undefined;
    const unavailable = (failure: string, baseHead?: string) => this.requireUpdated(agent.id, {
      id: identity,
      mode: "separate_git",
      state: "unavailable",
      rootPath,
      branch,
      ...(baseHead ? { baseHead } : {}),
      ...(branchOwned ? { branchOwned: true as const } : {}),
      ...(branchCreationIntent ? { branchCreationIntent: true as const } : {}),
      ...(branchCreationReceipt ? { branchCreationReceipt } : {}),
      failure,
      updatedAt: new Date().toISOString(),
    });
    unavailable("Separate Git copy is being prepared. Runs are paused until it is ready.");
    let preparedBaseHead = agent.workingCopy.baseHead;
    try {
      const projectRoot = await realpath(project.hostPath);
      const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
      if (!samePath(projectRoot, topLevel)) {
        throw new Error("the Project Shared folder is not the root of its Git repository");
      }
      await runGit(projectRoot, ["check-ref-format", "--branch", branch]);
      const currentHead = await runGit(projectRoot, ["rev-parse", "HEAD"]);
      const baseHead = (branchCreationIntent || branchCreationReceipt || branchOwned) &&
        agent.workingCopy.baseHead
        ? agent.workingCopy.baseHead
        : currentHead;
      preparedBaseHead = baseHead;
      await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
      let targetExists = false;
      try {
        const target = await lstat(rootPath);
        targetExists = target.isDirectory() && !target.isSymbolicLink();
      } catch { /* Git creates the target. */ }
      if (targetExists) {
        const exactRegistration = await gitWorktreeRegistrationExact(projectRoot, rootPath, branch);
        const branchHead = await gitBranchHead(projectRoot, branch);
        const ownershipHead = branchCreationReceipt
          ? await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef)
          : undefined;
        if (!branchOwned && !branchCreationIntent && !branchCreationReceipt) {
          throw new Error("the existing Git branch is not proven to be Ponderosa-owned");
        }
        if (!exactRegistration || (!branchOwned && branchHead !== baseHead) ||
            (branchCreationReceipt && ownershipHead !== undefined &&
              ownershipHead !== branchCreationReceipt.branchHead)) {
          throw new Error("the interrupted Git copy no longer matches its creation receipt");
        }
      } else {
        let branchExists = await gitBranchExists(projectRoot, branch);
        if (!branchExists && !branchOwned) {
          if (!branchCreationReceipt) {
            branchCreationIntent = true;
            branchCreationReceipt = {
              ownershipRef: creationOwnershipRef(),
              branchHead: baseHead,
            };
            unavailable("Separate Git copy creation is in progress. Runs remain paused.", baseHead);
          }
          const ownershipHead = await gitReferenceHead(
            projectRoot,
            branchCreationReceipt.ownershipRef,
          );
          if (ownershipHead !== undefined) {
            throw new Error("the branch-creation ownership ref exists without its atomic branch");
          }
          createOwnedBranchReferences(
            projectRoot,
            branch,
            branchCreationReceipt.ownershipRef,
            branchCreationReceipt.branchHead,
          );
          branchExists = true;
        }
        if (branchExists) {
          const registeredRoots = await gitWorktreeBranchRoots(projectRoot, branch);
          if (registeredRoots.some((root) => !samePath(root, rootPath))) {
            throw new Error("the requested Git branch is registered to another working folder");
          }
          const exactRegistration = registeredRoots.length === 1 &&
            samePath(registeredRoots[0]!, rootPath);
          const branchHead = await gitBranchHead(projectRoot, branch);
          const ownershipHead = branchCreationReceipt
            ? await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef)
            : undefined;
          if (branchCreationReceipt) {
            if (branchHead !== branchCreationReceipt.branchHead ||
                (ownershipHead !== branchCreationReceipt.branchHead &&
                  !(ownershipHead === undefined && exactRegistration))) {
              throw new Error("the requested Git branch does not match its atomic creation receipt");
            }
            await runGit(projectRoot, ["worktree", "add", "--force", rootPath, branch]);
          } else if (branchOwned) {
            if (!exactRegistration) {
              throw new Error("the owned Git branch is no longer registered to its working folder");
            }
            await runGit(projectRoot, [
              "worktree", "add", "--force", rootPath, branch,
            ]);
          } else if (branchCreationIntent && agent.workingCopy.baseHead &&
              exactRegistration &&
              await gitBranchHead(projectRoot, branch) === agent.workingCopy.baseHead) {
            // Git may create the ref before it creates the worktree directory.
            // The durable intent plus exact ref/base identity proves this is
            // our interrupted creation, so attach that ref at the one managed
            // root instead of permanently treating it as foreign.
            await runGit(projectRoot, [
              "worktree", "add", "--force", rootPath, branch,
            ]);
          } else {
            throw new Error("the requested Git branch already exists and is not Ponderosa-owned");
          }
        }
      }
      const resolved = await this.resolve({
        ...agent,
        workingCopy: {
          id: identity,
          mode: "separate_git",
          state: "ready",
          rootPath,
          branch,
          baseHead,
          branchOwned: true,
          updatedAt: new Date().toISOString(),
        },
      }, project);
      if (!samePath(resolved.rootPath, rootPath)) {
        throw new Error("the prepared Separate Git copy has a different root");
      }
      if (branchCreationReceipt) {
        const ownershipHead = await gitReferenceHead(projectRoot, branchCreationReceipt.ownershipRef);
        if (ownershipHead !== undefined) {
          if (ownershipHead !== branchCreationReceipt.branchHead) {
            throw new Error("the branch-creation ownership ref changed and was preserved");
          }
          await runGit(projectRoot, [
            "update-ref", "-d", branchCreationReceipt.ownershipRef, branchCreationReceipt.branchHead,
          ]);
        }
      }
      branchOwned = true;
      branchCreationIntent = false;
      branchCreationReceipt = undefined;
      const ready = this.requireUpdated(agent.id, {
        id: identity,
        mode: "separate_git",
        state: "ready",
        rootPath,
        branch,
        baseHead,
        branchOwned: true,
        updatedAt: new Date().toISOString(),
      });
      await this.resolve(ready, project);
      return ready;
    } catch (error) {
      return unavailable(safeFailure(error), preparedBaseHead);
    }
  }

  private requireUpdated(agentId: string, workingCopy: AgentDto["workingCopy"]): AgentDto {
    const updated = this.store.updateAgentWorkingCopy(agentId, workingCopy);
    if (!updated) throw new Error("Agent became unavailable while changing its working folder");
    return updated;
  }

  private persistCleanupState(
    agentId: string,
    workingCopy: AgentWorkingCopyDto,
    deleted: boolean,
  ): AgentWorkingCopyDto {
    if (deleted) {
      if (!this.store.updateDeletedAgentWorkingCopy(agentId, workingCopy)) {
        throw new Error("Deleted Agent became unavailable while recording working-copy cleanup");
      }
      return workingCopy;
    }
    const updated = this.store.updateAgentWorkingCopy(agentId, workingCopy);
    if (!updated) throw new Error("Agent became unavailable while recording working-copy cleanup");
    return updated.workingCopy;
  }
}
