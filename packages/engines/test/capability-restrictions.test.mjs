import assert from "node:assert/strict";
import test from "node:test";
import { claudeCapabilityRestrictionArgs } from "../dist/claude-stream-session.js";
import { codexCapabilityRuntimeOptions } from "../dist/codex-app-server.js";

const restrictions = {
  restrictedCapabilityIds: ["provider.filesystem_write", "connector:codex:job-tracker"],
  restrictedConnectorNames: ["job-tracker"],
  filesystemWriteRestricted: true,
};

test("Codex restrictions narrow the sandbox and disable the connector in both provider namespaces", () => {
  assert.deepEqual(codexCapabilityRuntimeOptions("workspace-write", restrictions), {
    sandboxMode: "read-only",
    config: {
      apps: { "job-tracker": { enabled: false } },
      mcp_servers: { "job-tracker": { enabled: false } },
    },
  });
  assert.deepEqual(codexCapabilityRuntimeOptions("workspace-write", undefined), {
    sandboxMode: "workspace-write",
  });
});

test("Claude restrictions become explicit provider-native tool denies", () => {
  assert.deepEqual(claudeCapabilityRestrictionArgs(restrictions), [
    "--disallowedTools",
    "Bash,Edit,NotebookEdit,Write,mcp__job-tracker",
  ]);
  assert.deepEqual(claudeCapabilityRestrictionArgs(undefined), []);
});
