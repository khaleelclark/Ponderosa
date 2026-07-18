import { createInterface } from "node:readline";
import {
  PONDEROSA_RUNTIME_TOOLS,
} from "@ponderosa/core";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const coordinateUrl = process.env.PONDEROSA_AGENT_COORDINATE_URL;
const resultUrl = process.env.PONDEROSA_AGENT_RESULT_URL;
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
        tools: PONDEROSA_RUNTIME_TOOLS.map((tool) => ({
          name: tool.name.replace(/^ponderosa_/, ""),
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
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
    const isResult = params?.name === "result";
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
        : isResult
          ? resultUrl
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
