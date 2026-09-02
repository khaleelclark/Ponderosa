import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentWorkingCopyService } from "../dist/agent-working-copy-service.js";

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
