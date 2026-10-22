import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  signMacosApplication,
  verifyMacosApplication,
} from "../../packaging/qualification/macos-code-signing.mjs";

test("finished macOS beta bundle gets a valid resource seal and rejects later changes", {
  skip: process.platform !== "darwin" && "requires macOS codesign and clang",
}, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-code-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Ponderosa Fixture.app");
  const contents = path.join(app, "Contents");
  const executable = path.join(contents, "MacOS", "fixture");
  const resource = path.join(contents, "Resources", "final-resource.txt");
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(path.dirname(resource), { recursive: true });
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>fixture</string>
    <key>CFBundleIdentifier</key><string>app.ponderosa.signing-fixture</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string>
  </dict></plist>`);
  const source = path.join(root, "fixture.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  execFileSync("xcrun", ["clang", source, "-o", executable]);
  writeFileSync(resource, "final packaged resources\n");
  assert.throws(() => verifyMacosApplication(app));

  signMacosApplication(app);
  assert.doesNotThrow(() => verifyMacosApplication(app));
  const signature = spawnSync("codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
  // An ad-hoc seal establishes integrity, never Apple Developer ID trust.
  assert.equal(signature.status, 0, signature.stderr);
  assert.match(signature.stderr, /Signature=adhoc/u);
  assert.doesNotMatch(signature.stderr, /Authority=Developer ID/u);
  writeFileSync(resource, "changed after signing\n");
  assert.throws(() => verifyMacosApplication(app));
});
