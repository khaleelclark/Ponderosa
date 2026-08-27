import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserResidueCleanupStatus,
  recoverBrowserResidue,
} from "../dist/browser-session-residue.js";

test("browser startup quarantines stale session state and drains all residue", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-browser-residue-"));
  const sessions = join(dataDir, "browser-sessions");
  const earlierRecovery = sessions + ".recovery-12345678-1234-4234-8234-123456789abc";

  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "stale-profile"), "stale", "utf8");
    mkdirSync(earlierRecovery, { recursive: true });
    writeFileSync(join(earlierRecovery, "older-profile"), "older", "utf8");

    await recoverBrowserResidue(dataDir);

    assert.deepEqual(readdirSync(sessions), []);
    assert.equal(existsSync(join(sessions, "stale-profile")), false);

    const deadline = Date.now() + 2_000;
    while (browserResidueCleanupStatus(dataDir).pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(browserResidueCleanupStatus(dataDir), { pending: 0, failed: 0 });
    assert.deepEqual(readdirSync(dataDir), ["browser-sessions"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
