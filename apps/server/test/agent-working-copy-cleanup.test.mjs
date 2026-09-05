import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentWorkingCopyService } from "../dist/agent-working-copy-service.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function gitFixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "ponderosa-working-copy-git-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  const projectRoot = path.join(temporary, "source");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  git(projectRoot, "init");
  git(projectRoot, "config", "user.email", "working-copy-test@example.invalid");
  git(projectRoot, "config", "user.name", "Working Copy Test");
  await writeFile(path.join(projectRoot, "base.txt"), "base\n");
  git(projectRoot, "add", ".");
  git(projectRoot, "commit", "-m", "base");
  return {
    dataDir,
    project: { id: "project-a", hostPath: projectRoot },
    baseHead: git(projectRoot, "rev-parse", "HEAD"),
  };
}

test("Project cleanup removes an empty working-copy container", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ponderosa-working-copy-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const project = { id: "project-a", hostPath: dataDir };
  const projectContainer = path.join(dataDir, "working-copies", project.id);
  await mkdir(projectContainer, { recursive: true });
  const service = new AgentWorkingCopyService(dataDir, {
    listProjectWorkingCopies: () => [],
  });

  await service.cleanupProject(project);

  await assert.rejects(access(projectContainer), { code: "ENOENT" });
});

test("Project cleanup preserves an unrecognized working-copy entry", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ponderosa-working-copy-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const project = { id: "project-a", hostPath: dataDir };
  const sentinel = path.join(dataDir, "working-copies", project.id, "foreign-owner", "KEEP.txt");
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "unrecognized content");
  const service = new AgentWorkingCopyService(dataDir, {
    listProjectWorkingCopies: () => [],
  });

  await assert.rejects(service.cleanupProject(project));
  await access(sentinel);
});

test("Project cleanup rejects a non-directory working-copy container", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ponderosa-working-copy-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const project = { id: "project-a", hostPath: dataDir };
  const projectContainer = path.join(dataDir, "working-copies", project.id);
  await mkdir(path.dirname(projectContainer), { recursive: true });
  await writeFile(projectContainer, "unrecognized content");
  const service = new AgentWorkingCopyService(dataDir, {
    listProjectWorkingCopies: () => [],
  });

  await assert.rejects(service.cleanupProject(project));
  await access(projectContainer);
});

test("retained cleanup preserves a foreign worktree rejected during mode preparation", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  let agent = {
    id: "00000000-0000-4000-8000-000000000101",
    projectId: project.id,
    title: "Worker",
    workingCopy: {
      id: `shared:${project.id}`,
      mode: "shared",
      state: "ready",
      rootPath: project.hostPath,
      updatedAt: new Date().toISOString(),
    },
  };
  const root = path.join(dataDir, "working-copies", project.id, agent.id, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", "foreign-user-branch", root, baseHead);
  const sentinel = path.join(root, "UNCOMMITTED-USER-DATA.txt");
  await writeFile(sentinel, "must survive\n");
  const store = {
    getAgent: () => agent,
    updateAgentWorkingCopy: (_agentId, workingCopy) => {
      agent = { ...agent, workingCopy: structuredClone(workingCopy) };
      return agent;
    },
    listProjectWorkingCopies: () => [],
  };
  const service = new AgentWorkingCopyService(dataDir, store);
  const release = service.beginModeChange(agent.id);
  const changed = await service.setMode(agent, project, "separate_git");
  release();

  assert.equal(changed.workingCopy.state, "unavailable");
  assert.equal(changed.workingCopy.branchOwned, undefined);
  await assert.rejects(
    service.cleanupRetained(agent.id, changed.workingCopy, project),
    /no longer matches its durable branch and working-folder identity/u,
  );
  await access(sentinel);
  assert.match(git(project.hostPath, "worktree", "list", "--porcelain"), new RegExp(root, "u"));
});

