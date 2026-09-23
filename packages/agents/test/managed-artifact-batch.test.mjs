import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  publishManagedArtifactContentsAsync,
  readManagedArtifactContentsAsync,
} from "../dist/index.js";

test("async managed artifact batches preserve order and exact durable bytes across chunks", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-artifact-batch-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const inputs = Array.from({ length: 270 }, (_, index) => ({
    artifactId: `artifact-${index}`,
    input: Buffer.from(`contents-${index}`),
  }));
  const published = await publishManagedArtifactContentsAsync(dataDir, "project-a", inputs, 3);
  assert.equal(published.length, inputs.length);
  for (const [index, item] of inputs.entries()) {
    assert.equal(published[index].size, item.input.length);
    assert.equal(published[index].sha256, createHash("sha256").update(item.input).digest("hex"));
    assert.deepEqual(await readFile(published[index].path), item.input);
  }
  const replay = await publishManagedArtifactContentsAsync(dataDir, "project-a", inputs, 3);
  assert.deepEqual(replay, published);
  const read = await readManagedArtifactContentsAsync(dataDir, "project-a", published.map((item, index) => ({
    artifactId: inputs[index].artifactId,
    expectedSize: item.size,
    expectedSha256: item.sha256,
  })));
  for (const [index, body] of read.entries()) assert.deepEqual(body, inputs[index].input);
  const [changed] = await readManagedArtifactContentsAsync(dataDir, "project-a", [{
    artifactId: inputs[0].artifactId,
    expectedSize: published[0].size,
    expectedSha256: "0".repeat(64),
  }]);
  assert.equal(changed, undefined);
});

test("async managed artifact batches reject duplicate and conflicting identities", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-artifact-conflict-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(
    publishManagedArtifactContentsAsync(dataDir, "project-a", [
      { artifactId: "same", input: "first" },
      { artifactId: "same", input: "second" },
    ]),
    /identities must be unique/u,
  );
  const [original] = await publishManagedArtifactContentsAsync(dataDir, "project-a", [
    { artifactId: "same", input: "original" },
  ]);
  await assert.rejects(
    publishManagedArtifactContentsAsync(dataDir, "project-a", [
      { artifactId: "same", input: "different" },
    ]),
    /identity collision/u,
  );
  assert.equal(await readFile(original.path, "utf8"), "original");
});
