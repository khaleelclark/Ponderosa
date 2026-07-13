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
    let receivedAuthorization = "";
    let receivedBody = "";
    const http = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { receivedBody += chunk; });
      request.on("end", () => {
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

    await expect.poll(() => responses.length).toBe(3);
    expect(responses[1]).toMatchObject({ result: { tools: [{ name: "send_message" }] } });
    expect(responses[2]).toMatchObject({ result: { isError: false } });
    expect(receivedAuthorization).toBe("Bearer secret-run-token");
    expect(JSON.parse(receivedBody)).toEqual({ intent: "broadcast", text: "Managed result" });
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
