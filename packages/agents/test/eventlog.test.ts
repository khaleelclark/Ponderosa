import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, readLog } from "../src/eventlog.js";

describe("EventLog", () => {
  const directories: string[] = [];
  const file = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-eventlog-"));
    directories.push(directory);
    return join(directory, "events.jsonl");
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("appends durable ordered records and resumes their sequence", () => {
    const path = file();
    const first = new EventLog(path);
    expect(first.append({ type: "error", message: "first" }, "2026-01-01T00:00:00.000Z").seq).toBe(1);
    expect(new EventLog(path).append({ type: "error", message: "second" }, "2026-01-01T00:00:01.000Z").seq).toBe(2);
    expect(readLog(path).map((record) => record.seq)).toEqual([1, 2]);
  });

  it("ignores a torn tail but rejects corruption before the tail", () => {
    const path = file();
    const log = new EventLog(path);
    log.append({ type: "error", message: "complete" });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":2`, "utf8");
    expect(readLog(path)).toHaveLength(1);
    expect(new EventLog(path).append({ type: "error", message: "after recovery" }).seq).toBe(2);
    expect(readLog(path)).toHaveLength(2);

    const corrupt = file();
    writeFileSync(corrupt, '{"seq":1,"ts":"now","event":{"type":"error","message":"first"}}\nnot-json\n', "utf8");
    expect(() => readLog(corrupt)).toThrow("agent event log contains non-tail corruption");
  });
});
