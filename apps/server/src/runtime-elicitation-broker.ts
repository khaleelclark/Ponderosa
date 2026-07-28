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

/**
 * Keeps live provider elicitations out of durable state. OAuth URLs and form
 * values exist only while the corresponding provider request is waiting.
 */
export class RuntimeElicitationBroker {
  private readonly pending = new Map<string, PendingElicitation>();

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
