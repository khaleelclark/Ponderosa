import assert from "node:assert/strict";
import test from "node:test";
import {
  PONDEROSA_IMPORT_FILE_TOOL,
  PONDEROSA_TEAM_DIRECTORY_TOOL,
} from "@ponderosa/core";
import Fastify from "fastify";
import { createProviderDynamicToolHandler } from "../dist/routes/provider-dynamic-tool-handler.js";

test("provider tools retain their Run capability and special route payloads", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get("/api/agent-directory/:agentId", async (request) => ({
    agentId: request.params.agentId,
    authorization: request.headers.authorization,
  }));
  app.post("/api/agent-import-file", async (request) => request.body);
  app.post("/api/agent-browser", async (request) => request.body);

  const browserTool = { name: "ponderosa_browser_navigate", description: "", inputSchema: {} };
  const handler = createProviderDynamicToolHandler(
    app,
    [PONDEROSA_TEAM_DIRECTORY_TOOL, PONDEROSA_IMPORT_FILE_TOOL, browserTool],
    "run-capability",
  );

  assert.deepEqual(JSON.parse((await handler({
    id: "directory-call",
    name: PONDEROSA_TEAM_DIRECTORY_TOOL.name,
    arguments: { agentId: "agent / one" },
  })).text), {
    agentId: "agent / one",
    authorization: "Bearer run-capability",
  });
  assert.deepEqual(JSON.parse((await handler({
    id: "import-call",
    name: PONDEROSA_IMPORT_FILE_TOOL.name,
    arguments: { path: "/tmp/result.txt" },
  })).text), {
    path: "/tmp/result.txt",
    toolCallId: "import-call",
  });
  assert.deepEqual(JSON.parse((await handler({
    id: "browser-call",
    name: browserTool.name,
    arguments: { url: "https://example.com" },
  })).text), {
    operation: "navigate",
    url: "https://example.com",
  });
  assert.deepEqual(await handler({ id: "denied", name: "ponderosa_message", arguments: {} }), {
    success: false,
    text: "Unavailable Ponderosa tool for this Run: ponderosa_message",
  });
});
