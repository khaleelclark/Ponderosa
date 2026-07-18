import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/store.js";
import { CoordinationV3Store } from "../src/coordination-v3-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Communication V3 agent deletion", () => {
  it("atomically removes chat-owned Triggers and cancels their pending work when deleting a Project chat", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-trigger-chat-delete-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Trigger chat", hostPath: "/repo" });
      const chat = agents.createConversation(project.id, { title: "Automation" });
      const agent = agents.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: chat.id });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.createTriggerDefinition({
        id: "chat-trigger", projectId: project.id, conversationId: chat.id, agentId: agent.id,
        name: "Chat trigger", instructions: "Handle it", sourceKind: "webhook",
        sourceConfig: { replayWindowSeconds: 300 },
      });
      const occurrence = coordination.recordTriggerOccurrence({
        triggerId: "chat-trigger", occurrenceKey: "delivery", payload: {}, provenance: { source: "test" },
      });
      expect(agents.deleteConversation(chat.id, (agentId, conversationId) => {
        coordination.handleAgentConversationRemoval(agentId, conversationId);
      })).toBe(true);
      expect(coordination.getTriggerDefinition("chat-trigger")).toBeUndefined();
      expect(coordination.getTriggerOccurrence(occurrence.occurrenceId)?.state).toBe("cancelled");
      expect(coordination.schedulerMetrics()).toMatchObject({ pendingActivations: 0 });
      expect(agents.getAgent(agent.id)?.conversationIds).toEqual([]);
    } finally {
      agents.close();
    }
  });

  it("settles only the removed Team Chat scope when an Agent has multiple memberships", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-membership-delete-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Membership", hostPath: "/repo" });
      const chatA = agents.createConversation(project.id, { title: "A" });
      const chatB = agents.createConversation(project.id, { title: "B" });
      const requester = agents.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: chatA.id });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: chatB.id });
      agents.updateAgentConversationMemberships(recipient.id, {
        conversationIds: [chatB.id, chatA.id], primaryConversationId: chatB.id,
      });
      const coordination = new CoordinationV3Store(agents.sqlite, { maxPendingActivationsPerAgent: 1 });
      coordination.coordinate({
        projectId: project.id, conversationId: chatA.id,
        requesterAgentId: requester.id, actorScope: `agent:${requester.id}`,
        idempotencyKey: "membership-removal", requests: [
          { requestId: "membership-removal-request", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } },
        ],
      });
      coordination.createTriggerDefinition({
        id: "membership-trigger", projectId: project.id, conversationId: chatA.id, agentId: recipient.id,
        name: "Membership trigger", instructions: "Handle it", sourceKind: "webhook",
        sourceConfig: { replayWindowSeconds: 300 },
      });
      const trigger = coordination.recordTriggerOccurrence({
        triggerId: "membership-trigger", occurrenceKey: "delivery-1", payload: { task: "watch" },
        provenance: { source: "test" },
      });
      expect(trigger.state).toBe("pending");

      agents.updateAgentConversationMemberships(recipient.id, {
        conversationIds: [chatB.id], primaryConversationId: chatB.id,
      }, (agentId, removedConversationIds) => {
        for (const conversationId of removedConversationIds) {
          coordination.handleAgentConversationRemoval(agentId, conversationId);
        }
      });
      expect(agents.getAgent(recipient.id)?.conversationIds).toEqual([chatB.id]);
      expect(coordination.getRequest("membership-removal-request")?.state).toBe("recipient_unavailable");
      expect(agents.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE agent_id = ? AND scope_key = ? AND state IN ('pending', 'retry_pending')
      `).get(recipient.id, `conversation:${chatA.id}`)).toEqual({ count: 0 });
      expect(agents.sqlite.prepare("SELECT state FROM trigger_occurrences WHERE id = ?").get(trigger.occurrenceId))
        .toEqual({ state: "cancelled" });
      expect(agents.sqlite.prepare(`
        SELECT state, terminal_outcome FROM agent_activations
        WHERE agent_id = ? AND scope_key = ?
      `).get(recipient.id, `conversation:${chatA.id}`)).toEqual({ state: "failed", terminal_outcome: "recipient_unavailable" });
    } finally {
      agents.close();
    }
  });

  it("fences an active scheduler Run in the same transaction as Agent deletion", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-active-agent-delete-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Delete", hostPath: "/repo" });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex" });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.enqueueMessageActivation({
        projectId: project.id, agentId: recipient.id, messageId: "active-delete",
        kind: "human", payload: { text: "Work" },
      });
      const lease = coordination.leaseNextRun({ workerId: "server" })!;
      coordination.preparePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId,
        fencingToken: lease.fencingToken, prompt: "work",
      });
      coordination.markRunStarted(lease.runId, lease.fencingToken);

      expect(agents.deleteAgent(recipient.id, (agentId) => coordination.handleAgentDeletion(agentId))).toBe(true);
      expect(coordination.activeRunCount()).toBe(0);
      expect(agents.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(lease.runId))
        .toEqual({ status: "cancelled" });
      expect(() => coordination.markPromptSubmitted({
        injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken,
      })).toThrow("stale");
    } finally {
      agents.close();
    }
  });

  it("commits recipient_unavailable and the agent projection deletion in one transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-delete-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Delete", hostPath: "/repo" });
      const requester = agents.createAgent(project.id, { title: "Requester", engine: "codex" });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex" });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.coordinate({
        projectId: project.id,
        requesterAgentId: requester.id,
        actorScope: `agent:${requester.id}`,
        idempotencyKey: "delete",
        requests: [{ requestId: "deleted-recipient", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } }],
      });

      expect(agents.deleteAgent(recipient.id, (agentId) => coordination.handleAgentDeletion(agentId))).toBe(true);
      expect(agents.getAgent(recipient.id)).toBeUndefined();
      expect(agents.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'deleted-recipient'").get())
        .toEqual({ state: "recipient_unavailable" });
      expect(agents.sqlite.prepare(`
        SELECT state, terminal_outcome FROM agent_activations WHERE agent_id = ?
      `).get(recipient.id)).toEqual({ state: "failed", terminal_outcome: "recipient_unavailable" });
    } finally {
      agents.close();
    }
  });

  it("terminalizes outbound Requests when their requester is deleted", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-delete-requester-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Delete requester", hostPath: "/repo" });
      const requester = agents.createAgent(project.id, { title: "Requester", engine: "codex" });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex" });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.coordinate({
        projectId: project.id,
        requesterAgentId: requester.id,
        actorScope: `agent:${requester.id}`,
        idempotencyKey: "outbound-delete",
        requests: [{ requestId: "orphanable-outbound", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } }],
      });

      expect(agents.deleteAgent(requester.id, (agentId) => coordination.handleAgentDeletion(agentId))).toBe(true);
      expect(agents.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'orphanable-outbound'").get())
        .toEqual({ state: "cancelled" });
      expect(agents.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE agent_id = ? AND kind = 'coordination_cancelled' AND state = 'pending'
      `).get(recipient.id)).toEqual({ count: 1 });
    } finally {
      agents.close();
    }
  });

  it("rolls back coordination changes when the surrounding deletion transaction fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-delete-rollback-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Delete", hostPath: "/repo" });
      const owner = agents.createAgent(project.id, { title: "Owner", engine: "codex" });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex" });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.coordinate({
        projectId: project.id,
        requesterAgentId: owner.id,
        actorScope: `agent:${owner.id}`,
        idempotencyKey: "rollback",
        requests: [{ requestId: "rollback-request", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } }],
        join: { id: "rollback-join", mode: "all" },
      });

      expect(() => agents.deleteAgent(owner.id, (agentId) => {
        coordination.handleAgentDeletion(agentId);
        throw new Error("simulated projection failure");
      })).toThrow("simulated projection failure");
      expect(agents.getAgent(owner.id)).toBeDefined();
      expect(agents.sqlite.prepare("SELECT state FROM coordination_joins WHERE id = 'rollback-join'").get())
        .toEqual({ state: "open" });
    } finally {
      agents.close();
    }
  });

  it("purges every V3 row transactionally when deleting a Project", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-project-delete-"));
    directories.push(directory);
    const agents = new AgentStore(directory);
    try {
      const project = agents.createProject({ label: "Delete project", hostPath: "/repo" });
      const chat = agents.createConversation(project.id, { title: "Trigger chat" });
      const requester = agents.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: chat.id });
      const recipient = agents.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: chat.id });
      const coordination = new CoordinationV3Store(agents.sqlite);
      coordination.coordinate({
        projectId: project.id, requesterAgentId: requester.id, actorScope: `agent:${requester.id}`,
        idempotencyKey: "project-delete", requests: [
          { requestId: "project-delete-request", recipientAgentId: recipient.id, lifetime: { kind: "indefinite" } },
        ], join: { id: "project-delete-join", mode: "all" },
      });
      const lease = coordination.leaseNextRun({ workerId: "server" })!;
      coordination.preparePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId,
        fencingToken: lease.fencingToken, prompt: "work",
      });
      coordination.markRunStarted(lease.runId, lease.fencingToken);
      coordination.recordRuntimeCommunication({
        id: "project-delete-communication", projectId: project.id,
        sender: { kind: "user" }, intent: "broadcast", audience: { projectId: project.id }, payload: { text: "FYI" },
      });
      coordination.createTriggerDefinition({
        id: "project-delete-trigger", projectId: project.id, conversationId: chat.id, agentId: recipient.id,
        name: "Project trigger", instructions: "Handle it", sourceKind: "webhook",
        sourceConfig: { replayWindowSeconds: 300 },
      });
      coordination.recordTriggerOccurrence({
        triggerId: "project-delete-trigger", occurrenceKey: "delivery-1",
        payload: { task: "watch" }, provenance: { source: "test" },
      });

      coordination.prepareProjectDeletion(project.id);
      expect(coordination.activeRunCount()).toBe(0);
      expect(agents.deleteProject(project.id, (projectId) => coordination.purgeProject(projectId))).toBe(true);
      expect(agents.getProject(project.id)).toBeUndefined();
      for (const table of [
        "runtime_communications", "coordination_requests", "coordination_request_updates",
        "coordination_joins", "coordination_join_members", "agent_activations", "activation_sources",
        "activation_outbox", "scheduler_runs", "scheduler_run_activations",
        "scheduler_prompt_injections", "scheduler_cancellation_receipts",
        "provider_operation_outbox", "coordination_idempotency", "scheduler_agent_fences",
        "trigger_occurrences", "trigger_definitions",
      ]) {
        expect(agents.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
      }
    } finally {
      agents.close();
    }
  });
});
