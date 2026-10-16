import type {
  AgentStreamStatusDto,
  CreateAgentRequest,
  SseEventEnvelope,
  WorkspaceEventEnvelope,
  WorkspaceStreamStatusDto,
} from "@ponderosa/core";

/** UI creation leaves management permissions at the server's disabled default. */
export type CreateAgentOptions = Omit<CreateAgentRequest, "conversationId" | "managementPermissions">;

export interface StreamSubscription {
  close(): void;
}

export interface StreamHandlers {
  onEvent(envelope: SseEventEnvelope): void;
  onStatus?(status: AgentStreamStatusDto): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export interface WorkspaceStreamHandlers {
  onEvent(envelope: WorkspaceEventEnvelope): void;
  onStatus?(status: WorkspaceStreamStatusDto): void;
  onOpen?(): void;
  onError?(error: unknown): void;
}

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown, readonly retryAfterMs?: number) {
    super(message);
  }
}
