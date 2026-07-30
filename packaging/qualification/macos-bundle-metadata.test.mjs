import assert from "node:assert/strict";
import test from "node:test";
import {
  macosInfoPlist,
  numericAppleBuildVersion,
  numericAppleVersion,
} from "../macos-bundle-metadata.mjs";

test("macOS metadata exposes an exact identifiable beta candidate", () => {
  const plist = macosInfoPlist({
    version: "0.0.0-beta.mac9",
    commit: "01234567abc&def",
  });

  assert.equal(numericAppleVersion("0.0.0-beta.mac9"), "0.0.0");
  assert.equal(numericAppleBuildVersion("0.0.0-beta.mac9"), "0.0.9");
  assert.match(plist, /<key>CFBundleVersion<\/key><string>0\.0\.9<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.0\.0<\/string>/u);
  assert.match(plist, /Ponderosa Beta 0\.0\.0-beta\.mac9 \(01234567\)/u);
  assert.match(plist, /<key>PonderosaBuildVersion<\/key><string>0\.0\.0-beta\.mac9<\/string>/u);
  assert.match(plist, /<key>PonderosaBuildCommit<\/key><string>01234567abc&amp;def<\/string>/u);
});

test("non-mac candidate versions retain their semantic Apple build version", () => {
  assert.equal(numericAppleBuildVersion("3.5.0-beta.1"), "3.5.0");
});
