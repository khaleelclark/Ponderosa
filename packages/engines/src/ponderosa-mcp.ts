import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decodeSessionTools } from "./ponderosa-mcp-contract.js";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const coordinateUrl = process.env.PONDEROSA_AGENT_COORDINATE_URL;
const updateRequestUrl = process.env.PONDEROSA_AGENT_UPDATE_REQUEST_URL;
const browserUrl = process.env.PONDEROSA_AGENT_BROWSER_URL;
const importFileUrl = process.env.PONDEROSA_AGENT_IMPORT_FILE_URL;
const spawnUrl = process.env.PONDEROSA_AGENT_SPAWN_URL;
const decisionUrl = process.env.PONDEROSA_AGENT_DECISION_URL;
const manageUrl = process.env.PONDEROSA_AGENT_MANAGE_URL;
const directoryUrl = process.env.PONDEROSA_AGENT_DIRECTORY_URL;
const messageToken = process.env.PONDEROSA_AGENT_MESSAGE_TOKEN;
const configuredToolNames = (() => {
  const raw = process.env.PONDEROSA_AGENT_TOOL_NAMES;
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((name) => typeof name === "string")
      ? new Set(parsed.map((name) => name.replace(/^ponderosa_/, "")))
      : new Set<string>();
  } catch {
    return new Set<string>();
  }
})();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const sessionMcpTools = decodeSessionTools(process.env.PONDEROSA_AGENT_TOOL_DEFINITIONS).map(tool => ({
  name: tool.name.replace(/^ponderosa_/, ""), description: tool.description, inputSchema: tool.inputSchema,
}));

export const enabledPonderosaMcpTools = (
  enabledNames: ReadonlySet<string> | undefined = configuredToolNames,
) => enabledNames === undefined
  ? sessionMcpTools
  : sessionMcpTools.filter((tool) => enabledNames.has(tool.name));

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
        tools: enabledPonderosaMcpTools(),
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (typeof params?.name !== "string" ||
        !enabledPonderosaMcpTools().some((tool) => tool.name === params.name)) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "The requested Ponderosa capability is unavailable for this Run." }] } });
      return;
    }
    const browserOperation = typeof params?.name === "string" && params.name.startsWith("browser_")
      ? params.name.slice("browser_".length)
      : undefined;
    const isDirectory = params?.name === "team_directory";
    const args = params?.arguments && typeof params.arguments === "object"
      ? params.arguments as { agentId?: unknown }
      : {};
    const targetUrl = params?.name === "create_managed_agent"
      ? spawnUrl
      : params?.name === "coordinate"
        ? coordinateUrl
        : params?.name === "update_request"
          ? updateRequestUrl
          : params?.name === "message"
            ? messageUrl
            : params?.name === "import_file"
              ? importFileUrl
              : params?.name === "decision"
                ? decisionUrl
                : params?.name === "manage"
                  ? manageUrl
                  : isDirectory
                    ? directoryUrl && `${directoryUrl}${typeof args.agentId === "string" && args.agentId.trim() ? `/${encodeURIComponent(args.agentId.trim())}` : ""}`
                    : browserOperation
                      ? browserUrl
                      : undefined;
    if (!targetUrl || !messageToken) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "The requested Ponderosa capability is unavailable." }] } });
      return;
    }
    try {
      const response = await fetch(targetUrl, {
        method: isDirectory ? "GET" : "POST",
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json" },
        ...(!isDirectory ? { body: JSON.stringify(browserOperation
          ? { ...(params?.arguments && typeof params.arguments === "object" ? params.arguments : {}), operation: browserOperation }
          : params?.name === "import_file"
            ? { ...(params?.arguments && typeof params.arguments === "object" ? params.arguments : {}), toolCallId: String(request.id) }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    try {
      const request = JSON.parse(line) as RpcRequest;
      void handle(request);
    } catch {
      // MCP transports ignore malformed client input and keep serving later calls.
    }
  });
}
