import assert from "node:assert/strict";
import test from "node:test";
import {
  macosDeploymentTargetAtMost,
  macosDeploymentTargets,
} from "./macos-deployment-target.mjs";

test("extracts deployment targets without treating unrelated versions as minimums", () => {
  const output = `
Load command 0
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.5
      sdk 26.0
   ntools 1
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libc++.1.dylib
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 1900.178.0
compatibility version 1.0.0
Load command 2
      cmd LC_SOURCE_VERSION
  cmdsize 16
  version 1200.11
`;

  assert.deepEqual(macosDeploymentTargets(output), ["13.5"]);
});

test("supports legacy minimum-version load commands and multiple slices", () => {
  const output = `
Load command 0
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
Load command 0
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 14.0.0
      sdk 15.4
   ntools 1
`;

  assert.deepEqual(macosDeploymentTargets(output), ["10.15", "14.0.0"]);
});

test("compares dotted macOS deployment targets semantically", () => {
  assert.equal(macosDeploymentTargetAtMost("13.5", "14.0"), true);
  assert.equal(macosDeploymentTargetAtMost("14.0.0", "14.0"), true);
  assert.equal(macosDeploymentTargetAtMost("14.1", "14.0"), false);
  assert.equal(macosDeploymentTargetAtMost("15.0", "14.0"), false);
});
