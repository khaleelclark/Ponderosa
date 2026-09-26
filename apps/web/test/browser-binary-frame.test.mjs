import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserBinaryFrameParser } from "../src/browserInteraction.js";

function packet(body, metadata = { pageId: "page", viewport: { width: 400, height: 300 } }) {
  const info = new TextEncoder().encode(JSON.stringify({ mediaType: "image/jpeg", sequence: 1, metadata }));
  const bytes = new Uint8Array(8 + info.length + body.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, info.length);
  header.setUint32(4, body.length);
  bytes.set(info, 8);
  bytes.set(body, 8 + info.length);
  return bytes;
}

test("binary browser frames survive chunk boundaries and heartbeat packets", async () => {
  const parser = createBrowserBinaryFrameParser();
  const bytes = packet(new Uint8Array([255, 216, 255, 1]));
  assert.deepEqual(parser.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(parser.push(bytes.subarray(3, 12)), []);
  const frames = parser.push(bytes.subarray(12));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].metadata.pageId, "page");
  assert.deepEqual(new Uint8Array(await frames[0].blob.arrayBuffer()), new Uint8Array([255, 216, 255, 1]));
  assert.deepEqual(parser.push(new Uint8Array(8)), []);
  assert.equal(parser.push(bytes).length, 1);
});

test("binary browser frames reject invalid lengths and metadata", () => {
  const oversized = new Uint8Array(8);
  new DataView(oversized.buffer).setUint32(4, 1_500_001);
  assert.throws(() => createBrowserBinaryFrameParser().push(oversized), /invalid/);
  assert.throws(() => createBrowserBinaryFrameParser().push(packet(new Uint8Array([1]), { pageId: "page", viewport: { width: 0, height: 300 } })), /invalid/);
});
