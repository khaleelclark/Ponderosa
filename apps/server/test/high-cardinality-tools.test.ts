import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const directories: string[] = [];

describe("high-cardinality tool safety", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to replace a directory without the fixture ownership sentinel", () => {
    const target = mkdtempSync(path.join(tmpdir(), "ponderosa-unowned-fixture-"));
    directories.push(target);
    const marker = path.join(target, "keep.txt");
    writeFileSync(marker, "do not delete");
    const result = spawnSync(process.execPath, [
      "tools/high-cardinality/generate-fixture.mjs",
      "--force",
      "--projects=0",
      "--chats=0",
      "--agents=0",
      "--triggers=0",
      "--messages=0",
      "--data-dir=" + target,
    ], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sentinel is missing or invalid");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("do not delete");
  });

  it("rejects caller-selected benchmark work directories without altering them", () => {
    const target = mkdtempSync(path.join(tmpdir(), "ponderosa-unowned-work-"));
    directories.push(target);
    const marker = path.join(target, "keep.txt");
    writeFileSync(marker, "do not delete");
    const result = spawnSync(process.execPath, [
      "tools/high-cardinality/run-benchmark.mjs",
      "--work-dir=" + target,
    ], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--work-dir is not supported");
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses a sentinel-marked active Ponderosa data directory", () => {
    const target = mkdtempSync(path.join(tmpdir(), "ponderosa-protected-fixture-"));
    directories.push(target);
    const marker = path.join(target, "keep.txt");
    writeFileSync(marker, "do not delete");
    writeFileSync(path.join(target, ".ponderosa-high-cardinality-fixture.json"), JSON.stringify({
      kind: "ponderosa-high-cardinality-fixture",
      version: 1,
    }));
    const result = spawnSync(process.execPath, [
      "tools/high-cardinality/generate-fixture.mjs",
      "--force",
      "--data-dir=" + target,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PONDEROSA_DATA_DIR: target },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to overlap Ponderosa data directory");
    expect(readFileSync(marker, "utf8")).toBe("do not delete");
  });

  it("starts pristine and preserves exact authority counts across two benchmark restarts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-benchmark-smoke-"));
    directories.push(root);
    const fixture = path.join(root, "fixture");
    const generated = spawnSync(process.execPath, [
      "tools/high-cardinality/generate-fixture.mjs",
      "--projects=2",
      "--chats=4",
      "--agents=20",
      "--triggers=3",
      "--messages=10",
      "--data-dir=" + fixture,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
    if (generated.status !== 0) {
      throw new Error("smoke fixture generation failed: " + generated.stderr);
    }

    const runs = [0, 1].map(index => {
      const output = path.join(root, `result-${index}.json`);
      const port = 20_000 + (process.pid % 1_000) * 2 + index;
      const result = spawnSync(process.execPath, [
        "tools/high-cardinality/run-benchmark.mjs",
        "--fixture=" + fixture,
        "--output=" + output,
        "--port=" + port,
      ], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
      if (result.status !== 0) {
        throw new Error(`smoke benchmark ${index} failed: ${result.stderr}`);
      }
      return JSON.parse(readFileSync(output, "utf8")) as {
        counts: {
          initial: Record<string, number>;
          afterWorkload: Record<string, number>;
          afterRestart: Record<string, number>;
        };
      };
    });

    for (const run of runs) {
      expect(run.counts.initial).toMatchObject({
        projects: 2,
        conversations: 5,
        agents: 20,
        triggers: 3,
        messages: 10,
        activations: 0,
        runs: 0,
      });
      expect(run.counts.afterWorkload).toMatchObject({
        projects: 2,
        conversations: 5,
        agents: 20,
        triggers: 23,
        messages: 30,
        activations: 0,
        runs: 0,
      });
      expect(run.counts.afterRestart).toEqual(run.counts.afterWorkload);
    }
    expect(runs[1]?.counts.initial).toEqual(runs[0]?.counts.initial);
  });
});
