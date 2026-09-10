import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../dist/assets.js";
import { appendReadableArtifactReferences, createCommunicationArtifactAuthority } from "../dist/communication-artifacts.js";

test("a long pasted message resolves to the complete immutable file, including its tail", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-readable-paste-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const assets = new AssetStore(dataDir);
  t.after(() => assets.close());
  const artifacts = new Map();
  const store = {
    getProjectArtifact: (projectId, id) => artifacts.get(`${projectId}:${id}`),
    agentCanReadProjectArtifact: (projectId, id, agentId) => projectId === "project-a" && agentId === "agent-a",
  };
  const authority = createCommunicationArtifactAuthority({ dataDir, assets, store });
  const fullText = "Read this complete pasted document.\n" + "ordinary text 😀\n".repeat(2000) + "TAIL_SENTINEL_8c721 🦊";
  const prepared = await authority.prepareUserCommunicationText({
    projectId: "project-a", communicationId: "test-paste", text: fullText, createdAt: new Date().toISOString(),
  });
  assert.ok(prepared.artifact);
  assert.ok(!prepared.publishedText.includes("TAIL_SENTINEL"));
  const artifact = {
    id: prepared.artifact.id, projectId: "project-a", kind: "document",
    size: prepared.artifact.byteLength, sha256: prepared.artifact.blobHash,
  };
  artifacts.set(`project-a:${artifact.id}`, artifact);
  const render = overrides => appendReadableArtifactReferences({
    prompt: prepared.publishedText, projectId: "project-a", agentId: "agent-a", store, assets, ...overrides,
  });
  const prompt = render();
  const metadata = JSON.parse(prompt.split("\n").at(-1));
  assert.equal(readFileSync(metadata.localPath, "utf8"), fullText);
  assert.equal(metadata.byteLength, Buffer.byteLength(fullText));
  assert.equal(metadata.sha256, artifact.sha256);
  assert.ok(prompt.includes("read successive chunks through the end"));
  assert.ok(prompt.length < fullText.length);
  assert.deepEqual(JSON.parse(render({ agentId: "agent-b" }).split("\n").at(-1)), { artifactId: artifact.id, available: false });
  assert.deepEqual(JSON.parse(render({ projectId: "project-b" }).split("\n").at(-1)), { artifactId: artifact.id, available: false });
  writeFileSync(metadata.localPath, "tampered");
  assert.deepEqual(JSON.parse(render().split("\n").at(-1)), { artifactId: artifact.id, available: false });
});

test("plain text stays exact; references deduplicate and unavailable paths do not leak", () => {
  let resolutions = 0;
  const store = { getProjectArtifact: () => undefined, agentCanReadProjectArtifact: () => false };
  const assets = { authoritativeManagedProjectArtifact: () => { resolutions++; throw new Error("must not resolve unauthorized bytes"); } };
  const render = prompt => appendReadableArtifactReferences({ prompt, projectId: "p", agentId: "a", store, assets });
  assert.equal(render("a plain message\nwith line breaks"), "a plain message\nwith line breaks");
  const prompt = render("ponderosa://artifact/missing\nponderosa://artifact/missing");
  assert.equal(prompt.match(/"available":false/g).length, 1);
  assert.equal(resolutions, 0);
  assert.throws(() => render(Array.from({ length: 101 }, (_, i) => `ponderosa://artifact/a${i}`).join("\n")), /too many/);
});
