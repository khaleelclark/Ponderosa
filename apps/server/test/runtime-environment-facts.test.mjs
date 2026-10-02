import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeEnvironmentFacts, environmentFactsPrompt } from "../dist/runtime-environment-facts.js";

test("environment observations are bounded and reviewer output reuses only an existing external authorized root", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "environment-facts-"));
  const root = await realpath(temporary), checkout = path.join(root, "writer"), outputs = path.join(root, "outputs"), bin = path.join(root, "bin");
  try {
    await Promise.all([checkout, outputs, bin].map(directory => mkdir(directory)));
    await writeFile(path.join(bin, "python3"), "synthetic fixture"); await chmod(path.join(bin, "python3"), 0o700);
    const input = { cwd: checkout, agentId: "reviewer", allowedImportRoots: [checkout, outputs], env: { PATH: bin } };
    const first = await runtimeEnvironmentFacts(input);
    assert.equal(first.cwd, checkout); assert.equal(first.platform, process.platform);
    assert.equal(first.executables.length, 5);
    assert.equal(first.executables.find(item => item.name === "python").availability, "not_found");
    assert.equal(first.executables.find(item => item.name === "python3").availability, "available");
    assert.equal(first.reportOutputRoot, path.join(outputs, "ponderosa-review", "reviewer"));
    const absent = await runtimeEnvironmentFacts({ ...input, allowedImportRoots: [] });
    assert.equal(absent.reportOutputRoot, undefined);
    assert.match(environmentFactsPrompt(absent).join("\n"), /No external report-output root is authorized/);
    await writeFile(path.join(bin, "python"), "synthetic fixture"); await chmod(path.join(bin, "python"), 0o700);
    assert.equal((await runtimeEnvironmentFacts(input)).executables.find(item => item.name === "python").availability, "available");
    await symlink(checkout, path.join(outputs, "ponderosa-review"));
    assert.equal((await runtimeEnvironmentFacts(input)).reportOutputRoot, undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
