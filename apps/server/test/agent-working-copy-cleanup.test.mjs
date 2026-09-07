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

function createAtomicCreationRefs(cwd, branch, ownershipRef, head) {
  execFileSync("git", ["update-ref", "--stdin"], {
    cwd,
    encoding: "utf8",
    input: [
      "start",
      `create refs/heads/${branch} ${head}`,
      `create ${ownershipRef} ${head}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  });
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

function activeWorkingCopyStore(agent) {
  let current = structuredClone(agent);
  return {
    store: {
      getAgent: () => current,
      listProjectWorkingCopies: () => [{
        agentId: current.id,
        deleted: false,
        workingCopy: structuredClone(current.workingCopy),
      }],
      updateAgentWorkingCopy: (_agentId, workingCopy) => {
        current = { ...current, workingCopy: structuredClone(workingCopy) };
        return current;
      },
      updateDeletedAgentWorkingCopy: () => false,
    },
    current: () => current,
  };
}

function deletedWorkingCopyStore(agentId, workingCopy) {
  let current = structuredClone(workingCopy);
  return {
    store: {
      getAgent: () => undefined,
      listProjectWorkingCopies: () => [{
        agentId,
        deleted: true,
        workingCopy: structuredClone(current),
      }],
      updateAgentWorkingCopy: () => undefined,
      updateDeletedAgentWorkingCopy: (_agentId, next) => {
        current = structuredClone(next);
        return true;
      },
    },
    current: () => current,
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
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Exact owner",
    workingCopy: {
    id: "copy:exact-owned",
    mode: "separate_git",
    state: "ready",
    rootPath: root,
    branch,
    baseHead,
    branchOwned: true,
    updatedAt: new Date().toISOString(),
    },
  });
  const service = new AgentWorkingCopyService(dataDir, authority.store);

  const removed = await service.cleanupRetained(
    agentId,
    authority.current().workingCopy,
    project,
  );

  assert.equal(removed.state, "removed");
  assert.equal(authority.current().workingCopy.state, "removed");
  await assert.rejects(access(root), { code: "ENOENT" });
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
});

test("retained cleanup settles a preparation failure that never created Git authority", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000111";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Failed preparation",
    workingCopy: {
      id: "copy:failed-preparation",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch: "ponderosa/never-created",
      baseHead,
      failure: "preparation stopped before Git mutation",
      updatedAt: new Date().toISOString(),
    },
  });

  const removed = await new AgentWorkingCopyService(dataDir, authority.store)
    .cleanupRetained(agentId, authority.current().workingCopy, project);

  assert.equal(removed.state, "removed");
  assert.equal(git(project.hostPath, "branch", "--list", "ponderosa/never-created"), "");
});

test("new Separate Git creation retires its atomic ownership marker", async (t) => {
  const { dataDir, project } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000120";
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "New owner",
    workingCopy: {
      id: `shared:${project.id}`,
      mode: "shared",
      state: "ready",
      rootPath: project.hostPath,
      updatedAt: new Date().toISOString(),
    },
  });
  const service = new AgentWorkingCopyService(dataDir, authority.store);
  const release = service.beginModeChange(agentId);
  const created = await service.setMode(authority.current(), project, "separate_git");
  release();

  assert.equal(created.workingCopy.state, "ready");
  assert.equal(created.workingCopy.branchOwned, true);
  assert.equal(created.workingCopy.branchCreationReceipt, undefined);
  assert.equal(
    git(project.hostPath, "for-each-ref", "--format=%(refname)", "refs/ponderosa/working-copy-creation"),
    "",
  );
  await writeFile(path.join(created.workingCopy.rootPath, "agent-change.txt"), "changed\n");
  git(created.workingCopy.rootPath, "add", ".");
  git(created.workingCopy.rootPath, "commit", "-m", "agent change");
  const changedHead = git(created.workingCopy.rootPath, "rev-parse", "HEAD");
  const releaseRetry = service.beginModeChange(agentId);
  const retried = await service.setMode(authority.current(), project, "separate_git");
  releaseRetry();
  assert.equal(retried.workingCopy.state, "ready");
  assert.equal(git(retried.workingCopy.rootPath, "rev-parse", "HEAD"), changedHead);
});

test("Separate Git retry recovers an atomically owned branch created before registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000121";
  const branch = "ponderosa/post-ref-crash-retry";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000121";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Creation retry",
    workingCopy: {
      id: "copy:post-ref-retry",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });
  const service = new AgentWorkingCopyService(dataDir, authority.store);
  const release = service.beginModeChange(agentId);
  const recovered = await service.setMode(authority.current(), project, "separate_git");
  release();

  assert.equal(recovered.workingCopy.state, "ready");
  assert.equal(recovered.workingCopy.branchOwned, true);
  assert.equal(recovered.workingCopy.branchCreationIntent, undefined);
  assert.equal(recovered.workingCopy.branchCreationReceipt, undefined);
  assert.match(git(project.hostPath, "worktree", "list", "--porcelain"), new RegExp(root, "u"));
  assert.equal(git(project.hostPath, "for-each-ref", "--format=%(refname)", ownershipRef), "");
});

test("retained cleanup removes an atomically owned branch created before registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000122";
  const branch = "ponderosa/post-ref-crash-cleanup";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000122";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Creation cleanup",
    workingCopy: {
      id: "copy:post-ref-cleanup",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  const removed = await new AgentWorkingCopyService(dataDir, authority.store)
    .cleanupRetained(agentId, authority.current().workingCopy, project);

  assert.equal(removed.state, "removed");
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
  assert.equal(git(project.hostPath, "for-each-ref", "--format=%(refname)", ownershipRef), "");
});

test("deleted-Agent cleanup removes an atomically owned branch created before registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000123";
  const branch = "ponderosa/post-ref-crash-deleted";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000123";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  const authority = deletedWorkingCopyStore(agentId, {
    id: "copy:post-ref-deleted",
    mode: "separate_git",
    state: "unavailable",
    rootPath: root,
    branch,
    baseHead,
    branchCreationIntent: true,
    branchCreationReceipt: { ownershipRef, branchHead: baseHead },
    failure: "creation interrupted",
    updatedAt: new Date().toISOString(),
  });

  const removed = await new AgentWorkingCopyService(dataDir, authority.store)
    .cleanupRetained(agentId, authority.current(), project, { deleted: true });

  assert.equal(removed.state, "removed");
  assert.equal(authority.current().state, "removed");
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
  assert.equal(git(project.hostPath, "for-each-ref", "--format=%(refname)", ownershipRef), "");
});

test("Project deletion cleanup removes an atomically owned branch created before registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000124";
  const branch = "ponderosa/post-ref-crash-project";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000124";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Project cleanup",
    workingCopy: {
      id: "copy:post-ref-project",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  await new AgentWorkingCopyService(dataDir, authority.store).cleanupProject(project);

  assert.equal(authority.current().workingCopy.state, "removed");
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
  assert.equal(git(project.hostPath, "for-each-ref", "--format=%(refname)", ownershipRef), "");
  await assert.rejects(access(path.join(dataDir, "working-copies", project.id)), { code: "ENOENT" });
});

test("Project cleanup removes an exact empty container after interrupted branch removal", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000126";
  const branch = "ponderosa/post-ref-missing-branch";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000126";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  git(project.hostPath, "update-ref", "-d", `refs/heads/${branch}`, baseHead);
  await mkdir(path.dirname(root), { recursive: true });
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Missing branch cleanup",
    workingCopy: {
      id: "copy:missing-branch-cleanup",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  await new AgentWorkingCopyService(dataDir, authority.store).cleanupProject(project);

  assert.equal(authority.current().workingCopy.state, "removed");
  assert.equal(git(project.hostPath, "for-each-ref", "--format=%(refname)", ownershipRef), "");
  await assert.rejects(access(path.join(dataDir, "working-copies", project.id)), { code: "ENOENT" });
});

test("interrupted creation cleanup preserves a missing root with a Git registration", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000127";
  const branch = "ponderosa/post-ref-stale-registration";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000127";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", root, branch);
  git(project.hostPath, "update-ref", "-d", `refs/heads/${branch}`, baseHead);
  await rm(root, { recursive: true, force: true });
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Registered missing root",
    workingCopy: {
      id: "copy:registered-missing-root",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store)
      .cleanupRetained(agentId, authority.current().workingCopy, project),
    /still has a working-folder registration and was preserved/u,
  );

  assert.equal(authority.current().workingCopy.state, "unavailable");
  assert.equal(git(project.hostPath, "rev-parse", ownershipRef), baseHead);
});

test("interrupted creation cleanup preserves a nonempty managed Agent container", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000128";
  const branch = "ponderosa/post-ref-foreign-container";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000128";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  git(project.hostPath, "update-ref", "-d", `refs/heads/${branch}`, baseHead);
  await mkdir(path.dirname(root), { recursive: true });
  const sentinel = path.join(path.dirname(root), "foreign.txt");
  await writeFile(sentinel, "preserve\n");
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Foreign container",
    workingCopy: {
      id: "copy:foreign-container",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store)
      .cleanupRetained(agentId, authority.current().workingCopy, project),
    { code: "ENOTEMPTY" },
  );

  assert.equal(await realpath(sentinel), sentinel);
  assert.equal(authority.current().workingCopy.state, "unavailable");
  assert.equal(git(project.hostPath, "rev-parse", ownershipRef), baseHead);
});

test("creation cleanup preserves a branch changed after its atomic ownership receipt", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000125";
  const branch = "ponderosa/post-ref-crash-changed";
  const ownershipRef = "refs/ponderosa/working-copy-creation/00000000000040008000000000000125";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  createAtomicCreationRefs(project.hostPath, branch, ownershipRef, baseHead);
  await writeFile(path.join(project.hostPath, "later.txt"), "later\n");
  git(project.hostPath, "add", ".");
  git(project.hostPath, "commit", "-m", "later");
  const changedHead = git(project.hostPath, "rev-parse", "HEAD");
  git(project.hostPath, "update-ref", `refs/heads/${branch}`, changedHead, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Changed creation",
    workingCopy: {
      id: "copy:post-ref-changed",
      mode: "separate_git",
      state: "unavailable",
      rootPath: root,
      branch,
      baseHead,
      branchCreationIntent: true,
      branchCreationReceipt: { ownershipRef, branchHead: baseHead },
      failure: "creation interrupted",
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store)
      .cleanupRetained(agentId, authority.current().workingCopy, project),
    /no longer matches its durable branch and working-folder identity/u,
  );

  assert.equal(git(project.hostPath, "rev-parse", branch), changedHead);
  assert.equal(git(project.hostPath, "rev-parse", ownershipRef), baseHead);
  assert.equal(authority.current().workingCopy.state, "unavailable");
});

test("Project cleanup resumes after a crash immediately after owned worktree removal", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000106";
  const branch = "ponderosa/project-crash-owner";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Project cleanup owner",
    workingCopy: {
      id: "copy:project-crash",
      mode: "separate_git",
      state: "ready",
      rootPath: root,
      branch,
      baseHead,
      branchOwned: true,
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current().workingCopy,
      project,
      { afterWorktreeRemoval: () => { throw new Error("simulated crash after worktree removal"); } },
    ),
    /simulated crash after worktree removal/u,
  );
  assert.equal(
    authority.current().workingCopy.cleanupReceipt.phase,
    "worktree_removal_authorized",
  );
  await assert.rejects(access(root), { code: "ENOENT" });
  assert.notEqual(git(project.hostPath, "branch", "--list", branch), "");

  await new AgentWorkingCopyService(dataDir, authority.store).cleanupProject(project);

  assert.equal(authority.current().workingCopy.state, "removed");
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");
});

test("Separate to Shared resumes after a crash immediately after owned branch deletion", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000107";
  const branch = "ponderosa/mode-crash-owner";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Mode cleanup owner",
    workingCopy: {
      id: "copy:mode-crash",
      mode: "separate_git",
      state: "ready",
      rootPath: root,
      branch,
      baseHead,
      branchOwned: true,
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current().workingCopy,
      project,
      { afterBranchRemoval: () => { throw new Error("simulated crash after branch deletion"); } },
    ),
    /simulated crash after branch deletion/u,
  );
  assert.equal(
    authority.current().workingCopy.cleanupReceipt.phase,
    "branch_removal_authorized",
  );
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");

  const restarted = new AgentWorkingCopyService(dataDir, authority.store);
  const release = restarted.beginModeChange(agentId);
  const shared = await restarted.setMode(
    authority.current(),
    project,
    "shared",
  );
  release();

  assert.equal(shared.workingCopy.mode, "shared");
  assert.equal(shared.workingCopy.state, "ready");
  assert.equal(shared.workingCopy.cleanupReceipt, undefined);
});

test("deleted-Agent cleanup resumes after a crash before final removed state", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000108";
  const branch = "ponderosa/deleted-crash-owner";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  const authority = deletedWorkingCopyStore(agentId, {
    id: "copy:deleted-crash",
    mode: "separate_git",
    state: "ready",
    rootPath: root,
    branch,
    baseHead,
    branchOwned: true,
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current(),
      project,
      {
        deleted: true,
        afterContainerRemoval: () => { throw new Error("simulated crash before final state"); },
      },
    ),
    /simulated crash before final state/u,
  );
  assert.equal(authority.current().cleanupReceipt.phase, "branch_removal_authorized");
  assert.equal(git(project.hostPath, "branch", "--list", branch), "");

  const removed = await new AgentWorkingCopyService(dataDir, authority.store)
    .cleanupRetained(agentId, authority.current(), project, { deleted: true });

  assert.equal(removed.state, "removed");
  assert.equal(authority.current().state, "removed");
  assert.equal(authority.current().cleanupReceipt, undefined);
});

test("retained cleanup does not infer removal authority from an absent worktree", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000109";
  const branch = "ponderosa/unreceipted-owner";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  git(project.hostPath, "worktree", "remove", "--force", root);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Unreceipted owner",
    workingCopy: {
      id: "copy:unreceipted",
      mode: "separate_git",
      state: "ready",
      rootPath: root,
      branch,
      baseHead,
      branchOwned: true,
      updatedAt: new Date().toISOString(),
    },
  });

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current().workingCopy,
      project,
    ),
    /no longer matches its durable branch and working-folder identity/u,
  );
  assert.notEqual(git(project.hostPath, "branch", "--list", branch), "");
  assert.equal(authority.current().workingCopy.cleanupReceipt, undefined);
});

test("retained cleanup preserves a branch changed after its durable cleanup receipt", async (t) => {
  const { dataDir, project, baseHead } = await gitFixture(t);
  const agentId = "00000000-0000-4000-8000-000000000110";
  const branch = "ponderosa/changed-after-receipt";
  const root = path.join(dataDir, "working-copies", project.id, agentId, "root");
  await mkdir(path.dirname(root), { recursive: true });
  git(project.hostPath, "worktree", "add", "-b", branch, root, baseHead);
  const authority = activeWorkingCopyStore({
    id: agentId,
    projectId: project.id,
    title: "Changed branch owner",
    workingCopy: {
      id: "copy:changed-after-receipt",
      mode: "separate_git",
      state: "ready",
      rootPath: root,
      branch,
      baseHead,
      branchOwned: true,
      updatedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current().workingCopy,
      project,
      { afterWorktreeRemoval: () => { throw new Error("simulated crash"); } },
    ),
    /simulated crash/u,
  );
  await writeFile(path.join(project.hostPath, "later.txt"), "later\n");
  git(project.hostPath, "add", ".");
  git(project.hostPath, "commit", "-m", "later");
  const replacementHead = git(project.hostPath, "rev-parse", "HEAD");
  git(project.hostPath, "update-ref", `refs/heads/${branch}`, replacementHead);

  await assert.rejects(
    new AgentWorkingCopyService(dataDir, authority.store).cleanupRetained(
      agentId,
      authority.current().workingCopy,
      project,
    ),
    /branch changed after cleanup was authorized and was preserved/u,
  );
  assert.equal(git(project.hostPath, "rev-parse", branch), replacementHead);
  assert.equal(
    authority.current().workingCopy.cleanupReceipt.phase,
    "worktree_removal_authorized",
  );
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
