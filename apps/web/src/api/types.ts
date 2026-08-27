import type {
  AgentStreamStatusDto,
  SseEventEnvelope,
  WorkspaceEventEnvelope,
  WorkspaceStreamStatusDto,
} from "@ponderosa/core";

/** User-facing options when spawning an agent from the UI. */
export interface CreateAgentOptions {
  title: string;
  engine: string;
  model?: string;
  effort?: string;
  speed?: string;
  /** Starts the first turn as part of creation, avoiding a stranded idle agent. */
  initialMessage?: string;
  draftAttachmentIds?: string[];
  draftOwnerId?: string;
  presetId?: string;
  managerAgentId?: string;
  idempotencyKey?: string;
}

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
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
