import { createInterface } from "node:readline";
import {
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_CONTEXT_TOOL,
  PONDEROSA_TEAM_DIRECTORY_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  PONDEROSA_BROWSER_TOOLS,
  PONDEROSA_CREATE_MANAGED_AGENT_TOOL,
  PONDEROSA_DECISION_TOOL,
  PONDEROSA_MANAGE_TOOL,
} from "@ponderosa/core";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const coordinateUrl = process.env.PONDEROSA_AGENT_COORDINATE_URL;
const updateRequestUrl = process.env.PONDEROSA_AGENT_UPDATE_REQUEST_URL;
const browserUrl = process.env.PONDEROSA_AGENT_BROWSER_URL;
const spawnUrl = process.env.PONDEROSA_AGENT_SPAWN_URL;
const decisionUrl = process.env.PONDEROSA_AGENT_DECISION_URL;
const manageUrl = process.env.PONDEROSA_AGENT_MANAGE_URL;
const directoryUrl = process.env.PONDEROSA_AGENT_DIRECTORY_URL;
const contextUrl = process.env.PONDEROSA_AGENT_CONTEXT_URL;
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
            name: "create_managed_agent",
            description: PONDEROSA_CREATE_MANAGED_AGENT_TOOL.description,
            inputSchema: PONDEROSA_CREATE_MANAGED_AGENT_TOOL.inputSchema,
          },
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
          {
            name: "decision",
            description: PONDEROSA_DECISION_TOOL.description,
            inputSchema: PONDEROSA_DECISION_TOOL.inputSchema,
          },
          {
            name: "manage",
            description: PONDEROSA_MANAGE_TOOL.description,
            inputSchema: PONDEROSA_MANAGE_TOOL.inputSchema,
          },
          {
            name: "team_directory",
            description: PONDEROSA_TEAM_DIRECTORY_TOOL.description,
            inputSchema: PONDEROSA_TEAM_DIRECTORY_TOOL.inputSchema,
          },
          {
            name: "context",
            description: PONDEROSA_CONTEXT_TOOL.description,
            inputSchema: PONDEROSA_CONTEXT_TOOL.inputSchema,
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
    const isDirectory = params?.name === "team_directory";
    const isContext = params?.name === "context";
    const args = params?.arguments && typeof params.arguments === "object"
      ? params.arguments as { agentId?: unknown; before?: unknown; limit?: unknown }
      : {};
    const contextQuery = new URLSearchParams();
    if (typeof args.before === "string" && args.before.trim()) contextQuery.set("before", args.before.trim());
    if (typeof args.limit === "number") contextQuery.set("limit", String(args.limit));
    const targetUrl = params?.name === "create_managed_agent"
      ? spawnUrl
      : params?.name === "coordinate"
      ? coordinateUrl
      : params?.name === "update_request"
        ? updateRequestUrl
        : params?.name === "message"
          ? messageUrl
          : params?.name === "decision"
            ? decisionUrl
            : params?.name === "manage"
              ? manageUrl
            : isDirectory
              ? directoryUrl && `${directoryUrl}${typeof args.agentId === "string" && args.agentId.trim() ? `/${encodeURIComponent(args.agentId.trim())}` : ""}`
            : isContext
              ? contextUrl && `${contextUrl}${contextQuery.size ? `?${contextQuery.toString()}` : ""}`
          : browserOperation
            ? browserUrl
          : undefined;
    if (!targetUrl || !messageToken) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "The requested Ponderosa capability is unavailable." }] } });
      return;
    }
    try {
      const response = await fetch(targetUrl, {
        method: isDirectory || isContext ? "GET" : "POST",
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json" },
        ...(!(isDirectory || isContext) ? { body: JSON.stringify(browserOperation
          ? { ...(params?.arguments && typeof params.arguments === "object" ? params.arguments : {}), operation: browserOperation }
          : params?.arguments ?? {}) } : {}),
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
