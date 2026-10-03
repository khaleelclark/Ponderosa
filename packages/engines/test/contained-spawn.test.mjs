import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { containedCliInvocation, spawnContainedCli } from "../dist/contained-spawn.js";
import { runtimeProcessHandle } from "../dist/process-termination.js";
import { runtimeEnvironment } from "../dist/runtime-environment.js";

const input = {
  bin: "/opt/provider/bin/codex",
  args: ["exec", "--model", "gpt-6-sol", "literal=${HOME}", "--", "-prompt"],
  cwd: "/tmp/project",
  env: {},
  stdin: "pipe",
};

const hostEnvironment = {
  PONDEROSA_AGENT_SCOPE_MODE: "systemd",
  PONDEROSA_AGENT_PARENT_UNIT: "ponderosa-dev.service",
};

test("Linux systemd mode moves the provider into the shared Agent slice without rewriting arguments", () => {
  assert.deepEqual(containedCliInvocation(input, "linux", hostEnvironment), {
    bin: "systemd-run",
    args: [
      "--user", "--scope", "--quiet", "--expand-environment=no",
      "--slice=ponderosa-agent-workloads.slice",
      "--property=TimeoutStopSec=2s",
      "--property=PartOf=ponderosa-dev.service", "--",
      input.bin, ...input.args,
    ],
  });
});

test("systemd mode refuses a missing or malformed parent unit", () => {
  assert.throws(() => containedCliInvocation({
    ...input,
  }, "linux", { PONDEROSA_AGENT_SCOPE_MODE: "systemd" }), /PONDEROSA_AGENT_PARENT_UNIT/u);
  assert.throws(() => containedCliInvocation(input, "linux", {
    ...hostEnvironment,
    PONDEROSA_AGENT_PARENT_UNIT: "other.service --property=MemoryMax=infinity",
  }), /PONDEROSA_AGENT_PARENT_UNIT/u);
});

test("non-systemd Linux and macOS retain the existing provider invocation", () => {
  assert.deepEqual(containedCliInvocation(input, "linux", {}), {
    bin: input.bin, args: input.args,
  });
  assert.deepEqual(containedCliInvocation(input, "darwin", hostEnvironment), {
    bin: input.bin, args: input.args,
  });
});

test("Windows keeps its Job Object launch path regardless of Linux scope configuration", () => {
  assert.deepEqual(containedCliInvocation(input, "win32", hostEnvironment), {
    bin: input.bin, args: input.args,
  });
});

test("server-only scope controls do not leak into provider tools", () => {
  const childEnvironment = runtimeEnvironment(hostEnvironment);
  assert.equal(childEnvironment.PONDEROSA_AGENT_SCOPE_MODE, undefined);
  assert.equal(childEnvironment.PONDEROSA_AGENT_PARENT_UNIT, undefined);
  assert.equal(containedCliInvocation({ ...input, env: childEnvironment }, "linux", hostEnvironment).bin,
    "systemd-run");
});

test("a Linux app-unit stop terminates its separate Agent scope", {
  skip: process.platform !== "linux" || process.env.PONDEROSA_TEST_SYSTEMD_SCOPE !== "1",
}, async () => {
  const parentUnit = `ponderosa-containment-${randomUUID()}.service`;
  execFileSync("systemd-run", ["--user", "--quiet", `--unit=${parentUnit}`, "/bin/sleep", "10"]);
  let handle;
  try {
    const { child } = spawnContainedCli({
      ...input,
      bin: "/bin/sleep",
      args: ["5"],
      cwd: process.cwd(),
      env: runtimeEnvironment(),
      stdin: "ignore",
    }, { ...hostEnvironment, PONDEROSA_AGENT_PARENT_UNIT: parentUnit });
    handle = runtimeProcessHandle(child, { label: "test Agent scope", termGraceMs: 200 });
    const closed = once(child, "close");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(child.exitCode, null, "provider should still be running before parent stop");
    execFileSync("systemctl", ["--user", "stop", parentUnit]);
    let timeout;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Agent scope survived app-unit stop")), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await handle.close();
    assert.equal(handle.isAlive(), false);
  } finally {
    await handle?.close();
    try { execFileSync("systemctl", ["--user", "stop", parentUnit], { stdio: "ignore" }); }
    catch { /* already stopped and unloaded */ }
  }
});
