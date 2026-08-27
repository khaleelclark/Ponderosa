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

export class AgentWorkingCopyService {
  private readonly managedRoot: string;
  private readonly modeChanges = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private readonly store: Pick<AgentStore, "getAgent" | "updateAgentWorkingCopy">,
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
    const preceding = this.modeChanges.get(agent.id) ?? Promise.resolve();
    const operation = preceding.catch(() => undefined).then(() => {
      const current = this.store.getAgent(agent.id);
      if (!current || current.projectId !== project.id) {
        throw new Error("Agent became unavailable while changing its working folder");
      }
      return this.applyMode(current, project, mode);
    });
    const fence = operation.then(() => undefined, () => undefined);
    this.modeChanges.set(agent.id, fence);
    try {
      return await operation;
    } finally {
      if (this.modeChanges.get(agent.id) === fence) this.modeChanges.delete(agent.id);
    }
  }

  /** Permanently remove a deleted Agent's explicitly retained Git copy. */
  async cleanupRetained(
    agentId: string,
    workingCopy: AgentWorkingCopyDto,
    project: Pick<ProjectDto, "id" | "hostPath">,
  ): Promise<AgentWorkingCopyDto> {
    if (workingCopy.mode !== "separate_git" || workingCopy.state === "removed") {
      throw new Error("This deleted Agent has no retained Separate Git copy");
    }
    const expectedRoot = path.join(this.managedRoot, project.id, agentId, "root");
    if (!samePath(path.resolve(workingCopy.rootPath), expectedRoot) ||
        !inside(this.managedRoot, expectedRoot)) {
      throw new Error("The retained Separate Git copy is outside its managed location");
    }
    const projectRoot = await realpath(project.hostPath);
    const topLevel = await realpath(await runGit(projectRoot, ["rev-parse", "--show-toplevel"]));
    if (!samePath(projectRoot, topLevel)) {
      throw new Error("The Project Shared folder is not the root of its Git repository");
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
    if (rootExists) {
      await runGit(projectRoot, ["worktree", "remove", "--force", expectedRoot]);
    } else {
      await runGit(projectRoot, ["worktree", "prune"]);
    }
    if (workingCopy.branch) {
      await runGit(projectRoot, ["check-ref-format", "--branch", workingCopy.branch]);
      const branchExists = await runGit(projectRoot, [
        "show-ref", "--verify", "--quiet", `refs/heads/${workingCopy.branch}`,
      ]).then(() => true, () => false);
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

  private async applyMode(
    agent: AgentDto,
    project: ProjectDto,
    mode: AgentWorkingCopyMode,
  ): Promise<AgentDto> {
    if (mode === "shared") {
      return this.requireUpdated(agent.id, sharedWorkingCopy(project, new Date().toISOString()));
    }
    const identity = agent.workingCopy.mode === "separate_git"
      ? agent.workingCopy.id
      : `copy:${randomUUID()}`;
    const rootPath = path.join(this.managedRoot, project.id, agent.id, "root");
    const branch = agent.workingCopy.mode === "separate_git" && agent.workingCopy.branch
      ? agent.workingCopy.branch
      : separateBranch(agent);
    const unavailable = (failure: string, baseHead?: string) => this.requireUpdated(agent.id, {
      id: identity,
      mode: "separate_git",
      state: "unavailable",
      rootPath,
      branch,
      ...(baseHead ? { baseHead } : {}),
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
      const baseHead = await runGit(projectRoot, ["rev-parse", "HEAD"]);
      preparedBaseHead = baseHead;
      await mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
      let targetExists = false;
      try {
        const target = await lstat(rootPath);
        targetExists = target.isDirectory() && !target.isSymbolicLink();
      } catch { /* Git creates the target. */ }
      if (targetExists) {
        const current = await this.resolve({
          ...agent,
          workingCopy: {
            id: identity,
            mode: "separate_git",
            state: "ready",
            rootPath,
            branch,
            baseHead,
            updatedAt: new Date().toISOString(),
          },
        }, project);
        if (!samePath(current.rootPath, rootPath)) throw new Error("existing Separate Git copy has a different root");
      } else {
        const branchExists = await runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
          .then(() => true, () => false);
        await runGit(projectRoot, [
          "worktree", "add", "--no-track",
          ...(branchExists ? [] : ["-b", branch]),
          rootPath,
          branchExists ? branch : baseHead,
        ]);
      }
      const ready = this.requireUpdated(agent.id, {
        id: identity,
        mode: "separate_git",
        state: "ready",
        rootPath,
        branch,
        baseHead,
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
