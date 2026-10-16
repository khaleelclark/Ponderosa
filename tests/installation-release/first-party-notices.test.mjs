import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyFirstPartyNotices } from "../../packaging/qualification/first-party-notices.mjs";

test("first-party release notices preserve approved bytes and fail on omissions or edits", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-first-party-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const restore = () => {
    for (const name of ["LICENSE", "CREDITS.md"]) {
      copyFileSync(new URL(`../../${name}`, import.meta.url), path.join(root, name));
    }
  };
  restore();
  assert.doesNotThrow(() => verifyFirstPartyNotices(root));
  for (const name of ["LICENSE", "CREDITS.md"]) {
    rmSync(path.join(root, name));
    assert.throws(() => verifyFirstPartyNotices(root), { code: "ENOENT" });
    restore();
    writeFileSync(path.join(root, name), "");
    assert.throws(() => verifyFirstPartyNotices(root), /differs from the approved release wording/u);
    restore();
    writeFileSync(path.join(root, name), "Unapproved replacement wording\n");
    assert.throws(() => verifyFirstPartyNotices(root), /differs from the approved release wording/u);
    restore();
  }
});
