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
    )).toThrowError(expect.objectContaining<Partial<DelegationError>>({
      code: "concurrency_limit_exceeded",
      statusCode: 409,
      retryable: true,
    }));
  });
});
