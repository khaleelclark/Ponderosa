import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
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

async function gitWorktreeRegistered(
  projectRoot: string,
  expectedRoot: string,
  branch: string,
): Promise<boolean> {
  return (await gitWorktreeBranchRoots(projectRoot, branch))
    .some((root) => samePath(root, expectedRoot));
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
        if (!resolved.branch || !await gitWorktreeRegistered(projectRoot, canonical, resolved.branch)) {
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
    options: { allowSourceUnavailable?: boolean } = {},
  ): Promise<AgentWorkingCopyDto> {
    if (workingCopy.mode !== "separate_git" || workingCopy.state === "removed") {
      throw new Error("This deleted Agent has no retained Separate Git copy");
    }
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
    if (!rootExists && !workingCopy.baseHead) {
      await rm(path.join(this.managedRoot, project.id, agentId), { recursive: true, force: true });
      return {
        ...workingCopy,
        state: "removed",
        failure: undefined,
        updatedAt: new Date().toISOString(),
      };
    }
    let projectRoot: string;
    try {
      projectRoot = await realpath(project.hostPath);
    } catch (error) {
      if (!options.allowSourceUnavailable || !missingPath(error)) throw error;
      // The selected source folder may have been moved or deleted. The managed
      // directory is still safe to remove because its exact containment and
      // non-symlink identity were proven above. Preserve any source ref whose
      // ownership or repository cannot be verified rather than blocking the
      // Project's deletion forever.
      if (rootExists) await rm(expectedRoot, { recursive: true, force: true });
      await rm(path.join(this.managedRoot, project.id, agentId), { recursive: true, force: true });
      return {
        ...workingCopy,
        state: "removed",
        failure: undefined,
        updatedAt: new Date().toISOString(),
      };
    }
    const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
    if (!samePath(projectRoot, topLevel)) {
      throw new Error("The Project Shared folder is not the root of its Git repository");
    }
    let branchOwned = workingCopy.branchOwned === true;
    if (rootExists && workingCopy.branchCreationIntent === true && workingCopy.branch) {
      branchOwned = await gitWorktreeRegistered(projectRoot, expectedRoot, workingCopy.branch);
      if (!branchOwned) {
        throw new Error("The interrupted Git copy is not registered by its Project repository");
      }
    }
    if (!rootExists && workingCopy.branchCreationIntent === true &&
        workingCopy.branch && workingCopy.baseHead) {
      if (await gitBranchExists(projectRoot, workingCopy.branch)) {
        const registeredRoots = await gitWorktreeBranchRoots(projectRoot, workingCopy.branch);
        const branchHead = await gitBranchHead(projectRoot, workingCopy.branch);
        branchOwned = branchHead === workingCopy.baseHead &&
          registeredRoots.every((root) => samePath(root, expectedRoot));
        if (!branchOwned) {
          throw new Error("The interrupted Git branch no longer matches its Ponderosa ownership receipt");
        }
      }
    }
    if (rootExists) {
      await runGit(projectRoot, ["worktree", "remove", "--force", expectedRoot]);
    } else if (workingCopy.branch && branchOwned &&
        await gitWorktreeRegistered(projectRoot, expectedRoot, workingCopy.branch)) {
      await runGit(projectRoot, ["worktree", "remove", "--force", expectedRoot]);
    } else {
      await runGit(projectRoot, ["worktree", "prune"]);
    }
    if (workingCopy.branch && branchOwned) {
      await runGit(projectRoot, ["check-ref-format", "--branch", workingCopy.branch]);
      const branchExists = await gitBranchExists(projectRoot, workingCopy.branch);
      if (branchExists) await runGit(projectRoot, ["branch", "-D", workingCopy.branch]);
    }
    await rm(path.join(this.managedRoot, project.id, agentId), { recursive: true, force: true });
    return {
      ...workingCopy,
      state: "removed",
      failure: undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Remove every managed Git copy before Project authority is committed away. */
  async cleanupProject(project: ProjectDto): Promise<void> {
    for (const record of this.store.listProjectWorkingCopies(project.id)) {
      if (record.workingCopy.mode !== "separate_git" || record.workingCopy.state === "removed") continue;
      const removed = await this.cleanupRetained(record.agentId, record.workingCopy, project, {
        allowSourceUnavailable: true,
      });
      const persisted = record.deleted
        ? this.store.updateDeletedAgentWorkingCopy(record.agentId, removed)
        : Boolean(this.store.updateAgentWorkingCopy(record.agentId, removed));
      if (!persisted) throw new Error(`Agent ${record.agentId} became unavailable during working-copy cleanup`);
    }
  }

  private async applyMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
  ): Promise<AgentDto> {
    if (mode === "shared") {
      if (agent.workingCopy.mode === "separate_git" && agent.workingCopy.state !== "removed") {
        const removed = await this.cleanupRetained(agent.id, agent.workingCopy, project);
        this.requireUpdated(agent.id, removed);
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
    const unavailable = (failure: string, baseHead?: string) => this.requireUpdated(agent.id, {
      id: identity,
      mode: "separate_git",
      state: "unavailable",
      rootPath,
      branch,
      ...(baseHead ? { baseHead } : {}),
      ...(branchOwned ? { branchOwned: true as const } : {}),
      ...(branchCreationIntent ? { branchCreationIntent: true as const } : {}),
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
      const baseHead = (branchCreationIntent || branchOwned) && agent.workingCopy.baseHead
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
        if (agent.workingCopy.branchOwned !== true &&
            agent.workingCopy.branchCreationIntent !== true) {
          throw new Error("the existing Git branch is not proven to be Ponderosa-owned");
        }
        const current = await this.resolve({
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
        if (!samePath(current.rootPath, rootPath)) throw new Error("existing Separate Git copy has a different root");
        branchOwned = true;
        branchCreationIntent = false;
      } else {
        const branchExists = await gitBranchExists(projectRoot, branch);
        if (branchExists) {
          const registeredRoots = await gitWorktreeBranchRoots(projectRoot, branch);
          if (registeredRoots.some((root) => !samePath(root, rootPath))) {
            throw new Error("the requested Git branch is registered to another working folder");
          }
          if (branchOwned) {
            await runGit(projectRoot, [
              "worktree", "add", "--force", rootPath, branch,
            ]);
          } else if (branchCreationIntent && agent.workingCopy.baseHead &&
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
          branchOwned = true;
          branchCreationIntent = false;
        } else {
          // Persist intent before Git creates either the branch or worktree. If
          // the process stops after Git succeeds, restart can recover ownership
          // by matching this exact ref/base receipt and managed root.
          branchCreationIntent = true;
          unavailable("Separate Git copy creation is in progress. Runs remain paused.", baseHead);
          await runGit(projectRoot, [
            "worktree", "add", "--no-track", "-b", branch,
            rootPath,
            baseHead,
          ]);
          branchOwned = true;
          branchCreationIntent = false;
        }
      }
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
}
