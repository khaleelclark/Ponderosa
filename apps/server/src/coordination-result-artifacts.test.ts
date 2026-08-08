import { describe, expect, test } from "vitest";
import type { RuntimeArtifactV3, SchedulerLease } from "@ponderosa/agents";
import { resolveCoordinationResultArtifacts } from "./coordination-scheduler-service.js";

function artifact(id: string, ownerId: string): RuntimeArtifactV3 {
  return {
    id,
    ownerKind: "request_update",
    ownerId,
    projectId: "project-a",
    role: "long_text",
    title: "Result",
    mediaType: "text/markdown",
    blobPath: "result.md",
    blobHash: "a".repeat(64),
    byteLength: 6,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

const activation = {
  id: "activation-a",
  kind: "coordination_outcome",
  priority: 10,
  promptClass: "coordination",
  payload: {
    requestId: "request-a",
    updateId: "update-a",
    update: { artifactId: "exact-result", resultRef: "ponderosa://artifact/exact-result" },
    unrelated: { artifactId: "unrelated-reference" },
  },
} as SchedulerLease["activations"][number];

describe("V4 correlated result artifact compilation", () => {
  test("fails closed when an exact result points at a mismatched request update", () => {
    expect(() => resolveCoordinationResultArtifacts({
      activation,
      projectId: "project-a",
      runtimeArtifact: id => id === "exact-result" ? artifact(id, "another-update") : undefined,
      authoritative: () => undefined,
    })).toThrow("exact correlated result artifact contract mismatch: exact-result");
  });

  test("materializes the exact result while ignoring an unrelated missing artifact", () => {
    const materials = resolveCoordinationResultArtifacts({
      activation,
      projectId: "project-a",
      runtimeArtifact: id => id === "exact-result" ? artifact(id, "update-a") : undefined,
      authoritative: () => ({
        byteLength: 6,
        contentHash: "b".repeat(64),
        body: Buffer.from("result"),
        localPath: "/tmp/result.md",
      }),
    });
    expect(materials).toHaveLength(1);
    expect(materials[0]?.artifactId).toBe("exact-result");
    expect(materials[0]?.content).toBe("result");
  });
});
