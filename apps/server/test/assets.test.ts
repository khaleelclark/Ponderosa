import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetError, AssetStore, contentDisposition } from "../src/assets.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("secure staged assets", () => {
  let dataDir: string;
  let assets: AssetStore;
  beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "pond-assets-")); assets = new AssetStore(dataDir); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("decodes and re-encodes one bounded raster while keeping immutable ownership and integrity", async () => {
    const staged = await assets.stage({ projectId: "project", threadId: "thread", body: PNG, name: "../safe.png", declaredType: "image/png" });
    expect(staged).toMatchObject({ threadId: "thread", name: "safe.png", mediaType: "image/png", width: 1, height: 1, state: "staged" });
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await assets.content("project", "thread", staged.id, true))?.body.subarray(1, 4).toString()).toBe("PNG");
    expect(await assets.read("other", "thread", staged.id)).toBeUndefined();
    const associated = await assets.associate("project", "thread", [staged.id]);
    expect(associated[0]?.state).toBe("associated");
    expect(await assets.remove("project", "thread", staged.id)).toBe(false);
  });

  it("rejects trailing payloads, active markup, MIME/extension disagreement, and corrupt integrity", async () => {
    await expect(assets.stage({ projectId: "p", threadId: "t", body: Buffer.concat([PNG, Buffer.from("<script>")]), name: "x.png", declaredType: "image/png" })).rejects.toMatchObject({ statusCode: 415 });
    await expect(assets.stage({ projectId: "p", threadId: "t", body: Buffer.from("<svg><script/></svg>"), name: "x.svg", declaredType: "image/svg+xml" })).rejects.toBeInstanceOf(AssetError);
    await expect(assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "x.pdf", declaredType: "application/pdf" })).rejects.toMatchObject({ statusCode: 415 });
    const staged = await assets.stage({ projectId: "p", threadId: "t", body: Buffer.from("%PDF-1.7\nactive content stays download-only"), name: "doc.pdf", declaredType: "application/pdf" });
    const stored = await assets.read("p", "t", staged.id);
    writeFileSync(path.join(dataDir, "projects", "p", "threads", "t", "attachments", stored!.originalFile), "tampered");
    expect(await assets.content("p", "t", staged.id, false)).toBeUndefined();
  });

  it("reconciles a crash after canonical message association and expires only old staged assets", async () => {
    const associated = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const orphan = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "b.png", declaredType: "image/png" });
    const removed = await assets.reconcile("p", "t", new Set([associated.id]), Date.now() + 25 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect((await assets.read("p", "t", associated.id))?.state).toBe("associated");
    expect(await assets.read("p", "t", orphan.id)).toBeUndefined();
    const audit = readFileSync(path.join(dataDir, "projects", "p", "threads", "t", "attachments", "audit.jsonl"), "utf8");
    expect(audit).not.toContain(dataDir);
  });

  it("emits a bounded RFC 5987 download name without header injection", () => {
    const value = contentDisposition("résumé\r\nInjected: yes.pdf");
    expect(value).toContain("filename*=UTF-8''");
    expect(value).not.toMatch(/[\r\n]/);
  });

  it("bounds concurrent uploads per thread", async () => {
    const results = await Promise.allSettled(["a", "b", "c"].map((name) => assets.stage({
      projectId: "p", threadId: "t", body: PNG, name: `${name}.png`, declaredType: "image/png",
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 429 });
  });
});
