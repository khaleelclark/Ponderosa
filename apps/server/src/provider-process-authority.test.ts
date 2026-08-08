import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { openDb } from "@ponderosa/agents";
import { recoveredRuntimeProcessHandle, runtimeProcessIdentity } from "@ponderosa/engines";
import { ProviderProcessAuthority } from "./provider-process-authority.js";

const linuxTest = process.platform === "linux" ? test : test.skip;

function liveDetachedProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const identity = runtimeProcessIdentity(child);
  if (!identity) throw new Error("test child did not expose a process birth identity");
  child.unref();
  return {
    identity,
    handle: recoveredRuntimeProcessHandle(identity, {
      label: "qualification provider",
      termGraceMs: 500,
      killConfirmationMs: 500,
    }),
  };
}

describe("durable provider process authority", () => {
  linuxTest("recovers a crashed boot and qualifies cancellation plus Agent/Project deletion", async () => {
    const opened = openDb(":memory:");
    const cleanup = new Set<ReturnType<typeof liveDetachedProcess>["handle"]>();
    try {
      const crashed = liveDetachedProcess();
      cleanup.add(crashed.handle);
      new ProviderProcessAuthority(opened.client, "server:boot-a").register(crashed.handle, {
        purpose: "provider Run",
        projectId: "project-a",
        agentId: "agent-a",
        runId: "run-a",
      });
      const restarted = new ProviderProcessAuthority(opened.client, "server:boot-b");
      expect(await restarted.recoverPreviousWorkers()).toBe(1);
      expect(crashed.handle.isAlive()).toBe(false);

      const cancelled = liveDetachedProcess();
      cleanup.add(cancelled.handle);
      restarted.register(cancelled.handle, {
        purpose: "provider Run",
        projectId: "project-b",
        agentId: "agent-b",
        runId: "run-b",
      });
      expect(await restarted.terminateRun("run-b")).toBe(1);
      expect(cancelled.handle.isAlive()).toBe(false);

      const agentDeleted = liveDetachedProcess();
      cleanup.add(agentDeleted.handle);
      restarted.register(agentDeleted.handle, {
        purpose: "persistent provider runtime",
        projectId: "project-c",
        agentId: "agent-c",
        runId: "run-c",
      });
      expect(await restarted.terminateAgents(new Set(["agent-c"]), "Agent deletion qualification")).toBe(1);
      expect(agentDeleted.handle.isAlive()).toBe(false);

      const projectDeleted = liveDetachedProcess();
      cleanup.add(projectDeleted.handle);
      restarted.register(projectDeleted.handle, {
        purpose: "model discovery",
        projectId: "project-d",
      });
      expect(await restarted.terminateProject("project-d", "Project deletion qualification")).toBe(1);
      expect(projectDeleted.handle.isAlive()).toBe(false);
      expect(restarted.count()).toBe(0);
    } finally {
      await Promise.allSettled([...cleanup].map((handle) => handle.close()));
      opened.client.close();
    }
  });
});
