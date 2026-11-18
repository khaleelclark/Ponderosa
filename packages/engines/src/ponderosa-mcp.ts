import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decodeSessionTools } from "./ponderosa-mcp-contract.js";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const historyUrl = process.env.PONDEROSA_AGENT_HISTORY_URL;
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

// Some MCP clients can encode scalar JSON values as strings. Normalize only canonical, bounded representations; host-side
// schema, capability, scope and ownership checks remain authoritative.
function normalizeMemoryMcpArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Local Memory arguments.");
  const args = { ...value } as Record<string, unknown>;
  if (Object.hasOwn(args, "top_k")) {
    const top = args.top_k;
    if (typeof top === "string" && /^(?:[1-9]|1[0-9]|20)$/.test(top)) args.top_k = Number(top);
    if (typeof args.top_k !== "number" || !Number.isSafeInteger(args.top_k) || args.top_k < 1 || args.top_k > 20)
      throw new Error("Invalid Local Memory result bound.");
  }
  if (Object.hasOwn(args, "include_history")) {
    if (args.include_history === "true") args.include_history = true;
    else if (args.include_history === "false") args.include_history = false;
    if (typeof args.include_history !== "boolean") throw new Error("Invalid Local Memory history flag.");
  }
  return args;
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
    const localMemoryOperation=typeof params?.name==="string"&&params.name.startsWith("local_memory_")?params.name.slice("local_memory_".length):undefined;
    let memoryArguments: Record<string, unknown> | undefined;
    if (localMemoryOperation) {
      try { memoryArguments = normalizeMemoryMcpArguments(params?.arguments); }
      catch (error) {
        send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid Local Memory arguments." }] } });
        return;
      }
    }
    const browserOperation = typeof params?.name === "string" && params.name.startsWith("browser_")
      ? params.name.slice("browser_".length)
      : undefined;
    const isDirectory = params?.name === "team_directory";
    const args = params?.arguments && typeof params.arguments === "object"
      ? params.arguments as { agentId?: unknown }
      : {};
    const workspaceOperation=params.name.startsWith('workspace_')?params.name.slice('workspace_'.length):params.name==='assistant_check'?'check':undefined;
    const targetUrl = workspaceOperation ? messageUrl?.replace(/\/api\/agent-messages$/, '/api/agent-workspace') : localMemoryOperation ? messageUrl?.replace(/\/api\/agent-messages$/, "/api/agent-local-memory") : params?.name === "reply_stream" ? messageUrl?.replace(/\/api\/agent-messages$/, "/api/agent-reply-stream") : params?.name === "voice_reply" ? messageUrl?.replace(/\/api\/agent-messages$/, "/api/agent-voice-reply") : params?.name === "create_managed_agent"
      ? spawnUrl
      : params?.name === "coordinate"
        ? coordinateUrl
        : params?.name === "update_request"
          ? updateRequestUrl
          : params?.name === "history" ? historyUrl
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
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json",
          ...((params.name === "voice_reply" || params.name === "reply_stream") ? { "x-ponderosa-voice-operation-id": String(request.id) } : {}) },
        ...(!isDirectory ? { body: JSON.stringify(workspaceOperation ? {...(params.arguments&&typeof params.arguments==='object'?params.arguments:{}),operation:workspaceOperation} : localMemoryOperation ? {...memoryArguments,operation:localMemoryOperation} : browserOperation
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
