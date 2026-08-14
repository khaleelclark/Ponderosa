import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AgentArtifactCatalog } from "./store-artifact-catalog.js";
import type { ArtifactProjectionReadRow } from "./store-types.js";

function catalog(): AgentArtifactCatalog {
  const client = {
    prepare: () => ({ get: () => undefined }),
  } as unknown as Database.Database;
  return new AgentArtifactCatalog(
    "/tmp/ponderosa-test",
    client,
    () => "cursor",
    () => ({ orderKey: "", rowKey: "" }),
    () => ({ projectId: "project-1" }),
    () => true,
    () => [],
  );
}

describe("AgentArtifactCatalog PDF projection", () => {
  it("keeps the exact source path in authority data without copying it into summary or managed path", () => {
    const row: ArtifactProjectionReadRow = {
      id: "artifact-1",
      agent_id: "agent-1",
      execution_id: "run-1",
      kind: "diff",
      path: "artifacts/diff-artifact-1.patch",
      summary: "edit /home/patrick/project/report.pdf",
      created_at: "2026-08-14T00:00:00.000Z",
      source_path: "/home/patrick/project/report.pdf",
      media_type: null,
      visibility: null,
      pinned: null,
      size: null,
    };

    const projected = catalog().artifactDtoFromProjectionRow("agent-1", row);
    expect(projected).toMatchObject({
      kind: "document",
      path: "artifacts/diff-artifact-1.patch",
      sourcePath: "/home/patrick/project/report.pdf",
      mediaType: "application/pdf",
    });
    expect(projected).not.toHaveProperty("summary");
  });
});
