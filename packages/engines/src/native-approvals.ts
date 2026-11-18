import type { OpenRuntimeSessionOptions, RuntimeNativeApprovalIdentity } from "@ponderosa/core";

/** Answer the original provider callback once; never amend saved permission rules. */
export async function requestNativeApproval(
  opts: Pick<OpenRuntimeSessionOptions, "handleElicitation" | "signal" | "capabilityRestrictions">,
  identity: RuntimeNativeApprovalIdentity,
  details: unknown,
): Promise<boolean> {
  if (!opts.handleElicitation || opts.signal.aborted) return false;
  const value = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
  const toolName = typeof value?.tool_name === "string" ? value.tool_name : "";
  const restrictions = opts.capabilityRestrictions;
  // Human-denied native capabilities cannot be raised by one tool approval.
  if (restrictions?.filesystemWriteRestricted) {
    const permissions = value?.permissions as {fileSystem?:unknown} | undefined;
    if (identity.kind === "command" || identity.kind === "file" ||
        identity.kind === "permissions" && permissions?.fileSystem != null ||
        identity.kind === "tool" && ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit"].includes(toolName)) return false;
  }
  if (restrictions?.restrictedConnectorNames.some(name => {
    const nativeName = `mcp__${name.replace(/[^\p{L}\p{N}_-]/gu, "_")}`;
    return toolName === nativeName || toolName.startsWith(`${nativeName}__`);
  })) return false;
  const message = JSON.stringify(details, null, 2);
  if (!message || message.length > 32_000) return false;
  try {
    const response = await opts.handleElicitation({
      mode: "form", serverName: "native runtime approval", nativeApproval: identity,
      message,
      requestedSchema: { type: "object", additionalProperties: false,
        properties: { approve: { type: "boolean", title: identity.kind === "permissions" ? "Allow these requested permissions for this native turn" : "Allow this exact operation once" } }, required: ["approve"] },
    }, opts.signal);
    const content = response.content;
    return !opts.signal.aborted && response.action === "accept" &&
      content !== null && typeof content === "object" && !Array.isArray(content) &&
      Object.keys(content).length === 1 && (content as {approve?: unknown}).approve === true;
  } catch { return false; }
}

export const CODEX_NATIVE_APPROVAL_METHODS = new Map<string, RuntimeNativeApprovalIdentity["kind"]>([
  ["item/commandExecution/requestApproval", "command"],
  ["item/fileChange/requestApproval", "file"],
  ["item/permissions/requestApproval", "permissions"],
] as const);

export async function answerCodexNativeApproval(
  opts: Pick<OpenRuntimeSessionOptions, "handleElicitation" | "signal" | "capabilityRestrictions">,
  sessionId: string, currentTurnId: () => string | undefined,
  requestId: string, method: string, params: unknown,
): Promise<unknown> {
  const kind = CODEX_NATIVE_APPROVAL_METHODS.get(method);
  if (!kind || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid native approval");
  const value = params as Record<string, unknown>;
  if (value.threadId !== sessionId || typeof value.turnId !== "string" ||
      value.turnId !== currentTurnId() || typeof value.itemId !== "string" || !value.itemId) throw new Error("Foreign native approval");
  const accepted = await requestNativeApproval(opts, { requestId, sessionId,
    turnId: value.turnId, kind }, value);
  const allowed = accepted && currentTurnId() === value.turnId;
  if (kind !== "permissions") return { decision: allowed ? "accept" : "decline" };
  const requested = value.permissions;
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return { permissions: {}, scope: "turn" };
  const profile = requested as Record<string, unknown>;
  // Return only the exact requested permissions, never session-wide grants.
  return { permissions: allowed ? {
    ...(profile.network != null ? { network: profile.network } : {}),
    ...(profile.fileSystem != null ? { fileSystem: profile.fileSystem } : {}),
  } : {}, scope: "turn" };
}
