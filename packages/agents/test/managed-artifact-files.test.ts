import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publishManagedArtifactContent,
  openManagedArtifactContent,
  readManagedArtifactContent,
  repairManagedArtifactContent,
} from "../src/managed-artifact-files.js";
import { managedArtifactContentPath } from "../src/paths.js";

const itWithManagedArtifacts = process.platform === "linux" ? it : it.skip;

describe("Project-owned managed artifact files", () => {
  let dataDir: string;
  const projectId = "project";
  const artifactId = "artifact";
  const body = Buffer.from("immutable artifact bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");

  beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "managed-artifact-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  itWithManagedArtifacts("fsync-publishes idempotent bytes and rejects an identity collision", () => {
    const first = publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    expect(first).toMatchObject({ size: body.length, sha256 });
    expect(readFileSync(first.path)).toEqual(body);
    expect(publishManagedArtifactContent(dataDir, projectId, artifactId, body)).toEqual(first);
    expect(() => publishManagedArtifactContent(dataDir, projectId, artifactId, Buffer.from("different")))
      .toThrow(/collision|unsafe/);
  });

  it("rejects nested or traversal artifact identities", () => {
    expect(() => publishManagedArtifactContent(dataDir, projectId, "nested/artifact", body)).toThrow(/safe leaf/);
    expect(readManagedArtifactContent(dataDir, projectId, "nested/artifact", body.length, sha256)).toBeUndefined();
    expect(() => publishManagedArtifactContent(dataDir, projectId, "../artifact", body)).toThrow(/safe leaf/);
  });

  it.each(["symlink", "hardlink", "directory"] as const)("rejects an unsafe %s leaf", (kind) => {
    const file = managedArtifactContentPath(dataDir, projectId, artifactId);
    mkdirSync(path.dirname(file), { recursive: true });
    const outside = path.join(dataDir, `${kind}-outside`);
    writeFileSync(outside, body);
    if (kind === "symlink") symlinkSync(outside, file);
    else if (kind === "hardlink") linkSync(outside, file);
    else mkdirSync(file);
    expect(readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256)).toBeUndefined();
    expect(() => publishManagedArtifactContent(dataDir, projectId, artifactId, body)).toThrow();
    expect(readFileSync(outside)).toEqual(body);
  });

  itWithManagedArtifacts("keeps a read bound to its opened inode across a leaf swap", () => {
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const saved = `${published.path}.opened`;
    const outside = path.join(dataDir, "replacement-outside");
    writeFileSync(outside, Buffer.from("replacement"));
    const read = readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256, {
      afterOpen: (file) => {
        renameSync(file, saved);
        symlinkSync(outside, file);
      },
    });
    expect(read?.body).toEqual(body);
    expect(readFileSync(outside, "utf8")).toBe("replacement");
  });

  itWithManagedArtifacts.each(["afterTemporaryOpen", "beforeRename", "afterRename"] as const)(
    "fails closed when an ancestor is swapped at %s",
    (fault) => {
      const contentDirectory = path.dirname(managedArtifactContentPath(dataDir, projectId, artifactId));
      const retained = `${contentDirectory}.retained`;
      const replacement = `${contentDirectory}.replacement`;
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        renameSync(contentDirectory, retained);
        mkdirSync(replacement);
        symlinkSync(replacement, contentDirectory);
      };
      expect(() => publishManagedArtifactContent(dataDir, projectId, artifactId, body, { [fault]: swap }))
        .toThrow(/directory changed/);
      expect(() => readFileSync(path.join(replacement, artifactId))).toThrow();
    },
  );

  itWithManagedArtifacts("fails closed when an ancestor is swapped after the read opens", () => {
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const contentDirectory = path.dirname(published.path);
    const retained = `${contentDirectory}.retained`;
    const replacement = `${contentDirectory}.replacement`;
    const read = readManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256, {
      afterOpen: () => {
        renameSync(contentDirectory, retained);
        mkdirSync(replacement);
        symlinkSync(replacement, contentDirectory);
      },
    });
    expect(read).toBeUndefined();
  });

  itWithManagedArtifacts("reserves an in-flight publication from orphan repair", () => {
    const repairedDuringPublication: string[][] = [];
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body, {
      afterTemporaryOpen: () => repairedDuringPublication.push(
        repairManagedArtifactContent(dataDir, projectId, new Set(), Date.now() + 60_000),
      ),
    });
    expect(repairedDuringPublication).toEqual([[]]);
    expect(readFileSync(published.path)).toEqual(body);
  });

  itWithManagedArtifacts("hashes asynchronously, retains only bounded preview bytes, and streams the verified descriptor", async () => {
    const large = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const hash = createHash("sha256").update(large).digest("hex");
    publishManagedArtifactContent(dataDir, projectId, artifactId, large);
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const opened = await openManagedArtifactContent(dataDir, projectId, artifactId, large.length, hash);
    clearTimeout(timer);
    expect(timerFired).toBe(true);
    expect(opened).toBeDefined();
    const preview = await opened!.readRange(1024);
    expect(preview).toEqual(large.subarray(0, 1024));

    const streamedHash = createHash("sha256");
    let streamedBytes = 0;
    for await (const chunk of opened!.createReadStream()) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      streamedHash.update(bytes);
      streamedBytes += bytes.length;
    }
    expect(streamedBytes).toBe(large.length);
    expect(streamedHash.digest("hex")).toBe(hash);
  });

  itWithManagedArtifacts("streams the verified snapshot after a same-size source mutation", async () => {
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const mutated = Buffer.alloc(body.length, 0x78);
    const opened = await openManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256, {
      faults: { afterVerification: (file) => writeFileSync(file, mutated) },
    });
    expect(opened).toBeDefined();
    expect(readFileSync(published.path)).toEqual(mutated);
    expect(await opened!.readRange(body.length)).toEqual(body);
    const streamed: Buffer[] = [];
    for await (const chunk of opened!.createReadStream()) {
      streamed.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(streamed)).toEqual(body);
  });

  itWithManagedArtifacts("protects an opening snapshot from repair and removes it after failure", async () => {
    publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const repaired: string[][] = [];
    const opened = await openManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256, {
      faults: {
        afterSnapshotOpen: () => {
          repaired.push(repairManagedArtifactContent(dataDir, projectId, new Set([artifactId]), Date.now() + 60_000));
          throw new Error("snapshot setup failed");
        },
      },
    });
    expect(opened).toBeUndefined();
    expect(repaired).toEqual([[]]);
    expect(readdirSync(path.dirname(managedArtifactContentPath(dataDir, projectId, artifactId))))
      .toEqual([artifactId]);
  });

  itWithManagedArtifacts("removes an abandoned snapshot during startup-style orphan repair", () => {
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const abandoned = path.join(path.dirname(published.path), `.${artifactId}.abandoned.snapshot`);
    writeFileSync(abandoned, body);
    expect(repairManagedArtifactContent(dataDir, projectId, new Set([artifactId]), Date.now() + 60_000))
      .toEqual([path.basename(abandoned)]);
    expect(readdirSync(path.dirname(published.path))).toEqual([artifactId]);
  });

  itWithManagedArtifacts("cancels an async managed-artifact verification while retaining descriptor safety", async () => {
    publishManagedArtifactContent(dataDir, projectId, artifactId, body);
    const controller = new AbortController();
    await expect(openManagedArtifactContent(dataDir, projectId, artifactId, body.length, sha256, {
      signal: controller.signal,
      faults: { afterOpen: () => controller.abort(new Error("cancelled test read")) },
    })).rejects.toThrow(/cancelled test read/);
    expect(readdirSync(path.dirname(managedArtifactContentPath(dataDir, projectId, artifactId))))
      .toEqual([artifactId]);
  });
});
