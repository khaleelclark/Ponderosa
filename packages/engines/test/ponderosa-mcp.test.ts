import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
});

describe("Ponderosa stdio MCP bridge", () => {
  it("keeps the capability out of argv and forwards an explicit message call", async () => {
    const received: Array<{ authorization: string; url: string; body: unknown }> = [];
    const http = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push({
          authorization: request.headers.authorization ?? "",
          url: request.url ?? "",
          body: JSON.parse(body),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messageId: "message-1" }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");

    const child = spawn(process.execPath, [join(here, "../dist/ponderosa-mcp.js")], {
      env: {
        ...process.env,
        PONDEROSA_AGENT_MESSAGE_URL: `http://127.0.0.1:${address.port}/api/agent-messages`,
        PONDEROSA_AGENT_COORDINATE_URL: `http://127.0.0.1:${address.port}/api/agent-coordinate`,
        PONDEROSA_AGENT_UPDATE_REQUEST_URL: `http://127.0.0.1:${address.port}/api/agent-request-updates`,
        PONDEROSA_AGENT_MESSAGE_TOKEN: "secret-run-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    expect(child.spawnargs.join(" ")).not.toContain("secret-run-token");
    const lines = createInterface({ input: child.stdout! });
    const responses: unknown[] = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));

    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "message", arguments: { intent: "broadcast", text: "Managed result", idempotencyKey: "result-1" } },
    })}\n`);

    await expect.poll(() => responses.length, { timeout: 5_000 }).toBe(3);
    expect(responses[1]).toMatchObject({ result: { tools: [
      { name: "create_managed_agent" }, { name: "decision" }, { name: "manage" },
      { name: "coordinate" }, { name: "result" }, { name: "update_request" }, { name: "message" },
      { name: "team_directory" }, { name: "context" }, { name: "docs" },
      { name: "browser_open" }, { name: "browser_navigate" }, { name: "browser_inspect" },
      { name: "browser_act" }, { name: "browser_screenshot" }, { name: "browser_take_control" }, { name: "browser_close" },
    ] } });
    expect(responses[2]).toMatchObject({ result: { isError: false } });
    expect(received).toEqual([
      {
        authorization: "Bearer secret-run-token",
        url: "/api/agent-messages",
        body: { intent: "broadcast", text: "Managed result", idempotencyKey: "result-1" },
      },
    ]);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("separates visible managed-Agent creation from communication, retrieval, and scoped browser tools", async () => {
    const received: string[] = [];
    const http = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        received.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ requestIds: ["request-1"], joinId: "join-1" }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, [join(here, "../dist/ponderosa-mcp.js")], {
      env: {
        ...process.env,
        PONDEROSA_AGENT_MESSAGE_URL: `${origin}/api/agent-messages`,
        PONDEROSA_AGENT_COORDINATE_URL: `${origin}/api/agent-coordinate`,
        PONDEROSA_AGENT_RESULT_URL: `${origin}/api/agent-results`,
        PONDEROSA_AGENT_UPDATE_REQUEST_URL: `${origin}/api/agent-request-updates`,
        PONDEROSA_AGENT_BROWSER_URL: `${origin}/api/agent-browser`,
        PONDEROSA_AGENT_SPAWN_URL: `${origin}/api/agent-spawn`,
        PONDEROSA_AGENT_DIRECTORY_URL: `${origin}/api/agent-directory`,
        PONDEROSA_AGENT_CONTEXT_URL: `${origin}/api/agent-context`,
        PONDEROSA_AGENT_MESSAGE_TOKEN: "secret-run-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const responses: unknown[] = [];
    createInterface({ input: child.stdout! }).on("line", (line) => responses.push(JSON.parse(line)));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "coordinate", arguments: {
        idempotencyKey: "one", requests: [{ recipientAgentId: "agent", text: "Review", lifetime: { kind: "indefinite" } }],
      } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "browser_open", arguments: { url: "https://example.com" } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "team_directory", arguments: { agentId: "agent/a" } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "context", arguments: { cursor: "opaque-cursor", limit: 12 } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "result", arguments: { refs: ["ponderosa://artifact/text-1"], maxBytes: 4096 } },
    })}\n`);
    await expect.poll(() => responses.length, { timeout: 5_000 }).toBe(6);
    expect(responses[0]).toMatchObject({ result: { tools: [
      { name: "create_managed_agent" }, { name: "decision" }, { name: "manage" },
      { name: "coordinate" }, { name: "result" }, { name: "update_request" }, { name: "message" },
      { name: "team_directory" }, { name: "context" }, { name: "docs" },
      { name: "browser_open" }, { name: "browser_navigate" }, { name: "browser_inspect" },
      { name: "browser_act" }, { name: "browser_screenshot" }, { name: "browser_take_control" }, { name: "browser_close" },
    ] } });
    const coordinateDescription = (responses[0] as {
      result: { tools: Array<{ name: string; description: string }> };
    }).result.tools.find((tool) => tool.name === "coordinate")?.description;
    expect(coordinateDescription).toContain('completionMode:"join" with wakePolicy:"final_only"');
    expect(coordinateDescription).toContain("advanced requests/join form only for quorum/any conditions");
    expect(coordinateDescription).not.toContain("advanced requests/join form for final-only");
    expect(received.sort()).toEqual([
      "/api/agent-coordinate",
      "/api/agent-results",
      "/api/agent-browser",
      "/api/agent-directory/agent%2Fa",
      "/api/agent-context?cursor=opaque-cursor&limit=12",
    ].sort());
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
