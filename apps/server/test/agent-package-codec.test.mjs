import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodePortableArtifact,
  encodePortableArtifact,
  parsePortablePackageFile,
  withAgentImportAdmission,
} from "../dist/agent-package-codec.js";

test("portable artifact codec preserves bytes and digest", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("small"), Buffer.from([0, 1, 254, 255])]) {
    const encoded = await encodePortableArtifact(bytes);
    const decoded = await decodePortableArtifact(encoded);
    assert.deepEqual(decoded.data, bytes);
    assert.equal(decoded.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("portable file parsing transfers validated bytes without changing content", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ponderosa-codec-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pathname = path.join(directory, "package.ponderosa-agent");
  const metadata = { source: "test" };
  const portable = { schemaVersion: 1, sourceLabel: "large-enough", agents: [] };
  await writeFile(pathname, `${JSON.stringify(metadata)}\n${JSON.stringify(portable)}`);
  assert.deepEqual(await parsePortablePackageFile(pathname), { metadata, portable });
});

test("import admission is held for the complete admitted lifecycle", async () => {
  const events = [];
  let releaseFirst;
  const first = withAgentImportAdmission(async () => {
    events.push("first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = withAgentImportAdmission(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("portable artifact decoder rejects malformed base64", async () => {
  for (const encoded of ["a!", "a", "YQ==junk", " YQ=="]) {
    await assert.rejects(decodePortableArtifact(encoded), /invalid base64/u);
  }
});
