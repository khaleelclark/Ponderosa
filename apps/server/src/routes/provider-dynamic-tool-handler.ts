import {
  PONDEROSA_COORDINATE_TOOL,
  PONDEROSA_CREATE_MANAGED_AGENT_TOOL,
  PONDEROSA_DECISION_TOOL,
  PONDEROSA_HISTORY_TOOL,
  PONDEROSA_IMPORT_FILE_TOOL,
  PONDEROSA_MANAGE_TOOL,
  PONDEROSA_MESSAGE_TOOL,
  PONDEROSA_VOICE_REPLY_TOOL,
  PONDEROSA_TEAM_DIRECTORY_TOOL,
  PONDEROSA_UPDATE_REQUEST_TOOL,
  type RuntimeDynamicToolHandler,
  type RuntimeDynamicToolSpec,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";

export function createProviderDynamicToolHandler(
  app: FastifyInstance,
  availableRuntimeTools: RuntimeDynamicToolSpec[],
  messageCapability: string,
): RuntimeDynamicToolHandler {
  return async (call) => {
    if (!availableRuntimeTools.some((tool) => tool.name === call.name)) {
      return { success: false, text: `Unavailable Ponderosa tool for this Run: ${call.name}` };
    }
    const localMemoryOperation=call.name.startsWith("ponderosa_local_memory_")?call.name.slice("ponderosa_local_memory_".length):undefined;
    const browserOperation = call.name.startsWith("ponderosa_browser_")
      ? call.name.slice("ponderosa_browser_".length)
      : undefined;
    const directoryArguments = call.arguments && typeof call.arguments === "object"
      ? call.arguments as { agentId?: unknown }
      : {};
    const isDirectory = call.name === PONDEROSA_TEAM_DIRECTORY_TOOL.name;
    const workspaceOperation=call.name.startsWith('ponderosa_workspace_')?call.name.slice('ponderosa_workspace_'.length):call.name==='ponderosa_assistant_check'?'check':undefined;
    const url = workspaceOperation ? '/api/agent-workspace' : localMemoryOperation ? "/api/agent-local-memory" : call.name === PONDEROSA_VOICE_REPLY_TOOL.name ? "/api/agent-voice-reply" : call.name === PONDEROSA_CREATE_MANAGED_AGENT_TOOL.name
      ? "/api/agent-spawn"
      : call.name === PONDEROSA_DECISION_TOOL.name
        ? "/api/agent-decisions"
        : call.name === PONDEROSA_MANAGE_TOOL.name
          ? "/api/agent-management"
          : call.name === PONDEROSA_COORDINATE_TOOL.name
            ? "/api/agent-coordinate"
            : call.name === PONDEROSA_UPDATE_REQUEST_TOOL.name
              ? "/api/agent-request-updates"
              : call.name === PONDEROSA_MESSAGE_TOOL.name
                ? "/api/agent-messages"
                : call.name === PONDEROSA_HISTORY_TOOL.name
                  ? "/api/agent-history"
                  : call.name === PONDEROSA_IMPORT_FILE_TOOL.name
                    ? "/api/agent-import-file"
                    : isDirectory
                      ? `/api/agent-directory${typeof directoryArguments.agentId === "string" && directoryArguments.agentId.trim() ? `/${encodeURIComponent(directoryArguments.agentId.trim())}` : ""}`
                      : browserOperation
                        ? "/api/agent-browser"
                        : undefined;
    if (!url) {
      return { success: false, text: `Unknown Ponderosa tool: ${call.name}` };
    }
    const response = await app.inject({
      method: isDirectory ? "GET" : "POST",
      url,
      headers: {
        authorization: `Bearer ${messageCapability}`,
        "content-type": "application/json",
        ...(call.name === PONDEROSA_VOICE_REPLY_TOOL.name ? {"x-ponderosa-voice-operation-id":call.operationId ?? call.id} : {}),
      },
      ...(!isDirectory ? { payload: JSON.stringify(workspaceOperation ? {...(call.arguments&&typeof call.arguments==='object'?call.arguments:{}),operation:workspaceOperation} : localMemoryOperation ? {...(call.arguments&&typeof call.arguments==="object"?call.arguments:{}),operation:localMemoryOperation} : browserOperation
        ? { ...(call.arguments && typeof call.arguments === "object" ? call.arguments : {}), operation: browserOperation }
        : call.name === PONDEROSA_IMPORT_FILE_TOOL.name
          ? { ...(call.arguments && typeof call.arguments === "object" ? call.arguments : {}), toolCallId: call.id }
          : call.arguments ?? {}) } : {}),
    });
    const success = response.statusCode >= 200 && response.statusCode < 300;
    let text = response.body;
    if (!success) {
      try {
        const body: unknown = response.json();
        text = JSON.stringify(body && typeof body === "object" && !Array.isArray(body)
          ? { ...body, statusCode: response.statusCode }
          : { statusCode: response.statusCode, body });
      } catch {
        text = `HTTP ${response.statusCode}\n${response.body}`;
      }
    }
    return { success, text };
  };
}
