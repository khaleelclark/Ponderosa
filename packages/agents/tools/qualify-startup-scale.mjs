#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AgentStore } from "../dist/index.js";

const numberOption = (name, fallback) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};
const projectCount = numberOption("--projects", 50);
const agentsPerProject = numberOption("--agents-per-project", 10);
const messagesPerProject = numberOption("--messages-per-project", 100);
const recoverySloMs = numberOption("--recovery-slo-ms", 30_000);
const cleanSloMs = numberOption("--clean-slo-ms", 5_000);
const root = mkdtempSync(path.join(tmpdir(), "ponderosa-startup-scale-"));

try {
  let store = new AgentStore(root);
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const project = store.createProject({
      label: `Long-lived Project ${projectIndex}`,
      hostPath: path.join(root, "working", String(projectIndex)),
      defaultEngine: "codex",
    });
    const conversationId = project.lastConversationId;
    if (!conversationId) throw new Error("qualification Project did not create a Chat");
    for (let index = 0; index < agentsPerProject; index += 1) {
      store.createAgent(project.id, {
        title: `Agent ${projectIndex}-${index}`,
        engine: "codex",
        conversationId,
      });
    }
    for (let index = 0; index < messagesPerProject; index += 1) {
      store.appendCommunicationEvent({
        schemaVersion: 2,
        eventId: randomUUID(),
        projectId: project.id,
        conversationId,
        sender: index % 2 === 0
          ? { kind: "user", userId: "startup-qualification" }
          : { kind: "system", component: "startup-qualification" },
        text: `Synthetic long-lived history ${projectIndex}/${index} ${"x".repeat(256)}`,
        intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id },
        createdAt: new Date(1_800_000_000_000 + projectIndex * messagesPerProject + index).toISOString(),
      });
    }
  }
  const closeStarted = performance.now();
  store.close();
  const writeActiveCloseMs = Math.round((performance.now() - closeStarted) * 10) / 10;

  const writeActiveCleanStarted = performance.now();
  store = new AgentStore(root);
  const writeActive = store.startupProfile();
  const writeActiveWallMs = Math.round((performance.now() - writeActiveCleanStarted) * 10) / 10;
  store.close();
  rmSync(path.join(root, ".projection-clean-shutdown.json"), { force: true });

  const recoveryStarted = performance.now();
  store = new AgentStore(root);
  const recovery = store.startupProfile();
  const recoveryWallMs = Math.round((performance.now() - recoveryStarted) * 10) / 10;
  store.close();

  const cleanStarted = performance.now();
  store = new AgentStore(root);
  const clean = store.startupProfile();
  const cleanWallMs = Math.round((performance.now() - cleanStarted) * 10) / 10;
  store.close();

  const result = {
    status: recoveryWallMs <= recoverySloMs && cleanWallMs <= cleanSloMs &&
      writeActiveCloseMs + writeActiveWallMs <= recoverySloMs ? "pass" : "fail",
    dataset: {
      projects: projectCount,
      agents: projectCount * agentsPerProject,
      messages: projectCount * messagesPerProject,
      databaseBytes: existsSync(path.join(root, "ponderosa.db"))
        ? statSync(path.join(root, "ponderosa.db")).size
        : 0,
    },
    recovery: { wallMs: recoveryWallMs, profile: recovery, sloMs: recoverySloMs },
    writeActive: { closeMs: writeActiveCloseMs, startupMs: writeActiveWallMs,
      stopThroughReadyMs: writeActiveCloseMs + writeActiveWallMs, profile: writeActive, sloMs: recoverySloMs },
    clean: { wallMs: cleanWallMs, profile: clean, sloMs: cleanSloMs },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass" || writeActive.mode !== "recovery" ||
      recovery.mode !== "recovery" || clean.mode !== "clean") {
    throw new Error("startup-scale qualification did not meet its recovery/clean-start contract");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
