import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSET_LIMITS, AssetAuthority, AssetError, AssetStore, contentDisposition } from "../src/assets.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("secure staged assets", () => {
  let dataDir: string;
  let assets: AssetStore;
  beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "pond-assets-")); assets = new AssetStore(dataDir); });
  afterEach(() => { assets.close(); rmSync(dataDir, { recursive: true, force: true }); });

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

  it("rejects malformed, polyglot, animated, and excessive-pixel raster inputs", async () => {
    const highPixels = Buffer.from(PNG);
    highPixels.writeUInt32BE(100_000, 16); highPixels.writeUInt32BE(100_000, 20);
    const animatedWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.from([0x02]), Buffer.alloc(9)]);
    animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4);
    for (const [body, name, type] of [
      [Buffer.from("\x89PNG\r\n\x1a\nmalformed"), "bad.png", "image/png"],
      [Buffer.concat([PNG, Buffer.from("PK\x03\x04polyglot")]), "poly.png", "image/png"],
      [highPixels, "huge.png", "image/png"],
      [animatedWebp, "animated.webp", "image/webp"],
    ] as const) await expect(assets.stage({ projectId: "p", threadId: "t", body, name, declaredType: type })).rejects.toMatchObject({ statusCode: 415 });
  });

  it("confines canonical metadata filenames and rejects symlinked ownership parents", async () => {
    const staged = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "safe.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "threads", "t", "attachments");
    const metadata = JSON.parse(readFileSync(path.join(directory, `${staged.id}.json`), "utf8"));
    metadata.originalFile = "../../outside";
    writeFileSync(path.join(directory, `${staged.id}.json`), JSON.stringify(metadata));
    expect(await assets.read("p", "t", staged.id)).toBeUndefined();

    const outside = mkdtempSync(path.join(tmpdir(), "pond-assets-outside-"));
    rmSync(path.join(dataDir, "projects", "p", "threads", "t"), { recursive: true });
    symlinkSync(outside, path.join(dataDir, "projects", "p", "threads", "t"));
    await expect(assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "escape.png", declaredType: "image/png" })).rejects.toMatchObject({ statusCode: 409 });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
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

  it("reconciles raw half-write orphans and survives backup/restore", async () => {
    const staged = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "threads", "t", "attachments");
    const orphan = "00000000-0000-4000-8000-000000000000.bin";
    writeFileSync(path.join(directory, orphan), PNG);
    utimesSync(path.join(directory, orphan), new Date(0), new Date(0));
    expect(await assets.reconcile("p", "t", new Set(), Date.now())).toBe(1);
    expect(() => readFileSync(path.join(directory, orphan))).toThrow();

    const restored = mkdtempSync(path.join(tmpdir(), "pond-assets-restore-"));
    const restoredDir = path.join(restored, "projects", "p", "threads", "t", "attachments");
    mkdirSync(restoredDir, { recursive: true });
    for (const suffix of ["bin", "preview.png", "json"]) copyFileSync(path.join(directory, `${staged.id}.${suffix}`), path.join(restoredDir, `${staged.id}.${suffix}`));
    expect((await new AssetStore(restored).content("p", "t", staged.id, false))?.body.equals(PNG)).toBe(true);
    rmSync(restored, { recursive: true, force: true });
  });

  it("repairs only a torn audit tail and surfaces non-tail corruption", async () => {
    await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const audit = path.join(dataDir, "projects", "p", "threads", "t", "attachments", "audit.jsonl");
    writeFileSync(audit, "{\"torn\":", { flag: "a" });
    await expect(assets.stage({ projectId: "p", threadId: "t", body: Buffer.from("{}"), name: "b.json", declaredType: "application/json" })).resolves.toMatchObject({ state: "staged" });
    writeFileSync(audit, `${readFileSync(audit, "utf8")}not-json\n{\"tail\":`, "utf8");
    await expect(assets.stage({ projectId: "p", threadId: "t", body: Buffer.from("[]"), name: "c.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists rate limits across store restarts", async () => {
    for (let index = 0; index < 20; index++) await assets.stage({ projectId: "p", threadId: "t", body: Buffer.from(JSON.stringify({ index })), name: `${index}.json`, declaredType: "application/json" });
    await expect(new AssetStore(dataDir).stage({ projectId: "p", threadId: "t", body: Buffer.from("{}"), name: "blocked.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("accounts raw bytes durably for aggregate quota and persists concurrency slots across restart", async () => {
    const first = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "seed.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "threads", "t", "attachments");
    await assets.remove("p", "t", first.id);
    const block = Buffer.alloc(ASSET_LIMITS.maxFileBytes, 0x61);
    for (let index = 0; index < ASSET_LIMITS.maxThreadBytes / ASSET_LIMITS.maxFileBytes; index++) {
      writeFileSync(path.join(directory, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}.bin`), block);
    }
    await expect(new AssetStore(dataDir).stage({ projectId: "p", threadId: "t", body: Buffer.from("{}"), name: "over.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 413 });
    for (const entry of readdirSync(directory)) if (entry.endsWith(".bin")) rmSync(path.join(directory, entry));

    const a = new AssetAuthority(dataDir); const b = new AssetAuthority(dataDir);
    const firstReservation = a.reserve("p", "other", 1, 0, 1_000_000);
    b.reserve("p", "other", 1, 0, 1_000_000);
    expect(() => a.reserve("p", "other", 1, 0, 1_000_000)).toThrowError(AssetError);
    const successor = b.reserve("p", "other", 1, 0, 1_000_000 + 5 * 60 * 1000 + 1);
    expect(a.release(firstReservation)).toBe(false);
    expect(() => b.assertOwned(successor)).not.toThrow();
    a.close(); b.close();
  });

  it("recovers a real killed transaction and fences a stopped stale process from its successor", async () => {
    const authority = new AssetAuthority(dataDir);
    const db = path.join(dataDir, "asset-authority.sqlite");
    const child = spawn(process.execPath, ["-e", `
      const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
      db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO asset_reservations VALUES (?,?,?,?,?)').run('child','p','race',1,1000000);
      if(process.env.MODE==='crash') { console.log('ready'); setInterval(()=>{},1000); }
      else { db.exec('COMMIT'); console.log('ready'); process.on('SIGCONT',()=>{db.prepare('DELETE FROM asset_reservations WHERE id=?').run('child');}); setInterval(()=>{},1000); }
    `, db], { env: { ...process.env, MODE: "crash" }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
    expect(() => authority.reserve("p", "race", 1, 0, 1_000_000)).not.toThrow();

    const stopped = spawn(process.execPath, ["-e", `
      const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
      db.prepare('INSERT OR REPLACE INTO asset_reservations VALUES (?,?,?,?,?)').run('stale-child','p','stale',1,1000000);
      console.log('ready'); process.on('SIGCONT',()=>db.prepare('DELETE FROM asset_reservations WHERE id=?').run('stale-child')); setInterval(()=>{},1000);
    `, db], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => stopped.stdout!.once("data", () => resolve())); stopped.kill("SIGSTOP");
    const successor = authority.reserve("p", "stale", 1, 0, 1_000_000 + 5 * 60 * 1000 + 1);
    stopped.kill("SIGCONT"); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => authority.assertOwned(successor)).not.toThrow();
    stopped.kill("SIGKILL"); authority.close();
  });

  it("does not recreate asset storage after whole-thread deletion", async () => {
    const staged = await assets.stage({ projectId: "p", threadId: "t", body: PNG, name: "gone.png", declaredType: "image/png" });
    const threadDirectory = path.join(dataDir, "projects", "p", "threads", "t");
    rmSync(threadDirectory, { recursive: true });
    expect(await new AssetStore(dataDir).read("p", "t", staged.id)).toBeUndefined();
    expect(() => readFileSync(threadDirectory)).toThrow();
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