test("Project cleanup preserves a worktree that replaced its durable owned registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000102";
  const ownedBranch = "ponderosa/owned-agent";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", ownedBranch, root, baseHead);
  await rename(root, `${root}-displaced`);
  await mkdir(root);
  const sentinel = path.join(root, "UNCOMMITTED-REPLACEMENT-DATA.txt");
  await writeFile(sentinel, "must survive\n");
  const workingCopy = {
    id: "copy:owned",
    mode: "separate_git",
    state: "ready",
    rootPath: root,
    branch: ownedBranch,
    baseHead,
    branchOwned: true,
    updatedAt: new Date().toISOString(),
  };
  let persisted = false;
  const service = new AgentWorkingCopyService(dataDir, {
    listProjectWorkingCopies: () => [{ agentId, deleted: false, workingCopy }],
    updateAgentWorkingCopy: () => { persisted = true; },
  });

  await assert.rejects(
    service.cleanupProject(project),
    /working folder was replaced and was preserved/u,
  );
  assert.equal(persisted, false);
  await access(sentinel);
  assert.match(git(project.hostPath, "worktree", "list", "--porcelain"), new RegExp(root, "u"));
});

test("retained cleanup removes its exact durably owned worktree", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000105";
  const branch = "ponderosa/exact-owned-agent";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  const service = new AgentWorkingCopyService(dataDir, { listProjectWorkingCopies: () => [] });

  const removed = await service.cleanupRetained(agentId, {
    id: "copy:exact-owned",
    mode: "separate_git",
    state: "ready",
    rootPath: root,
    branch,
    baseHead,
    branchOwned: true,
    updatedAt: new Date().toISOString(),
  }, project);

  assert.equal(removed.state, "removed");
  await assert.rejects(access(root), { code: "ENOENT" });
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
});

test("retained cleanup validates creation intent against its base commit", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000103";
  const branch = "ponderosa/interrupted-agent";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  await writeFile(path.join(root, "committed-after-intent.txt"), "foreign commit\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "advance branch after recorded intent");
  const sentinel = path.join(root, "UNCOMMITTED-AFTER-INTENT.txt");
  await writeFile(sentinel, "must survive\n");
  let agent = {
    id: agentId,
    projectId: project.id,
    title: "Interrupted Agent",
    workingCopy: {
      id: "copy:interrupted",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  };
  const service = new AgentWorkingCopyService(dataDir, {
    getAgent: () => agent,
    updateAgentWorkingCopy: (_agentId, workingCopy) => {
      agent = { ...agent, workingCopy: structuredClone(workingCopy) };
      return agent;
    },
    listProjectWorkingCopies: () => [],
  });
  const release = service.beginModeChange(agent.id);
  const recovered = await service.setMode(agent, project, "separate_git");
  release();

  assert.equal(recovered.workingCopy.state, "unavailable");
  assert.equal(recovered.workingCopy.branchOwned, undefined);
  await assert.rejects(
    service.cleanupRetained(agentId, recovered.workingCopy, project),
    /no longer matches its durable branch and working-folder identity/u,
  );
  await access(sentinel);
});

test("retained cleanup preserves managed data when the source repository is unavailable", async (t) => {
  const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "ponderosa-working-copy-missing-source-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const agentId = "00000000-0000-4000-8000-000000000104";
  const project = { id: "project-a", hostPath: path.join(dataDir, "missing-source") };
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  const sentinel = path.join(root, "UNCOMMITTED-USER-DATA.txt");
  await mkdir(root, { recursive: true });
  await writeFile(sentinel, "must survive\n");
  const service = new AgentWorkingCopyService(dataDir, { listProjectWorkingCopies: () => [] });

  await assert.rejects(service.cleanupRetained(agentId, {
    id: "copy:owned",
    mode: "separate_git",
    state: "ready",
    rootPath: root,
    branch: "ponderosa/owned",
    baseHead: "a".repeat(40),
    branchOwned: true,
    updatedAt: new Date().toISOString(),
  }, project, { allowSourceUnavailable: true }), /was preserved/u);
  await access(sentinel);
});
