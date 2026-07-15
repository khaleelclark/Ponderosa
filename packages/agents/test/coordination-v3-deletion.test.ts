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
});
