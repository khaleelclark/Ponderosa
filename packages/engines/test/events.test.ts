import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { mapCodexEvent, mapFileChangeKind } from "../src/events.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function mapFixture(name: string, cwd = "/proj"): AgentEvent[] {
  const raw = readFileSync(join(fixtures, name), "utf8");
  const out: AgentEvent[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim() !== "")) {
    out.push(...mapCodexEvent(JSON.parse(line), { cwd }));
  }
  return out;
}

describe("mapCodexEvent — per event type", () => {
  it("thread.started → session", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "s1" })).toEqual([
      { type: "session", sessionId: "s1" },
    ]);
  });

  it("turn.completed → turn_done with normalized usage", () => {
    expect(
      mapCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 8 },
      }),
    ).toEqual([{ type: "turn_done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]);
  });

  it("turn.failed → error", () => {
    expect(
      mapCodexEvent({ type: "turn.failed", error: { message: "boom" } }),
    ).toEqual([{ type: "error", message: "boom" }]);
  });

  it("top-level error → error", () => {
    expect(mapCodexEvent({ type: "error", message: "bad" })).toEqual([
      { type: "error", message: "bad" },
    ]);
  });

  it("item.completed agent_message → text", () => {
    expect(
      mapCodexEvent({
        type: "item.completed",
        item: { id: "i0", type: "agent_message", text: "hi" },
      }),
    ).toEqual([{ type: "text", delta: "hi" }]);
  });

  it("item.completed reasoning → reasoning", () => {
    expect(
      mapCodexEvent({
        type: "item.completed",
        item: { id: "i0", type: "reasoning", text: "runOutput" },
      }),
    ).toEqual([{ type: "reasoning", delta: "runOutput" }]);
  });

  it("item.started command_execution → command (with run cwd)", () => {
    expect(
      mapCodexEvent(
        {
          type: "item.started",
          item: { id: "i0", type: "command_execution", command: "echo hi", status: "in_progress" },
        },
        { cwd: "/work" },
      ),
    ).toEqual([{ type: "command", command: "echo hi", cwd: "/work" }]);
  });

  it("item.completed command_execution → tool_result (isError from exit_code)", () => {
    expect(
      mapCodexEvent({
        type: "item.completed",
        item: {
          id: "i0",
          type: "command_execution",
          command: "false",
          aggregated_output: "nope\n",
          exit_code: 1,
          status: "completed",
        },
      }),
    ).toEqual([{ type: "tool_result", id: "i0", output: "nope\n", isError: true }]);
  });

  it("item.completed file_change → one file_change per change entry", () => {
    expect(
      mapCodexEvent({
        type: "item.completed",
        item: {
          id: "i2",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "/p/a.ts", kind: "add" },
            { path: "/p/b.ts", kind: "update" },
            { path: "/p/c.ts", kind: "delete" },
          ],
        },
      }),
    ).toEqual([
      { type: "file_change", path: "/p/a.ts", kind: "create" },
      { type: "file_change", path: "/p/b.ts", kind: "edit" },
      { type: "file_change", path: "/p/c.ts", kind: "delete" },
    ]);
  });

  it("ignores turn.started and item.updated (no double-emit)", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(
      mapCodexEvent({
        type: "item.updated",
        item: { id: "i0", type: "agent_message", text: "partial" },
      }),
    ).toEqual([]);
  });

  it("unknown event/item types map to [] (forward-compatible)", () => {
    expect(mapCodexEvent({ type: "some.future.event" })).toEqual([]);
    expect(
      mapCodexEvent({ type: "item.completed", item: { id: "x", type: "future_item" } }),
    ).toEqual([]);
    expect(mapCodexEvent(null)).toEqual([]);
    expect(mapCodexEvent("not an object")).toEqual([]);
  });
});

describe("mapFileChangeKind", () => {
  it("normalizes codex verbs", () => {
    expect(mapFileChangeKind("add")).toBe("create");
    expect(mapFileChangeKind("update")).toBe("edit");
    expect(mapFileChangeKind("delete")).toBe("delete");
    expect(mapFileChangeKind("weird")).toBe("edit");
    expect(mapFileChangeKind(undefined)).toBe("edit");
  });
});

describe("mapCodexEvent — recorded fixtures (real codex 0.143.0 output)", () => {
  it("seed with a command + file change maps to a complete timeline", () => {
    const events = mapFixture("codex-seed-command-file.jsonl", "/proj");
    // session first
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "019f4849-ae4b-7cd2-acf0-3f2cbb3e1d7a",
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("command");
    expect(types).toContain("tool_result");
    expect(types).toContain("file_change");
    expect(types).toContain("text");
    expect(types.at(-1)).toBe("turn_done");

    const fc = events.find((e) => e.type === "file_change");
    expect(fc).toMatchObject({ type: "file_change", kind: "create" });
    const cmd = events.find((e) => e.type === "command");
    expect(cmd).toMatchObject({ type: "command", cwd: "/proj" });
  });

  it("simple seed captures session and final text", () => {
    const events = mapFixture("codex-seed-simple.jsonl");
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.some((e) => e.type === "text" && e.delta === "PONDEROSA_OK")).toBe(true);
  });

  it("resume captures the same session id and the answer text", () => {
    const events = mapFixture("codex-resume-agentmessage.jsonl");
    expect(events[0]).toMatchObject({
      type: "session",
      sessionId: "019f4849-ae4b-7cd2-acf0-3f2cbb3e1d7a",
    });
    expect(events.some((e) => e.type === "text")).toBe(true);
  });
});
