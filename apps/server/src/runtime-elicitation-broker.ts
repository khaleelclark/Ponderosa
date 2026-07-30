import type {
  RuntimeElicitationActionDto,
  RuntimeElicitationRequest,
  RuntimeElicitationResponse,
} from "@ponderosa/core";

interface PendingElicitation {
  request: RuntimeElicitationRequest;
  resolve(response: RuntimeElicitationResponse): void;
  abort(): void;
}

const BARE_CONFIRMATION_SCHEMA_KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
]);

/** Reserved response identity for a server-applied provider permission. */
export const AUTO_ALLOWED_DECISION_OPTION_ID = "auto_allowed";

function confirmationKey(request: RuntimeElicitationRequest): string | undefined {
  if (request.mode === "url") return undefined;
  const schema = request.requestedSchema;
  if (Object.keys(schema).some((key) => !BARE_CONFIRMATION_SCHEMA_KEYS.has(key))) {
    return undefined;
  }
  if (schema.type !== undefined && schema.type !== "object") return undefined;
  const properties = schema.properties;
  if (properties !== undefined &&
      (!properties || typeof properties !== "object" || Array.isArray(properties) ||
        Object.keys(properties).length > 0)) return undefined;
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.length > 0)) return undefined;
  if (schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean") return undefined;
  // Exact message equality narrows the lease without inferring a tool name or
  // permission scope from provider-authored prose.
  return `${request.serverName}\0${request.message}`;
}

/**
 * Keeps live provider elicitations out of durable state. OAuth URLs and form
 * values exist only while the corresponding provider request is waiting.
 */
export class RuntimeElicitationBroker {
  private readonly pending = new Map<string, PendingElicitation>();
  private readonly runConfirmationApprovals = new Map<string, Set<string>>();

  canRememberForRun(request: RuntimeElicitationRequest): boolean {
    return confirmationKey(request) !== undefined;
  }

  allowsForRun(runId: string, request: RuntimeElicitationRequest): boolean {
    const key = confirmationKey(request);
    return Boolean(key && this.runConfirmationApprovals.get(runId)?.has(key));
  }

  rememberForRun(runId: string, request: RuntimeElicitationRequest): boolean {
    const key = confirmationKey(request);
    if (!key) return false;
    const approvals = this.runConfirmationApprovals.get(runId) ?? new Set<string>();
    approvals.add(key);
    this.runConfirmationApprovals.set(runId, approvals);
    return true;
  }

  clearRun(runId: string): void {
    this.runConfirmationApprovals.delete(runId);
  }

  wait(
    decisionId: string,
    request: RuntimeElicitationRequest,
    signal: AbortSignal,
  ): Promise<RuntimeElicitationResponse> {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    if (this.pending.has(decisionId)) return Promise.resolve({ action: "cancel" });
    return new Promise((resolve) => {
      const finish = (response: RuntimeElicitationResponse): void => {
        signal.removeEventListener("abort", abort);
        this.pending.delete(decisionId);
        resolve(response);
      };
      const abort = (): void => finish({ action: "cancel" });
      this.pending.set(decisionId, { request, resolve: finish, abort });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  action(decisionId: string): RuntimeElicitationActionDto | undefined {
    const request = this.pending.get(decisionId)?.request;
    if (!request) return undefined;
    return { decisionId, ...request };
  }

  respond(decisionId: string, response: RuntimeElicitationResponse): boolean {
    const pending = this.pending.get(decisionId);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  cancel(decisionId: string): boolean {
    const pending = this.pending.get(decisionId);
    if (!pending) return false;
    pending.abort();
    return true;
  }
}
