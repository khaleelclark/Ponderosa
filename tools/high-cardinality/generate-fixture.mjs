#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AgentStore, CoordinationV3Store } from "../../packages/agents/dist/index.js";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value ?? fallback;
}
function countOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}
function pad(value, width = 4) {
  return String(value).padStart(width, "0");
}

const repoRoot = resolve(import.meta.dirname, "../..");
const dataDir = resolve(option("data-dir", resolve(repoRoot, ".high-cardinality-fixture")));
const hostRoot = resolve(option("host-root", resolve(dataDir, "host-workspaces")));
const metadataPath = resolve(option("metadata", resolve(dataDir, "fixture.json")));
const projectCount = countOption("projects", 250);
const targetChatCount = countOption("chats", 1002);
const agentCount = countOption("agents", 1000);
const triggerCount = countOption("triggers", 1000);
const messageCount = countOption("messages", 1250);
const force = process.argv.includes("--force");

if (existsSync(dataDir)) {
  if (!force) throw new Error(`${dataDir} already exists; pass --force to replace this synthetic fixture`);
  rmSync(dataDir, { recursive: true, force: true });
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(hostRoot, { recursive: true });

const startedAt = performance.now();
const store = new AgentStore(dataDir);
try {
  const projects = [];
  for (let index = 0; index < projectCount; index += 1) {
    const hostPath = resolve(hostRoot, `project-${pad(index, 3)}`);
    mkdirSync(hostPath, { recursive: true });
    projects.push(store.createProject({
      label: `HC Project ${pad(index, 3)}`,
      hostPath,
      defaultEngine: "codex",
    }));
  }
  if (projects.length === 0) throw new Error("the fixture requires at least one project");
  const targetProject = projects[0];
  const defaultConversation = store.getConversation(targetProject.lastConversationId);
  if (!defaultConversation) throw new Error("target Project has no default Chat");
  const conversations = [defaultConversation];
  for (let index = 1; index < targetChatCount; index += 1) {
    conversations.push(store.createConversation(targetProject.id, {
      title: `HC Chat ${pad(index)}`,
      defaultEngine: "codex",
    }));
  }

  const agents = [];
  for (let index = 0; index < agentCount; index += 1) {
    agents.push(store.createAgent(targetProject.id, {
      title: `HC Agent ${pad(index)}`,
      engine: "codex",
      conversationId: defaultConversation.id,
    }));
  }
  if (triggerCount > 0 && agents.length === 0) throw new Error("triggers require at least one Agent");
  const coordination = new CoordinationV3Store(store.sqlite);
  for (let index = 0; index < triggerCount; index += 1) {
    const agent = agents[index % agents.length];
    coordination.createTriggerDefinition({
      id: `hc-trigger-${pad(index)}`,
      projectId: targetProject.id,
      conversationId: defaultConversation.id,
      agentId: agent.id,
      name: `HC Trigger ${pad(index)}`,
      instructions: "Disabled synthetic high-cardinality trigger.",
      sourceKind: "webhook",
      sourceConfig: { replayWindowSeconds: 300 },
      enabled: false,
    });
  }

  const messageEpoch = Date.parse("2026-08-01T00:00:00.000Z");
  for (let index = 0; index < messageCount; index += 1) {
    store.appendCommunicationEvent({
      eventId: `hc-message-${pad(index)}`,
      schemaVersion: 2,
      projectId: targetProject.id,
      conversationId: defaultConversation.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: targetProject.id },
      text: `Synthetic passive message ${pad(index)}`,
      createdAt: new Date(messageEpoch + index).toISOString(),
    });
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    dataDir,
    hostRoot,
    projectId: targetProject.id,
    conversationId: defaultConversation.id,
    agentIds: agents.slice(0, 20).map((agent) => agent.id),
    counts: {
      projects: projectCount,
      targetChats: targetChatCount,
      totalChats: projectCount + Math.max(0, targetChatCount - 1),
      agents: agentCount,
      triggers: triggerCount,
      messages: messageCount,
    },
    seedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
} finally {
  store.close();
}
