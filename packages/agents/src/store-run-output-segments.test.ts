import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(): { store: AgentStore; agentId: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-run-output-"));
  directories.push(root);
  const dataDir = join(root, "data");
  const hostPath = join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(dataDir);
  stores.push(store);
  const project = store.createProject({
    label: "Run output projection",
    hostPath,
    defaultEngine: "codex",
  });
  const agent = store.createAgent(project.id, {
    title: "Busy Agent",
    engine: "codex",
    conversationId: project.lastConversationId,
  });
  return { store, agentId: agent.id, dataDir };
}

describe("bounded run output projection", () => {
  test("maintains contiguous segments and keyset pages during event append", () => {
    const { store, agentId, dataDir } = fixture();
    store.appendEvent(agentId, { type: "text", executionId: "run-1", delta: "Hello " });
    store.appendEvent(agentId, { type: "text", executionId: "run-1", delta: "world  \n" });
    store.appendEvent(agentId, { type: "command", command: "pwd", cwd: "/tmp" });
    store.appendEvent(agentId, { type: "text", executionId: "run-1", delta: "After command" });
    store.appendEvent(agentId, { type: "reasoning", executionId: "run-1", delta: "Reasoning" });

    const first = store.getRunOutputPage(agentId, { limit: 2 });
    expect(first.items.map((item) => [item.kind, item.text])).toEqual([
      ["response", "After command"],
      ["reasoning", "Reasoning"],
    ]);
    expect(first.history.hasMore).toBe(true);
    expect(first.history.cursor).toBeTruthy();

    const second = store.getRunOutputPage(agentId, {
      limit: 2,
      cursor: first.history.cursor,
    });
    expect(second.items.map((item) => item.text)).toEqual(["Hello world"]);
    expect(second.history.hasMore).toBe(false);

    store.close();
    stores.pop();
    const reopened = new AgentStore(dataDir);
    stores.push(reopened);
    expect(reopened.getRunOutputs(agentId).map((item) => item.text)).toEqual([
      "Hello world",
      "After command",
      "Reasoning",
    ]);
  });

  test("serves bounded previews without rescanning canonical event history", () => {
    const { store, agentId } = fixture();
    const body = `${"é".repeat(20_000)} tail`;
    store.appendEvent(agentId, { type: "text", executionId: "run-large", delta: body });

    const projected = store.sqlite.prepare(`
      SELECT preview_utf8_bytes, canonical_utf8_bytes
      FROM run_output_segments WHERE agent_id = ?
    `).get(agentId) as {
      preview_utf8_bytes: number;
      canonical_utf8_bytes: number;
    };
    expect(projected.preview_utf8_bytes).toBeLessThanOrEqual(32 * 1_024);
    expect(projected.canonical_utf8_bytes).toBe(Buffer.byteLength(body, "utf8"));

    // The normal page is entirely projection-backed. Full canonical text is
    // touched only by the explicit retrieval endpoint.
    store.sqlite.prepare("DELETE FROM events WHERE agent_id = ?").run(agentId);
    const page = store.getRunOutputPage(agentId, { limit: 25 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.textPreview).toMatchObject({
      truncated: true,
      totalUtf8Bytes: Buffer.byteLength(body, "utf8"),
    });

    const plan = store.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT first_seq FROM run_output_segments
      WHERE agent_id = ? ORDER BY first_seq DESC LIMIT 26
    `).all(agentId) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_run_output_segments_agent_newest")))
      .toBe(true);
  });
});
