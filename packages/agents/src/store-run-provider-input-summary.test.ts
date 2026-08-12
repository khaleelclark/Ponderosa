import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderInputSourceManifest } from "@ponderosa/core";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): { store: AgentStore; agentId: string } {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-run-provider-input-"));
  directories.push(root);
  const hostPath = join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(join(root, "data"));
  stores.push(store);
  const project = store.createProject({
    label: "Provider input summary",
    hostPath,
    defaultEngine: "codex",
  });
  const agent = store.createAgent(project.id, {
    title: "Busy Agent",
    engine: "codex",
    conversationId: project.lastConversationId,
  });
  const now = new Date().toISOString();
  const executionId = "run-provider-input";
  const manifest: ProviderInputSourceManifest = {
    schemaVersion: 3,
    historyMessageCount: 0,
    retainedSessionSourceCount: 0,
    activationIds: [],
    communicationEventIds: ["communication-1", "communication-2"],
    artifactIds: [],
    providerSessionDisposition: "fresh_task",
    sources: [
      {
        kind: "communication",
        ref: `large-source-${"x".repeat(32_000)}`,
        delivery: "submitted",
      },
    ],
  };
  store.sqlite.prepare(`
    INSERT INTO runs (
      id, agent_id, title, status, reason, engine, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(executionId, agent.id, "Provider run", "completed", "completed", "codex", now, now);
  store.sqlite.prepare(`
    INSERT INTO provider_inputs (
      execution_id, scheduler_run_id, agent_id, project_id,
      provider_prompt, prompt_hash, source_manifest_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    executionId,
    "scheduler-run-provider-input",
    agent.id,
    project.id,
    "exact prompt",
    "prompt-hash",
    JSON.stringify(manifest),
    now,
    now,
  );
  return { store, agentId: agent.id };
}

describe("bounded Agent provider input summaries", () => {
  test("omits full manifests from Agent detail while preserving exact Run history", () => {
    const { store, agentId } = fixture();

    const detail = store.getAgentDetail(agentId, 25, false)!;
    expect(detail.runs[0]?.providerInput).toEqual({
      promptHash: "prompt-hash",
      sourceCommunicationCount: 2,
      exactPromptAvailable: true,
    });
    expect(JSON.stringify(detail)).not.toContain("large-source-");

    const runHistory = store.getRunPage(agentId, { limit: 25 });
    expect(runHistory.items[0]?.providerInput).toMatchObject({
      promptHash: "prompt-hash",
      sourceCommunicationCount: 2,
      exactPromptAvailable: true,
      sourceManifest: {
        communicationEventIds: ["communication-1", "communication-2"],
      },
    });
    expect(JSON.stringify(runHistory)).toContain("large-source-");
  });
});
