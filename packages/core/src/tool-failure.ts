export type ToolFailureCategory =
  | "operation_not_provided"
  | "temporary_connection_failure"
  | "authentication_required"
  | "permission_denied"
  | "invalid_input"
  | "permanent_failure";

export interface ToolFailureClassification {
  category: ToolFailureCategory;
  retryable: boolean;
}

/**
 * Convert provider-owned MCP and dynamic-tool failures into one safe public
 * category. The complete provider output remains in the audit trail; this
 * classifier never promotes its prose into instructions or user-facing copy.
 */
export function classifyToolFailure(
  output: string,
  isError: boolean,
): ToolFailureClassification | undefined {
  // Some connector bridges return a successful transport envelope whose
  // structured payload is still an MCP failure. Treat only explicit error
  // shapes as failures so ordinary successful content that mentions an error
  // is not misclassified.
  const hasEmbeddedFailure =
    /^\s*(?:mcpservererror|error)\s*:/iu.test(output) ||
    /"isError"\s*:\s*true\b/iu.test(output) ||
    /"error_code"\s*:\s*"[^"]+"/iu.test(output) ||
    /"error_data"\s*:\s*\{/iu.test(output);
  if (!isError && !hasEmbeddedFailure) return undefined;
  const detail = output.toLowerCase();
  if (/\b(?:unknown|missing|unsupported|unrecognized) (?:mcp )?tool\b|\btool (?:was )?not found\b|\bdoes not (?:expose|provide|support)\b|\bno such (?:operation|tool)\b/u.test(detail)) {
    return { category: "operation_not_provided", retryable: false };
  }
  if (
    /\b(?:unauthenticated|unauthorized|authentication required|authorization required|login required|not authenticated|missing[_ ]bearer[_ ]token|invalid[_ ]grant|invalid[_ ]client)\b/u.test(detail) ||
    /\boauth(?: authentication)? (?:required|failed|failure|error)\b|\b(?:oauth (?:access )?|bearer )token (?:missing|required|invalid|expired)\b/u.test(detail) ||
    /\bhttp(?:\/\d(?:\.\d)?)?(?:\s+status)?\s+401\b|["']?(?:status(?:[_\s]*code)?|error[_\s]+code)["']?\s*[:=]?\s*401\b/u.test(detail) ||
    /\b401(?:\s*:\s*|\s+)(?:unauthorized|unauthenticated|authentication required|token (?:missing|required|invalid|expired))\b/u.test(detail)
  ) {
    return { category: "authentication_required", retryable: false };
  }
  if (/\b(?:403|forbidden|permission denied|access denied|insufficient (?:permission|scope)|not permitted)\b/u.test(detail)) {
    return { category: "permission_denied", retryable: false };
  }
  if (/\b(?:invalid[_ ]argument|invalid input|schema validation|parameters? failed|bad request|malformed|required (?:field|parameter)|400)\b/u.test(detail)) {
    return { category: "invalid_input", retryable: false };
  }
  if (
    /\b(?:502|503|504|network[_ ]error|connection (?:failed|reset|refused|closed)|transport (?:send )?error|timed? out|timeout|socket hang up|econnreset|econnrefused)\b/u.test(detail) ||
    /\b(?:(?:service|server|upstream|provider|endpoint|api) (?:is )?temporarily unavailable|temporarily unavailable (?:service|server|upstream|provider|endpoint|api))\b/u.test(detail)
  ) {
    return { category: "temporary_connection_failure", retryable: true };
  }
  return { category: "permanent_failure", retryable: false };
}

export function toolFailureLabel(category: ToolFailureCategory): string {
  switch (category) {
    case "operation_not_provided": return "Operation not provided";
    case "temporary_connection_failure": return "Temporary connection failure";
    case "authentication_required": return "Authentication required";
    case "permission_denied": return "Permission denied";
    case "invalid_input": return "Invalid input";
    case "permanent_failure": return "Tool failed";
  }
}

/** Conservative name-based fallback when a provider omits MCP annotations. */
export function toolOperationAccess(name: string): "read" | "write" | "unknown" {
  const operation = name.split(/[./]/u).at(-1)?.toLowerCase() ?? "";
  if (/^(?:get|list|read|search|find|fetch|inspect|lookup|view|query|describe|check|status)(?:_|$)/u.test(operation)) return "read";
  if (/^(?:create|update|delete|remove|submit|send|upload|write|edit|patch|post|put|reconcile|approve|reject|cancel|purchase|publish)(?:_|$)/u.test(operation)) return "write";
  return "unknown";
}
