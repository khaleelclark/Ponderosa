import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { selectComposerFiles } from "../src/components/chat/composerUtils.js";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";

const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
test("DOCX selection accepts browser MIME variants and preserves the upload limits", () => {
  for (const type of [mime, "application/zip", "", "application/octet-stream"]) {
    const file = { name: "Report.DOCX", type, size: 100 };
    for (const limits of [undefined, DEFAULT_ASSET_LIMITS]) {
      assert.deepEqual(selectComposerFiles([], [file], limits), { accepted: [file], error: undefined });
    }
  }
  const full = { name: "report.docx", type: mime, size: DEFAULT_ASSET_LIMITS.maxFileBytes };
  assert.deepEqual(selectComposerFiles([], [full], DEFAULT_ASSET_LIMITS).accepted, [full]);
  assert.equal(selectComposerFiles([], [{ ...full, size: full.size + 1 }], DEFAULT_ASSET_LIMITS).accepted.length, 0);
  assert.equal(selectComposerFiles([full], [{ ...full, size: 1 }], DEFAULT_ASSET_LIMITS).accepted.length, 0);
  assert.equal(selectComposerFiles([], [{ ...full, type: "application/x-executable" }], DEFAULT_ASSET_LIMITS).accepted.length, 0);
});

test("the composer file picker permits Word documents", () => {
  const controls = readFileSync("src/components/chat/Composer.controls.tsx", "utf8");
  assert.match(controls, /accept="[^"\n]*application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document[^"\n]*\.docx/u);
});
