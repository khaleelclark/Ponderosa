import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DelegationError,
  DelegationStore,
  MAX_CONCURRENT_DELEGATIONS,
} from "../src/delegations.js";

describe("DelegationStore concurrency", () => {
  const dataDirs: string[] = [];

  afterEach(() => {
    for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows 100 active delegated workers and rejects the 101st", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-delegations-"));
    dataDirs.push(dataDir);
    const store = new DelegationStore(dataDir);

    for (let index = 0; index < MAX_CONCURRENT_DELEGATIONS; index += 1) {
      const result = store.spawn(
        "master-chat",
        {
          parentRunId: "parent-run",
          displayLabel: `Worker ${index + 1}`,
          delegationPrompt: "Complete the bounded task.",
          runtime: "codex",
          idempotencyKey: `worker-${index + 1}`,
        },
        true,
        [],
        { projectId: "project", parentAgentId: "parent", childAgentId: `child-${index + 1}` },
      );
      expect(result.run.status).toBe("queued");
    }

    expect(() => store.spawn(
      "master-chat",
      {
        parentRunId: "parent-run",
        displayLabel: "Worker 101",
        delegationPrompt: "This worker exceeds the active limit.",
        runtime: "codex",
        idempotencyKey: "worker-101",
      },
      true,
      [],
      { projectId: "project", parentAgentId: "parent", childAgentId: "child-101" },
    )).toThrowError(expect.objectContaining<Partial<DelegationError>>({
      code: "concurrency_limit_exceeded",
      statusCode: 409,
      retryable: true,
    }));
  });

  it("persists blocked dispositions, replays duplicates, and keeps runtime failure and cancellation distinct", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-delegation-outcomes-"));
    dataDirs.push(dataDir);
    const store = new DelegationStore(dataDir);
    const spawn = (key: string) => store.spawn("master-chat", {
      parentRunId: "parent-run",
      displayLabel: key,
      delegationPrompt: "work",
      runtime: "codex",
      idempotencyKey: key,
    }, true, [], { projectId: "project", parentAgentId: "parent", childAgentId: `child-${key}` }).run;

    const blocked = spawn("blocked");
    store.claim(blocked.id);
    const disposition = { outcome: "blocked" as const, message: "Waiting for credentials.", idempotencyKey: "blocked-outcome" };
    expect(store.declareDisposition(blocked.id, disposition).status).toBe("blocked");
    expect(store.declareDisposition(blocked.id, disposition).version).toBe(3);
    expect(new DelegationStore(dataDir).get(blocked.id)).toEqual(expect.objectContaining({
      status: "blocked",
      disposition: expect.objectContaining({ message: "Waiting for credentials." }),
    }));

    const failed = spawn("failed");
    store.claim(failed.id);
    expect(store.finishRuntime(failed.id, "engine crashed")).toEqual(expect.objectContaining({ status: "failed", failure: expect.objectContaining({ code: "runtime_error" }) }));
    const cancelled = spawn("cancelled");
    store.claim(cancelled.id);
    store.cancel(cancelled.id, "cancel-once");
    const cancelledRun = store.get(cancelled.id)!;
    expect(cancelledRun.status).toBe("cancelled");
    expect(cancelledRun).not.toHaveProperty("failure");
    expect(cancelledRun).not.toHaveProperty("disposition");
  });
});
