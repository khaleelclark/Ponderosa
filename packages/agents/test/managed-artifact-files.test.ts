import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  readManagedArtifactContent,
  repairManagedArtifactContent,
} from "../src/managed-artifact-files.js";
import { managedArtifactContentPath } from "../src/paths.js";

describe("Project-owned managed artifact files", () => {
  let dataDir: string;
  const projectId = "project";
  const artifactId = "artifact";
  const body = Buffer.from("immutable artifact bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");

  beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "managed-artifact-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("fsync-publishes idempotent bytes and rejects an identity collision", () => {
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

  it("keeps a read bound to its opened inode across a leaf swap", () => {
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

  it.each(["afterTemporaryOpen", "beforeRename", "afterRename"] as const)(
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

  it("fails closed when an ancestor is swapped after the read opens", () => {
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

  it("reserves an in-flight publication from orphan repair", () => {
    const repairedDuringPublication: string[][] = [];
    const published = publishManagedArtifactContent(dataDir, projectId, artifactId, body, {
      afterTemporaryOpen: () => repairedDuringPublication.push(
        repairManagedArtifactContent(dataDir, projectId, new Set(), Date.now() + 60_000),
      ),
    });
    expect(repairedDuringPublication).toEqual([[]]);
    expect(readFileSync(published.path)).toEqual(body);
  });
});
