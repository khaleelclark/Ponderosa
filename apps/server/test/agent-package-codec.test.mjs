import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodePortableArtifact, decodePortableArtifact } from "../dist/agent-package-codec.js";

test("portable artifact codec preserves bytes and digest", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("small"), Buffer.from([0, 1, 254, 255])]) {
    const encoded = await encodePortableArtifact(bytes);
    const decoded = await decodePortableArtifact(encoded);
    assert.deepEqual(decoded.data, bytes);
    assert.equal(decoded.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("portable artifact decoder rejects malformed base64", async () => {
  for (const encoded of ["a!", "a", "YQ==junk", " YQ=="]) {
    await assert.rejects(decodePortableArtifact(encoded), /invalid base64/u);
  }
});
