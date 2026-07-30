import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMacosBundleIdentity,
  expectedMacosBundleIdentity,
  macosInfoPlist,
  numericAppleBuildVersion,
  numericAppleVersion,
} from "./macos-bundle-metadata.mjs";

test("macOS metadata exposes an exact identifiable beta candidate", () => {
  const manifest = {
    version: "0.0.0-beta.mac9",
    commit: "a&<>'\"bc-rest",
  };
  const plist = macosInfoPlist(manifest);

  assert.equal(numericAppleVersion("0.0.0-beta.mac9"), "0.0.0");
  assert.equal(numericAppleBuildVersion("0.0.0-beta.mac9"), "0.0.9");
  assert.match(plist, /<key>CFBundleVersion<\/key><string>0\.0\.9<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.0\.0<\/string>/u);
  assert.match(
    plist,
    /Ponderosa Beta 0\.0\.0-beta\.mac9 \(a&amp;&lt;&gt;&apos;&quot;bc\)/u,
  );
  assert.match(plist, /<key>PonderosaBuildVersion<\/key><string>0\.0\.0-beta\.mac9<\/string>/u);
  assert.match(
    plist,
    /<key>PonderosaBuildCommit<\/key><string>a&amp;&lt;&gt;&apos;&quot;bc-rest<\/string>/u,
  );
});

test("non-mac candidate versions retain their semantic Apple build version", () => {
  assert.equal(numericAppleBuildVersion("3.5.0-beta.1"), "3.5.0");
  assert.equal(numericAppleBuildVersion("003.05.000-beta.mac0009"), "3.5.9");
});

test("unsupported and unbounded versions fail closed", () => {
  assert.throws(
    () => numericAppleVersion("3-beta.mac9"),
    /Unsupported build version/u,
  );
  assert.throws(
    () => numericAppleBuildVersion("0.0.0-beta.mac9999999999999999999"),
    /1-18 decimal digits/u,
  );
  assert.throws(
    () => numericAppleBuildVersion("0.0.0-beta.mac9.mac10"),
    /multiple macOS candidate identifiers/u,
  );
});

test("installed identity comparison rejects every tampered field exactly", () => {
  const manifest = {
    version: "0.0.0-beta.mac9",
    commit: "0123456789abcdef",
  };
  const expected = expectedMacosBundleIdentity(manifest);
  assert.doesNotThrow(() => assertMacosBundleIdentity(manifest, expected));

  for (const [key, value] of [
    ["bundleVersion", "999.999.9"],
    ["shortVersion", "0.0.1"],
    ["exactVersion", `${manifest.version}-extra`],
    ["exactCommit", `${manifest.commit}0`],
    ["infoString", `${expected.infoString} extra`],
  ]) {
    assert.throws(
      () => assertMacosBundleIdentity(manifest, { ...expected, [key]: value }),
      new RegExp(`unexpected ${key}`, "u"),
    );
  }
});
