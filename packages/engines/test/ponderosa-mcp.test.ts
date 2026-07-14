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
        response.writeHead(request.url === "/api/agent-spawns" ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url === "/api/agent-spawns"
          ? { accepted: true, agent: { id: "child-1" } }
          : { messageId: "message-1" }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");

    const child = spawn(process.execPath, [join(here, "../dist/ponderosa-mcp.js")], {
      env: {
        ...process.env,
        PONDEROSA_AGENT_MESSAGE_URL: `http://127.0.0.1:${address.port}/api/agent-messages`,
        PONDEROSA_AGENT_SPAWN_URL: `http://127.0.0.1:${address.port}/api/agent-spawns`,
        PONDEROSA_AGENT_WAIT_URL: `http://127.0.0.1:${address.port}/api/agent-waits`,
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
      params: { name: "send_message", arguments: { intent: "broadcast", text: "Managed result" } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "spawn_agent", arguments: { displayName: "Research", initialMessage: "Investigate.", idempotencyKey: "research-1" } },
    })}\n`);
    child.stdin!.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "wait_for_reports", arguments: { mode: "all", expectedAgentIds: ["child-1"] } },
    })}\n`);

    await expect.poll(() => responses.length).toBe(5);
    expect(responses[1]).toMatchObject({ result: { tools: [{ name: "send_message" }, { name: "spawn_agent" }, { name: "wait_for_reports" }] } });
    expect(responses[2]).toMatchObject({ result: { isError: false } });
    expect(responses[3]).toMatchObject({ result: { isError: false } });
    expect(responses[4]).toMatchObject({ result: { isError: false } });
    expect(received).toEqual([
      {
        authorization: "Bearer secret-run-token",
        url: "/api/agent-messages",
        body: { intent: "broadcast", text: "Managed result" },
      },
      {
        authorization: "Bearer secret-run-token",
        url: "/api/agent-spawns",
        body: { displayName: "Research", initialMessage: "Investigate.", idempotencyKey: "research-1" },
      },
      {
        authorization: "Bearer secret-run-token",
        url: "/api/agent-waits",
        body: { mode: "all", expectedAgentIds: ["child-1"] },
      },
    ]);
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
