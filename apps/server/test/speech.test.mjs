import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, access, readFile, writeFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { DEFAULT_SPEECH_PREFERENCES, segmentSpeechText, validSpeechPreferences } from "@ponderosa/core";
import { SpeechWorker } from "../dist/speech-worker.js";
import { SpeechService } from "../dist/speech-service.js";
import { SpeechAdmission } from "../dist/speech-admission.js";
import { validateSpeechManifest } from "../dist/speech-manifest.js";
import { registerSpeechRoutes } from "../dist/routes/speech.js";

const fixture = fileURLToPath(new URL("./fixtures/speech-worker.mjs", import.meta.url));
test("admission bounds queue, prioritizes interactive work, and cancels exact waiters", async () => {
  const admission = new SpeechAdmission(); const signal = new AbortController().signal; const order = [];
  let finish; const first = admission.run("interactive", signal, () => new Promise(resolve => { finish = resolve; }));
  const prefetch = admission.run("prefetch", signal, async () => { order.push("prefetch"); });
  const interactive = admission.run("interactive", signal, async () => { order.push("interactive"); });
  await assert.rejects(admission.run("interactive", signal, async () => {}));
  finish(); await Promise.all([first, prefetch, interactive]); assert.deepEqual(order, ["interactive", "prefetch"]);
  let end; const active = admission.run("interactive", signal, () => new Promise(resolve => { end = resolve; }));
  const controller = new AbortController(); const waiting = admission.run("prefetch", controller.signal, async () => assert.fail("cancelled waiter ran"));
  controller.abort(); await assert.rejects(waiting); end(); await active;
  admission.close(); await assert.rejects(admission.run("interactive", signal, async () => {}));
});
test("speech preferences reject paths, unknown keys, nonfinite/out-of-range speed", () => {
  assert.equal(validSpeechPreferences(DEFAULT_SPEECH_PREFERENCES), true);
  for (const patch of [{ speed: NaN }, { speed: 0.74 }, { speed: 1.26 }, { kokoroVoice: "../../model" }, { engine: "cloud" }, { url: "https://example.com" }]) assert.equal(validSpeechPreferences({ ...DEFAULT_SPEECH_PREFERENCES, ...patch }), false);
});
test("segmentation preserves Unicode and enforces both practical bounds", () => {
  const text = ("A sentence with punctuation, filenames and 🪵. ").repeat(80);
  const segments = segmentSpeechText(text);
  assert.ok(segments.length > 1);
  assert.equal(segments.join(" "), text.trim());
  for (const segment of segments) { assert.ok(Array.from(segment).length <= 200); assert.ok(Buffer.byteLength(segment) <= 800); }
  assert.deepEqual(segmentSpeechText(" \n "), []);
  assert.throws(() => segmentSpeechText("a".repeat(20001)));
  assert.equal(segmentSpeechText("🪵".repeat(801)).join(""), "🪵".repeat(801));
});
test("private worker handshake, PCM framing, reuse, and WAV metadata", async () => {
  const worker = new SpeechWorker(process.execPath, fixture, "voice_1");
  try {
    await worker.start();
    for (let i = 0; i < 2; i++) {
      const audio = await worker.synthesize("hello", 1, new AbortController().signal);
      assert.equal(audio.subarray(0, 4).toString(), "RIFF"); assert.equal(audio.readUInt32LE(24), 24000); assert.equal(audio.length, 48);
    }
  } finally { await worker.stop(); }
});
test("worker cancellation waits for exit and permits a clean restart", async () => {
  const worker = new SpeechWorker(process.execPath, fixture, "voice_1");
  await worker.start(); const controller = new AbortController();
  const pending = worker.synthesize("wait", 1, controller.signal);
  controller.abort(); await assert.rejects(pending); await worker.stop();
  await worker.start(); await worker.stop();
});
test("missing executable and incompatible handshake fail without hanging", { timeout: 4000 }, async () => {
  const missing = new SpeechWorker(path.join(tmpdir(), "no-ponderosa-speech-executable"), fixture, "voice_1");
  await assert.rejects(missing.start()); await missing.stop();
  const wrong = new SpeechWorker(process.execPath, fixture, "voice_3");
  await assert.rejects(wrong.start()); await wrong.stop();
});
const manifest = {
  version: "test-1", platform: "linux-x64", qualified: false, executable: "worker", modelRoot: "model",
  files: [{ path: "worker", url: "https://github.com/khaleelclark/Ponderosa/releases/download/test-1/worker", bytes: 1, sha256: "a".repeat(64), executable: true }],
};
test("manifest rejects traversal, path collisions, unpinned URLs, and Windows device names", () => {
  validateSpeechManifest(manifest);
  for (const name of ["../worker", "/worker", "model/CON", "model/aux.txt", "model/foo."]) assert.throws(() => validateSpeechManifest({ ...manifest, files: [{ ...manifest.files[0], path: name }] }));
  assert.throws(() => validateSpeechManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: "WORKER" }] }));
  assert.throws(() => validateSpeechManifest({ ...manifest, files: [{ ...manifest.files[0], url: "https://example.com/worker" }] }));
});
test("unpublished package performs no installation or storage creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-test-"));
  const service = new SpeechService(root, () => {}, () => {}, []);
  try {
    await service.initialize(); assert.equal(service.status().kokoro.state, "unsupported");
    assert.throws(() => service.install());
    await assert.rejects(access(path.join(root, "local-speech")));
  } finally { await service.close(); await rm(root, { recursive: true }); }
});
test("verified install, checksum-failed repair rollback, cache, removal, and symlink refusal", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-install-"));
  const executable = Buffer.concat([Buffer.from("#!/usr/bin/node\n"), await readFile(fixture)]);
  const model = Buffer.from("fixture model");
  const content = new Map([["worker", executable], ["model", model]]);
  const packageManifest = { ...manifest, platform: `${process.platform}-${process.arch}`, files: [...content].map(([name, data]) => ({ path: name, url: `https://github.com/khaleelclark/Ponderosa/releases/download/test-1/${name}`, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), executable: name === "worker" })) };
  let damaged = false; let installed = 0; const fetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(damaged ? Buffer.from("bad") : content.get(new URL(url).pathname.split("/").at(-1)));
  const service = new SpeechService(root, () => {}, () => { installed++; }, [packageManifest]);
  try {
    await service.initialize(); service.install(); await service.operation;
    assert.equal(service.status().kokoro.state, "ready"); assert.equal(installed, 1);
    const original = await readFile(path.join(root, "local-speech/current.json"), "utf8");
    const input = { text: "hello", voice: "voice_1", language: "en-US", speed: 1, segmentId: "test" };
    await service.synthesize(input, new AbortController().signal); assert.ok(service.status().cacheBytes > 0);
    service.clearCache(); assert.equal(service.status().cacheBytes, 0);
    damaged = true; await service.repair(); await service.operation;
    assert.equal(service.status().kokoro.state, "ready"); assert.equal(await readFile(path.join(root, "local-speech/current.json"), "utf8"), original);
    await service.remove(); assert.equal(service.status().kokoro.state, "not_installed");
    const protectedFile = path.join(root, "keep-me"); await writeFile(protectedFile, "untouched");
    await symlink(root, path.join(root, "local-speech"));
    await assert.rejects(service.remove()); assert.equal(await readFile(protectedFile, "utf8"), "untouched");
  } finally { globalThis.fetch = fetch; await service.close(); await rm(root, { recursive: true, force: true }); }
});
test("speech routes inherit host authorization and never synthesize from a GET", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ponderosa-speech-routes-"));
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => { if (request.headers.authorization !== "test") return reply.code(401).send(); });
  let preferences={speech:DEFAULT_SPEECH_PREFERENCES};
  registerSpeechRoutes(app, { dataDir: root, workspace: { getPreferences: () => preferences, cursor:()=>0, updatePreferences:patch=>{preferences={...preferences,...patch};} }, changed() {}, publishWorkspaceSince() {} });
  try {
    assert.equal((await app.inject("/api/speech/status")).statusCode, 401);
    const response = await app.inject({ url: "/api/speech/status", headers: { authorization: "test" } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().browserFallbackAvailable, true);
    assert.equal((await app.inject({ url: "/api/speech/synthesize", headers: { authorization: "test" } })).statusCode, 404);
    const claims=await Promise.all([1,2,3].map(()=>app.inject({method:"POST",url:"/api/speech/suggestion/claim",headers:{authorization:"test"}})));
    assert.equal(claims.filter(response=>response.json().show).length,1);
  } finally { await app.close(); await rm(root, { recursive: true }); }
});
