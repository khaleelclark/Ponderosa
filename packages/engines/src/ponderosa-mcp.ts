import { createInterface } from "node:readline";
import {
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  PONDEROSA_BROWSER_TOOLS,
} from "@ponderosa/core";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const coordinateUrl = process.env.PONDEROSA_AGENT_COORDINATE_URL;
const updateRequestUrl = process.env.PONDEROSA_AGENT_UPDATE_REQUEST_URL;
const browserUrl = process.env.PONDEROSA_AGENT_BROWSER_URL;
const messageToken = process.env.PONDEROSA_AGENT_MESSAGE_TOKEN;

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(request: RpcRequest): Promise<void> {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ponderosa", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "coordinate",
            description: PONDEROSA_COORDINATE_TOOL.description,
            inputSchema: PONDEROSA_COORDINATE_TOOL.inputSchema,
          },
          {
            name: "update_request",
            description: PONDEROSA_UPDATE_REQUEST_TOOL.description,
            inputSchema: PONDEROSA_UPDATE_REQUEST_TOOL.inputSchema,
          },
          {
            name: "message",
            description: PONDEROSA_MESSAGE_TOOL.description,
            inputSchema: PONDEROSA_MESSAGE_TOOL.inputSchema,
          },
          ...PONDEROSA_BROWSER_TOOLS.map((tool) => ({
            name: tool.name.replace(/^ponderosa_/, ""),
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    const browserOperation = typeof params?.name === "string" && params.name.startsWith("browser_")
      ? params.name.slice("browser_".length)
      : undefined;
    const targetUrl = params?.name === "coordinate"
      ? coordinateUrl
      : params?.name === "update_request"
        ? updateRequestUrl
        : params?.name === "message"
          ? messageUrl
          : browserOperation
            ? browserUrl
          : undefined;
    if (!targetUrl || !messageToken) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "The requested Ponderosa capability is unavailable." }] } });
      return;
    }
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json" },
        body: JSON.stringify(browserOperation
          ? { ...(params?.arguments && typeof params.arguments === "object" ? params.arguments : {}), operation: browserOperation }
          : params?.arguments ?? {}),
      });
      const text = await response.text();
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: !response.ok, content: [{ type: "text", text }] },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
      });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method ?? ""}` } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const request = JSON.parse(line) as RpcRequest;
    void handle(request);
  } catch {
    // MCP transports ignore malformed client input and keep serving later calls.
  }
});
