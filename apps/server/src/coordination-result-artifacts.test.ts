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

  test("fails closed when an exact result omits its request update owner", () => {
    expect(() => resolveCoordinationResultArtifacts({
      activation: {
        ...activation,
        payload: { update: { artifactId: "exact-result" } },
      },
      projectId: "project-a",
      runtimeArtifact: id => artifact(id, "arbitrary-project-update"),
      authoritative: () => undefined,
    })).toThrow("exact correlated result artifact contract mismatch: exact-result");
  });

  test("fails closed when duplicate exact references claim conflicting update owners", () => {
    const conflicting = {
      ...activation,
      kind: "coordination_join_completed",
      payload: {
        outcomes: [
          { update: { id: "update-a", payload: { artifactId: "exact-result" } } },
          { update: { id: "update-b", payload: { artifactId: "exact-result" } } },
        ],
      },
    } as SchedulerLease["activations"][number];
    expect(() => resolveCoordinationResultArtifacts({
      activation: conflicting,
      projectId: "project-a",
      runtimeArtifact: id => artifact(id, "update-b"),
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
