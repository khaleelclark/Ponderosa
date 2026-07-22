import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSET_LIMITS, AssetAuthority, AssetError, AssetStore, contentDisposition, type RegisteredGeneratedArtifact } from "../src/assets.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("secure staged assets", () => {
  let dataDir: string;
  let assets: AssetStore;
  beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "pond-assets-")); assets = new AssetStore(dataDir); });
  afterEach(() => { assets.close(); rmSync(dataDir, { recursive: true, force: true }); });

  it("decodes and re-encodes one bounded raster while keeping immutable ownership and integrity", async () => {
    const staged = await assets.stage({ projectId: "project", agentId: "agent", body: PNG, name: "../safe.png", declaredType: "image/png" });
    expect(staged).toMatchObject({ agentId: "agent", name: "safe.png", mediaType: "image/png", width: 1, height: 1, state: "staged" });
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await assets.content("project", "agent", staged.id, true))?.body.subarray(1, 4).toString()).toBe("PNG");
    expect(await assets.read("other", "agent", staged.id)).toBeUndefined();
    const associated = await assets.associate("project", "agent", [staged.id]);
    expect(associated[0]?.state).toBe("associated");
    expect(await assets.remove("project", "agent", staged.id)).toBe(false);
  });

  it("does not settle a staged asset until the trusted attachment directory has synced", async () => {
    assets.close();
    assets = new AssetStore(dataDir, {
      beforeDirectorySync(phase) {
        if (phase === "stage") throw new Error("injected attachment directory sync failure");
      },
    });

    await expect(assets.stage({
      projectId: "project", agentId: "agent", body: Buffer.from("%PDF-1.7\ndurability"),
      name: "durability.pdf", declaredType: "application/pdf",
    })).rejects.toThrow("injected attachment directory sync failure");

    const authority = new Database(path.join(dataDir, "asset-authority.sqlite"), { readonly: true });
    expect(authority.prepare("SELECT count(*) count FROM asset_committed").get()).toEqual({ count: 0 });
    expect(authority.prepare("SELECT count(*) count FROM asset_reservations").get()).toEqual({ count: 0 });
    authority.close();

    // A failed sync leaves no settled authority. A fresh store can safely retry
    // after restart without relying on the failed upload's names.
    assets.close();
    assets = new AssetStore(dataDir);
    await expect(assets.stage({
      projectId: "project", agentId: "agent", body: Buffer.from("%PDF-1.7\nretry"),
      name: "retry.pdf", declaredType: "application/pdf",
    })).resolves.toMatchObject({ state: "staged" });
  });

  it("requires a directory-sync retry before reporting an associated metadata replacement", async () => {
    const staged = await assets.stage({
      projectId: "project", agentId: "agent", body: Buffer.from("%PDF-1.7\nassociate"),
      name: "associate.pdf", declaredType: "application/pdf",
    });
    assets.close();
    assets = new AssetStore(dataDir, {
      beforeDirectorySync(phase) {
        if (phase === "associate") throw new Error("injected association directory sync failure");
      },
    });

    await expect(assets.associate("project", "agent", [staged.id]))
      .rejects.toThrow("injected association directory sync failure");

    // The metadata rename can be visible after a failed fsync, but a restart
    // must not treat that as a completed association barrier: retry syncs the
    // retained directory before returning the associated result.
    assets.close();
    assets = new AssetStore(dataDir);
    await expect(assets.associate("project", "agent", [staged.id]))
      .resolves.toEqual([expect.objectContaining({ id: staged.id, state: "associated" })]);
  });

  it("resolves one immutable runtime snapshot only from exact Project, owner, ID, and bytes", async () => {
    const staged = await assets.stage({
      projectId: "project", agentId: "agent", body: Buffer.from("%PDF-1.7\nruntime"),
      name: "runtime.pdf", declaredType: "application/pdf",
    });
    const bound = assets.authoritativeRuntimeAttachment("project", "agent", staged.id);
    expect(bound).toMatchObject({
      attachment: {
        id: staged.id,
        agentId: "agent",
        name: "runtime.pdf",
        mediaType: "application/pdf",
        state: "associated",
      },
      localPath: path.join(dataDir, "projects", "project", "agents", "agent", "attachments", `${staged.id}.bin`),
    });
    expect(assets.authoritativeRuntimeAttachment("other", "agent", staged.id)).toBeUndefined();
    expect(assets.authoritativeRuntimeAttachment("project", "other", staged.id)).toBeUndefined();
    expect(assets.authoritativeRuntimeAttachment("project", "agent", staged.id.toUpperCase())).toBeUndefined();
    writeFileSync(bound!.localPath, "tampered");
    expect(assets.authoritativeRuntimeAttachment("project", "agent", staged.id)).toBeUndefined();
  });

  it("rejects attachment metadata, route, media, extension, and exact-byte drift", async () => {
    const staged = await assets.stage({
      projectId: "project", agentId: "agent", body: Buffer.from("%PDF-1.7\nauthoritative"),
      name: "authority.pdf", declaredType: "application/pdf",
    });
    const directory = path.join(dataDir, "projects", "project", "agents", "agent", "attachments");
    const metadataFile = path.join(directory, `${staged.id}.json`);
    const original = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    for (const drift of [
      { name: "authority.json" },
      { mediaType: "application/json" },
      { url: "/api/agents/other/assets/foreign/download" },
      { downloadUrl: "/api/agents/other/assets/foreign/download" },
      { previewUrl: "/unexpected-preview" },
      { unknownMetadata: true },
    ]) {
      writeFileSync(metadataFile, JSON.stringify({ ...original, ...drift }));
      expect(assets.authoritativeRuntimeAttachment("project", "agent", staged.id)).toBeUndefined();
    }
    writeFileSync(metadataFile, JSON.stringify(original));
    const contentFile = path.join(directory, `${staged.id}.bin`);
    const replacement = Buffer.from("%PDF-1.7\nsubstitution!");
    expect(replacement.length).toBe(staged.size);
    writeFileSync(contentFile, replacement);
    expect(assets.authoritativeRuntimeAttachment("project", "agent", staged.id)).toBeUndefined();
  });

  it("resolves closed Markdown artifacts only from the registered no-follow managed location", () => {
    const projectId = "project";
    const body = Buffer.from("# Durable report\n");
    const id = `text-${createHash("sha256").update("artifact-authority").digest("hex")}`;
    const contentDirectory = path.join(dataDir, "projects", projectId, "artifacts", "content");
    mkdirSync(contentDirectory, { recursive: true });
    const file = path.join(contentDirectory, id);
    writeFileSync(file, body, { mode: 0o600 });
    const artifact = {
      id, role: "document" as const, title: "Durable report", mediaType: "text/markdown" as const,
      blobPath: id, blobHash: createHash("sha256").update(body).digest("hex"), byteLength: body.length,
    };
    assets.registerRuntimeArtifact({ ...artifact, projectId, createdAt: "2026-07-19T00:00:00.000Z" });
    expect(assets.authoritativeRuntimeArtifact(projectId, artifact)).toMatchObject({
      artifact, body, localPath: file, contentHash: artifact.blobHash, byteLength: body.length,
    });
    expect(assets.authoritativeRuntimeArtifactById(projectId, id)).toMatchObject({ artifact, body });
    expect(assets.authoritativeRuntimeArtifact(projectId, { ...artifact, title: "Drift" })).toBeUndefined();
    expect(assets.authoritativeRuntimeArtifact(projectId, { ...artifact, blobPath: `../${id}` })).toBeUndefined();
    expect(assets.authoritativeRuntimeArtifact(projectId, { ...artifact, blobHash: "0".repeat(64) })).toBeUndefined();
    writeFileSync(file, Buffer.alloc(body.length, 0x78));
    expect(assets.authoritativeRuntimeArtifact(projectId, artifact)).toBeUndefined();
    expect(assets.authoritativeRuntimeArtifactById(projectId, id)).toBeUndefined();
    rmSync(file);
    const outside = path.join(dataDir, "outside-markdown");
    writeFileSync(outside, body);
    symlinkSync(outside, file);
    expect(assets.authoritativeRuntimeArtifact(projectId, artifact)).toBeUndefined();
    expect(assets.authoritativeRuntimeArtifactById(projectId, id)).toBeUndefined();
  });

  it("binds non-runtime generated files to immutable catalog metadata and no-follow exact bytes", () => {
    const projectId = "project";
    const id = randomUUID();
    const body = Buffer.from("immutable generated bytes");
    const directory = path.join(dataDir, "projects", projectId, "artifacts", "content");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, id);
    writeFileSync(file, body, { mode: 0o600 });
    const artifact: RegisteredGeneratedArtifact = {
      id, projectId, agentId: "agent", originAgentId: "agent", executionId: "run-1",
      kind: "generated_file", path: `generated/${id}.txt`, sourcePath: "output.txt",
      summary: "output.txt", createdAt: "2026-07-19T00:00:00.000Z", mediaType: "text/plain",
      size: body.length, sha256: createHash("sha256").update(body).digest("hex"),
    };
    expect(assets.registerGeneratedArtifact(artifact)).toEqual(artifact);
    expect(assets.authoritativeGeneratedArtifact(projectId, artifact)).toMatchObject({
      artifact, body, contentHash: artifact.sha256, byteLength: body.length,
    });
    for (const drift of [
      { projectId: "other" }, { agentId: "other" }, { originAgentId: "other" },
      { path: `generated/${id}.json` }, { summary: "other.txt" },
      { mediaType: "application/json" }, { size: body.length + 1 }, { sha256: "0".repeat(64) },
    ]) {
      expect(assets.authoritativeGeneratedArtifact(projectId, { ...artifact, ...drift })).toBeUndefined();
    }
    const replacement = Buffer.alloc(body.length, 0x78);
    expect(replacement.length).toBe(body.length);
    writeFileSync(file, replacement);
    expect(assets.authoritativeGeneratedArtifact(projectId, artifact)).toBeUndefined();
    rmSync(file);
    expect(assets.authoritativeGeneratedArtifact(projectId, artifact)).toBeUndefined();
    writeFileSync(file, body, { mode: 0o600 });
    expect(assets.authoritativeGeneratedArtifact(projectId, artifact)?.body).toEqual(body);
    rmSync(file);
    const outside = path.join(dataDir, "outside-generated");
    writeFileSync(outside, body);
    symlinkSync(outside, file);
    expect(assets.authoritativeGeneratedArtifact(projectId, artifact)).toBeUndefined();
  });

  it("reserves passive Communication assets before commit and recovers or releases them after restart", async () => {
    const committed = await assets.stage({
      projectId: "p", agentId: "t", body: Buffer.from("%PDF-1.7\ncommitted"),
      name: "committed.pdf", declaredType: "application/pdf",
    });
    const abandoned = await assets.stage({
      projectId: "p", agentId: "t", body: Buffer.from("%PDF-1.7\nabandoned"),
      name: "abandoned.pdf", declaredType: "application/pdf",
    });
    const committedHandle = assets.authoritativeRuntimeAttachment("p", "t", committed.id)!;
    const abandonedHandle = assets.authoritativeRuntimeAttachment("p", "t", abandoned.id)!;
    assets.reserveRuntimeCommunication("passive-committed", [{
      projectId: "p", agentId: "t", attachmentId: committed.id,
      contentHash: committedHandle.contentHash, byteLength: committedHandle.byteLength,
    }]);
    assets.reserveRuntimeCommunication("passive-abandoned", [{
      projectId: "p", agentId: "t", attachmentId: abandoned.id,
      contentHash: abandonedHandle.contentHash, byteLength: abandonedHandle.byteLength,
    }]);
    expect(await assets.reconcile("p", "t", new Set(), Date.now() + 25 * 60 * 60 * 1000)).toBe(0);
    expect((await assets.read("p", "t", committed.id))?.state).toBe("staged");
    assets.close();
    assets = new AssetStore(dataDir);
    expect(await assets.recoverRuntimeCommunicationAssociations((communicationId) => communicationId === "passive-committed"))
      .toEqual({ associated: 1, released: 1, unavailable: 0 });
    expect((await assets.read("p", "t", committed.id))?.state).toBe("associated");
    expect(await assets.reconcile("p", "t", new Set([committed.id]), Date.now() + 25 * 60 * 60 * 1000)).toBe(1);
    expect(await assets.read("p", "t", abandoned.id)).toBeUndefined();
  });

  it("compensates only exact association rows created by one reservation receipt", async () => {
    const first = await assets.stage({
      projectId: "p", agentId: "t", body: Buffer.from("%PDF-1.7\nreceipt-first"),
      name: "first.pdf", declaredType: "application/pdf",
    });
    const second = await assets.stage({
      projectId: "p", agentId: "t", body: Buffer.from("%PDF-1.7\nreceipt-second"),
      name: "second.pdf", declaredType: "application/pdf",
    });
    const firstAuthority = assets.authoritativeRuntimeAttachment("p", "t", first.id)!;
    const secondAuthority = assets.authoritativeRuntimeAttachment("p", "t", second.id)!;
    const binding = (attachmentId: string, contentHash: string, byteLength: number) => ({
      projectId: "p", agentId: "t", attachmentId, contentHash, byteLength,
    });
    const preexisting = assets.reserveRuntimeCommunication("receipt-scope", [
      binding(first.id, firstAuthority.contentHash, firstAuthority.byteLength),
    ]);
    const attempt = assets.reserveRuntimeCommunication("receipt-scope", [
      binding(first.id, firstAuthority.contentHash, firstAuthority.byteLength),
      binding(second.id, secondAuthority.contentHash, secondAuthority.byteLength),
    ]);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.bindings)).toBe(true);
    expect(attempt.bindings).toEqual([expect.objectContaining({
      communicationId: "receipt-scope",
      projectId: "p",
      agentId: "t",
      attachmentId: second.id,
      contentHash: secondAuthority.contentHash,
      byteLength: secondAuthority.byteLength,
      attemptId: attempt.attemptId,
    })]);
    expect(attempt.bindings[0]!.attemptId).not.toBe(preexisting.attemptId);

    assets.compensateRuntimeCommunicationReservation(attempt);
    assets.compensateRuntimeCommunicationReservation(attempt);
    let authorityDb = new Database(path.join(dataDir, "asset-authority.sqlite"));
    const rows = () => authorityDb.prepare(`
      SELECT asset_id assetId, reservation_attempt_id attemptId, content_hash contentHash
      FROM runtime_attachment_associations WHERE communication_id=? ORDER BY asset_id
    `).all("receipt-scope") as Array<{ assetId: string; attemptId: string; contentHash: string }>;
    expect(rows()).toEqual([{ assetId: first.id, attemptId: preexisting.attemptId, contentHash: firstAuthority.contentHash }]);

    const changed = assets.reserveRuntimeCommunication("changed-scope", [
      binding(second.id, secondAuthority.contentHash, secondAuthority.byteLength),
    ]);
    authorityDb.prepare(`
      UPDATE runtime_attachment_associations SET content_hash=?
      WHERE communication_id=? AND asset_id=?
    `).run("0".repeat(64), "changed-scope", second.id);
    assets.compensateRuntimeCommunicationReservation(changed);
    expect(authorityDb.prepare(`
      SELECT content_hash contentHash FROM runtime_attachment_associations
      WHERE communication_id=? AND asset_id=?
    `).get("changed-scope", second.id)).toEqual({ contentHash: "0".repeat(64) });

    const shared = assets.reserveRuntimeCommunication("receipt-scope", [
      binding(first.id, firstAuthority.contentHash, firstAuthority.byteLength),
    ]);
    expect(shared.bindings).toHaveLength(0);
    assets.compensateRuntimeCommunicationReservation(shared);
    expect(rows()).toEqual([{ assetId: first.id, attemptId: preexisting.attemptId, contentHash: firstAuthority.contentHash }]);

    const retryable = assets.reserveRuntimeCommunication("retryable-compensation", [
      binding(first.id, firstAuthority.contentHash, firstAuthority.byteLength),
    ]);
    expect(() => assets.compensateRuntimeCommunicationReservation({
      ...retryable,
      bindings: [{ ...retryable.bindings[0]!, projectId: "" }],
    })).toThrowError(AssetError);
    expect(authorityDb.prepare(`
      SELECT COUNT(*) count FROM runtime_attachment_associations
      WHERE communication_id='retryable-compensation'
    `).get()).toEqual({ count: 1 });
    assets.compensateRuntimeCommunicationReservation(retryable);
    expect(authorityDb.prepare(`
      SELECT COUNT(*) count FROM runtime_attachment_associations
      WHERE communication_id='retryable-compensation'
    `).get()).toEqual({ count: 0 });
    authorityDb.close();

    assets.close();
    assets = new AssetStore(dataDir);
    expect(await assets.recoverRuntimeCommunicationAssociations(() => false))
      .toEqual({ associated: 0, released: 2, unavailable: 0 });
    expect(await assets.recoverRuntimeCommunicationAssociations(() => false))
      .toEqual({ associated: 0, released: 0, unavailable: 0 });
    authorityDb = new Database(path.join(dataDir, "asset-authority.sqlite"), { readonly: true });
    expect((authorityDb.prepare("SELECT COUNT(*) count FROM runtime_attachment_associations").get() as { count: number }).count)
      .toBe(0);
    authorityDb.close();
  });

  it("rejects trailing payloads, active markup, MIME/extension disagreement, and corrupt integrity", async () => {
    await expect(assets.stage({ projectId: "p", agentId: "t", body: Buffer.concat([PNG, Buffer.from("<script>")]), name: "x.png", declaredType: "image/png" })).rejects.toMatchObject({ statusCode: 415 });
    await expect(assets.stage({ projectId: "p", agentId: "t", body: Buffer.from("<svg><script/></svg>"), name: "x.svg", declaredType: "image/svg+xml" })).rejects.toBeInstanceOf(AssetError);
    await expect(assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "x.pdf", declaredType: "application/pdf" })).rejects.toMatchObject({ statusCode: 415 });
    const staged = await assets.stage({ projectId: "p", agentId: "t", body: Buffer.from("%PDF-1.7\nactive content stays download-only"), name: "doc.pdf", declaredType: "application/pdf" });
    const stored = await assets.read("p", "t", staged.id);
    writeFileSync(path.join(dataDir, "projects", "p", "agents", "t", "attachments", stored!.originalFile), "tampered");
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
    ] as const) await expect(assets.stage({ projectId: "p", agentId: "t", body, name, declaredType: type })).rejects.toMatchObject({ statusCode: 415 });
  });

  it("confines canonical metadata filenames and rejects symlinked ownership parents", async () => {
    const staged = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "safe.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "agents", "t", "attachments");
    const metadata = JSON.parse(readFileSync(path.join(directory, `${staged.id}.json`), "utf8"));
    metadata.originalFile = "../../outside";
    writeFileSync(path.join(directory, `${staged.id}.json`), JSON.stringify(metadata));
    expect(await assets.read("p", "t", staged.id)).toBeUndefined();

    const outside = mkdtempSync(path.join(tmpdir(), "pond-assets-outside-"));
    rmSync(path.join(dataDir, "projects", "p", "agents", "t"), { recursive: true });
    symlinkSync(outside, path.join(dataDir, "projects", "p", "agents", "t"));
    await expect(assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "escape.png", declaredType: "image/png" })).rejects.toMatchObject({ statusCode: 409 });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("reconciles a crash after canonical message association and expires only old staged assets", async () => {
    const associated = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const orphan = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "b.png", declaredType: "image/png" });
    const removed = await assets.reconcile("p", "t", new Set([associated.id]), Date.now() + 25 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect((await assets.read("p", "t", associated.id))?.state).toBe("associated");
    expect(await assets.read("p", "t", orphan.id)).toBeUndefined();
    const audit = readFileSync(path.join(dataDir, "projects", "p", "agents", "t", "attachments", "audit.jsonl"), "utf8");
    expect(audit).not.toContain(dataDir);
  });

  it("reconciles raw half-write orphans and survives backup/restore", async () => {
    const staged = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "agents", "t", "attachments");
    const orphan = "00000000-0000-4000-8000-000000000000.bin";
    writeFileSync(path.join(directory, orphan), PNG);
    utimesSync(path.join(directory, orphan), new Date(0), new Date(0));
    expect(await assets.reconcile("p", "t", new Set(), Date.now())).toBe(1);
    expect(() => readFileSync(path.join(directory, orphan))).toThrow();

    const restored = mkdtempSync(path.join(tmpdir(), "pond-assets-restore-"));
    const restoredDir = path.join(restored, "projects", "p", "agents", "t", "attachments");
    mkdirSync(restoredDir, { recursive: true });
    for (const suffix of ["bin", "preview.png", "json"]) copyFileSync(path.join(directory, `${staged.id}.${suffix}`), path.join(restoredDir, `${staged.id}.${suffix}`));
    expect((await new AssetStore(restored).content("p", "t", staged.id, false))?.body.equals(PNG)).toBe(true);
    rmSync(restored, { recursive: true, force: true });
  });

  it("repairs only a torn audit tail and surfaces non-tail corruption", async () => {
    await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "a.png", declaredType: "image/png" });
    const audit = path.join(dataDir, "projects", "p", "agents", "t", "attachments", "audit.jsonl");
    writeFileSync(audit, "{\"torn\":", { flag: "a" });
    await expect(assets.stage({ projectId: "p", agentId: "t", body: Buffer.from("{}"), name: "b.json", declaredType: "application/json" })).resolves.toMatchObject({ state: "staged" });
    writeFileSync(audit, `${readFileSync(audit, "utf8")}not-json\n{\"tail\":`, "utf8");
    await expect(assets.stage({ projectId: "p", agentId: "t", body: Buffer.from("[]"), name: "c.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists rate limits across store restarts", async () => {
    for (let index = 0; index < 100; index++) await assets.stage({ projectId: "p", agentId: "t", body: Buffer.from(JSON.stringify({ index })), name: `${index}.json`, declaredType: "application/json" });
    await expect(new AssetStore(dataDir).stage({ projectId: "p", agentId: "t", body: Buffer.from("{}"), name: "blocked.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("accounts raw bytes durably for aggregate quota and persists concurrency slots across restart", async () => {
    const first = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "seed.png", declaredType: "image/png" });
    const directory = path.join(dataDir, "projects", "p", "agents", "t", "attachments");
    await assets.remove("p", "t", first.id);
    const block = Buffer.alloc(ASSET_LIMITS.maxFileBytes, 0x61);
    for (let index = 0; index < ASSET_LIMITS.maxAgentBytes / ASSET_LIMITS.maxFileBytes; index++) {
      writeFileSync(path.join(directory, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}.bin`), block);
    }
    await expect(new AssetStore(dataDir).stage({ projectId: "p", agentId: "t", body: Buffer.from("{}"), name: "over.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 413 });
    for (const entry of readdirSync(directory)) if (entry.endsWith(".bin")) rmSync(path.join(directory, entry));
    const cleanupDb = new Database(path.join(dataDir, "asset-authority.sqlite")); cleanupDb.prepare("DELETE FROM asset_committed WHERE project_id='p' AND agent_id='t'").run(); cleanupDb.close();

    const a = new AssetAuthority(dataDir); const b = new AssetAuthority(dataDir);
    const firstReservation = a.reserve("p", "other", randomUUID(), 1);
    b.reserve("p", "other", randomUUID(), 1);
    a.reserve("p", "other", randomUUID(), 1);
    b.reserve("p", "other", randomUUID(), 1);
    expect(() => a.reserve("p", "other", randomUUID(), 1)).toThrowError(AssetError);
    const clockDb = new Database(path.join(dataDir, "asset-authority.sqlite")); clockDb.prepare("UPDATE asset_reservations SET created_at=0 WHERE project_id='p' AND agent_id='other'").run(); clockDb.close();
    const successor = b.reserve("p", "other", randomUUID(), 1);
    expect(a.release(firstReservation)).toBe(false);
    expect(() => b.assertOwned(successor)).not.toThrow();
    a.close(); b.close();
  });

  it("recovers a real killed transaction and fences a stopped stale process from its successor", async () => {
    const authority = new AssetAuthority(dataDir);
    const db = path.join(dataDir, "asset-authority.sqlite");
    const child = spawn(process.execPath, ["-e", `
      const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
      db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO asset_reservations VALUES (?,?,?,?,?,?)').run('child','child-asset','p','race',1,1000000);
      if(process.env.MODE==='crash') { console.log('ready'); setInterval(()=>{},1000); }
      else { db.exec('COMMIT'); console.log('ready'); process.on('SIGCONT',()=>{db.prepare('DELETE FROM asset_reservations WHERE id=?').run('child');}); setInterval(()=>{},1000); }
    `, db], { env: { ...process.env, MODE: "crash" }, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
    expect(() => authority.reserve("p", "race", randomUUID(), 1)).not.toThrow();

    const stopped = spawn(process.execPath, ["-e", `
      const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
      db.prepare('INSERT OR REPLACE INTO asset_reservations VALUES (?,?,?,?,?,?)').run('stale-child','stale-asset','p','stale',1,1000000);
      console.log('ready'); process.on('SIGCONT',()=>db.prepare('DELETE FROM asset_reservations WHERE id=?').run('stale-child')); setInterval(()=>{},1000);
    `, db], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => stopped.stdout!.once("data", () => resolve())); stopped.kill("SIGSTOP");
    const staleDb = new Database(db); staleDb.prepare("UPDATE asset_reservations SET created_at=0 WHERE id='stale-child'").run(); staleDb.close();
    const successor = authority.reserve("p", "stale", randomUUID(), 1);
    stopped.kill("SIGCONT"); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => authority.assertOwned(successor)).not.toThrow();
    stopped.kill("SIGKILL"); authority.close();
  });

  it("rejects expired ownership and stale quota snapshots at settlement boundaries", () => {
    const authority = new AssetAuthority(dataDir);
    const usage = new Map(Array.from({ length: ASSET_LIMITS.maxAgentBytes / ASSET_LIMITS.maxFileBytes - 1 }, (_, index) => [`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, ASSET_LIMITS.maxFileBytes]));
    authority.syncAgent("p", "quota", usage);
    const first = authority.reserve("p", "quota", randomUUID(), ASSET_LIMITS.maxFileBytes);
    authority.settle(first);
    expect(() => authority.reserve("p", "quota", randomUUID(), ASSET_LIMITS.maxFileBytes)).toThrowError(AssetError);
    const expired = authority.reserve("p", "expiry", randomUUID(), 1);
    const db = new Database(path.join(dataDir, "asset-authority.sqlite")); db.prepare("UPDATE asset_reservations SET created_at=0 WHERE id=?").run(expired); db.close();
    expect(() => authority.assertOwned(expired)).toThrowError(AssetError);
    authority.close();
  });

  it("fails stably on corrupt and incompatible authority databases", () => {
    assets.close();
    writeFileSync(path.join(dataDir, "asset-authority.sqlite"), "not a database");
    expect(() => new AssetAuthority(dataDir)).toThrowError(AssetError);
    rmSync(path.join(dataDir, "asset-authority.sqlite"), { force: true });
    const db = new Database(path.join(dataDir, "asset-authority.sqlite")); db.pragma("user_version=999"); db.close();
    expect(() => new AssetAuthority(dataDir)).toThrowError(AssetError);
    dataDir = mkdtempSync(path.join(tmpdir(), "pond-assets-replacement-")); assets = new AssetStore(dataDir);
  });

  it("rejects duplicate owners and makes sync, settlement, and deletion idempotent", () => {
    const authority = new AssetAuthority(dataDir); const id = randomUUID();
    authority.syncAgent("p", "one", new Map([[id, 8]]));
    expect(() => authority.syncAgent("p", "two", new Map([[id, 8]]))).toThrowError(AssetError);
    const activeId = randomUUID(); const reservation = authority.reserve("p", "active", activeId, 9);
    authority.syncAgent("p", "active", new Map([[activeId, 9]]));
    authority.settle(reservation); expect(() => authority.settle(reservation)).not.toThrow();
    authority.beginDelete(id, "p", "one"); authority.finishDelete(id);
    authority.syncAgent("p", "one", new Map([[id, 8]]));
    const db = new Database(path.join(dataDir, "asset-authority.sqlite"));
    expect((db.prepare("SELECT count(*) count FROM asset_committed WHERE asset_id=?").get(id) as { count: number }).count).toBe(0);
    db.close(); authority.close();
  });

  it("maps BEGIN IMMEDIATE contention to stable AssetError", async () => {
    const authority = new AssetAuthority(dataDir); const db = path.join(dataDir, "asset-authority.sqlite");
    const child = spawn(process.execPath, ["-e", `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.exec('BEGIN IMMEDIATE');console.log('ready');setInterval(()=>{},1000)`, db], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    expect(() => authority.reserve("p", "busy", randomUUID(), 1)).toThrowError(AssetError);
    child.kill("SIGKILL"); authority.close();
  });

  it("fails closed on duplicate audit event IDs", async () => {
    const directory = path.join(dataDir, "projects", "p", "agents", "dup", "attachments"); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "audit.jsonl"), '{"event_id":"same","action":"a"}\n{"event_id":"same","action":"b"}\n');
    await expect(assets.stage({ projectId: "p", agentId: "dup", body: Buffer.from("{}"), name: "x.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never follows or mutates symlinked, hardlinked, or non-regular audit leaves", async () => {
    for (const kind of ["symlink", "hardlink", "directory"] as const) {
      const agentId = `unsafe-${kind}`; const directory = path.join(dataDir, "projects", "p", "agents", agentId, "attachments"); mkdirSync(directory, { recursive: true });
      const leaf = path.join(directory, "audit.jsonl"); const outside = path.join(dataDir, `${kind}-outside`); const original = '{"event_id":"old","action":"staged"}\n{"torn":';
      if (kind === "directory") mkdirSync(leaf); else { writeFileSync(outside, original, { mode: 0o600 }); kind === "symlink" ? symlinkSync(outside, leaf) : linkSync(outside, leaf); }
      await expect(assets.stage({ projectId: "p", agentId, body: Buffer.from("{}"), name: "x.json", declaredType: "application/json" })).rejects.toMatchObject({ statusCode: 409 });
      if (kind !== "directory") expect(readFileSync(outside, "utf8")).toBe(original);
    }
  });

  it("keeps audit repair bound to its opened inode across leaf replacement", () => {
    const directory = path.join(dataDir, "replacement"); mkdirSync(directory); const leaf = path.join(directory, "audit.jsonl"); const saved = path.join(directory, "opened.jsonl"); const outside = path.join(dataDir, "replacement-outside");
    writeFileSync(leaf, '{"event_id":"existing","action":"recorded"}\n{"torn":', { mode: 0o600 }); writeFileSync(outside, "outside", { mode: 0o600 });
    const authority = new AssetAuthority(dataDir, { afterAuditOpen: () => { renameSync(leaf, saved); symlinkSync(outside, leaf); } });
    authority.recordAudit(leaf, "p", "t", { action: "new" });
    expect(readFileSync(outside, "utf8")).toBe("outside"); expect(readFileSync(saved, "utf8")).toContain('"action":"new"');
    authority.close();
  });

  it("does not recreate asset storage after whole-agent deletion", async () => {
    const staged = await assets.stage({ projectId: "p", agentId: "t", body: PNG, name: "gone.png", declaredType: "image/png" });
    const agentDirectory = path.join(dataDir, "projects", "p", "agents", "t");
    rmSync(agentDirectory, { recursive: true });
    expect(await new AssetStore(dataDir).read("p", "t", staged.id)).toBeUndefined();
    expect(() => readFileSync(agentDirectory)).toThrow();
  });

  it("emits a bounded RFC 5987 download name without header injection", () => {
    const value = contentDisposition("résumé\r\nInjected: yes.pdf");
    expect(value).toContain("filename*=UTF-8''");
    expect(value).not.toMatch(/[\r\n]/);
  });

  it("bounds concurrent uploads per agent", async () => {
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map((name) => assets.stage({
      projectId: "p", agentId: "t", body: PNG, name: `${name}.png`, declaredType: "image/png",
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 429 });
  });
});
