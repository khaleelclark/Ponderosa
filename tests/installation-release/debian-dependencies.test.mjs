import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { debianDependencies } from "../../packaging/qualification/debian-dependencies.mjs";

test("Debian dependencies come from the packaged ELF and include desktop browser opening", {
  skip: process.platform !== "linux" || spawnSync("dpkg-shlibdeps", ["--version"]).status !== 0
    ? "requires Linux dpkg-dev and a C compiler" : false,
}, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-debian-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.c");
  writeFileSync(source, "#include <stdio.h>\nint main(void) { puts(\"dependency fixture\"); return 0; }\n");
  execFileSync("cc", [source, "-o", path.join(root, "fixture")]);
  const dependencies = debianDependencies(root);
  assert.match(dependencies, /(?:^|, )libc6 \(>= [^)]+\)/u);
  assert.match(dependencies, /(?:^|, )xdg-utils(?:,|$)/u);
});
