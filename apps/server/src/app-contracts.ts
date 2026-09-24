import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type {
  Adapter,
  AgentEvent,
  EngineAuthStatus,
  EngineAvailabilityStatus,
  EngineCapabilities,
  ReadinessDto,
  RuntimeProcessHandle,
  RuntimeSession,
} from "@ponderosa/core";
import type {
  AgentStore,
  ResolvedAgentWorkingCopy,
  StoredLogEvent,
} from "@ponderosa/agents";
export type { ManagementOperation, ManagementPlan } from "@ponderosa/agents";
import { ASSET_LIMITS } from "./assets.js";

export type RuntimeOwnershipState = "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export type LinkPreviewSocketPair = {
  client: WebSocket;
  upstream: WebSocket;
  openedAt: number;
  lastActivityAt: number;
  clientAlive: boolean;
  upstreamAlive: boolean;
  closing?: boolean;
};

export type LinkPreviewRegistration = {
  origin: string;
  expiresAt: number;
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  connections: Set<LinkPreviewSocketPair>;
  httpConnections: Set<AbortController>;
  reconnectAttempts: number[];
};

export interface EngineRegistration {
  adapter: Adapter;
  authStatus?: () => Promise<EngineAuthStatus>;
  availabilityProbe?: () => Promise<EngineAvailabilityStatus>;
}

export interface CreateServerOptions {
  dataDir: string;
  /** Explicit bootstrap authority for the persistent local browser service. */
  browserServiceSocket?: string;
  /** Starts only canonical crash cleanup, never listeners, triggers, or Run leasing. */
  startupMode?: "serve" | "shutdown_recovery";
  /** Qualification instances accept explicit inspection but lease no Runs until resumed. */
  startDrained?: boolean;
  /** Launcher-owned data root. Runtime state remains under dataDir. */
  launcherDataDir?: string;
  /** Exact installed launcher generation used to fence shutdown receipts. */
  launcherGeneration?: string;
  store?: AgentStore;
  engines: EngineRegistration[];
  webDist?: string;
  authToken?: string;
  /** Installed-build identity. Development embeddings may omit it. */
  buildVersion?: string;
  releaseChannel?: string;
  /** Host-launcher security is enabled only for installed loopback builds.
   * The launcher secret never enters a browser; it creates one-time browser
   * bootstraps that exchange into HttpOnly local sessions. */
  launcherSecurity?: {
    controlToken: string;
    bootstrapTtlMs?: number;
    sessionTtlMs?: number;
  };
  /** Validated production listener boundary. Embedded servers default safely to loopback. */
  networkSecurity?: ReadinessDto["networkSecurity"];
  /** Exact browser-facing origins admitted by Host/Origin validation. */
  operatorOrigins?: string[];
  /** Exact lower-cased identities asserted by the trusted loopback proxy. */
  operatorIdentities?: string[];
  /** Global admission limits. Tests and embedded servers may omit them. */
  requestLimits?: {
    maxRequestsPerMinute: number;
    /** Separate bounded capacity for operator-authored drafts and messages. */
    maxCriticalRequestsPerMinute?: number;
    maxInflight: number;
    /** Response deadline; admission remains held until the handler settles. */
    handlerDeadlineMs?: number;
  };
  /** Deterministic limits for the opaque localhost-preview transport. */
  linkPreviewScheduling?: {
    registrationTtlMs?: number;
    upstreamHandshakeTimeoutMs?: number;
    heartbeatMs?: number;
    maxConnectionsPerRegistration?: number;
    maxTotalConnections?: number;
    maxPayloadBytes?: number;
    maxBufferedBytes?: number;
    maxPendingFrames?: number;
    maxHttpConnectionsPerRegistration?: number;
    maxIdleMs?: number;
    closeGraceMs?: number;
    maxReconnectsPerWindow?: number;
    reconnectWindowMs?: number;
  };
  /** Explicit roots exposed by the host folder picker. */
  allowedBrowseRoots?: string[];
  /** Additional operator-configured roots from which active runs may import files. */
  allowedImportRoots?: string[];
  /** Immutable source revision for deploy/runtime parity checks. */
  buildRevision?: string;
  /** Host-local origin injected into runtime tools; agents run on this server host. */
  agentBaseUrl?: string;
  logger?: boolean;
  /** Communication V3 scheduler tuning. V3 is unconditional. */
  communicationV3?: {
    maxConcurrentRuns?: number;
    pollMs?: number;
    /** Scheduler ownership lease. Defaults to the provider execution lease so
     * ordinary long turns cannot be mistaken for abandoned work. */
    leaseMs?: number;
    /** Terminalize a repeatedly rejected Activation after this many dispatch attempts. */
    maxDeliveryFailures?: number;
    /** Provider steer acknowledgement grace before exact-Run interruption. */
    steeringRecoveryGraceMs?: number;
  };
}

export interface ActiveRun {
  runId: string;
  startedAt: string;
  executionId: string;
  leaseExpiresAt: string;
  controller: AbortController;
  messageCapability: string;
  workingCopy: ResolvedAgentWorkingCopy;
  leaseTimer?: NodeJS.Timeout;
  livenessTimer?: NodeJS.Timeout;
  generation: number;
  ownershipState: RuntimeOwnershipState;
  lastEventReceivedAt?: string;
  lastEventPersistedAt?: string;
  runtimeSession?: RuntimeSession;
  /** Stable identity of the persistent provider process serving this turn.
   * Root-exit callbacks bind to this identity rather than the Run that first
   * opened a reusable session. */
  persistentRuntimeIdentity?: object;
  v3SchedulerRunId?: string;
  v3FencingToken?: number;
  conversationId?: string;
  /** Settles only after the provider event loop has stopped. Deletion keeps
   * this handle until a non-session runtime acknowledges cancellation. */
  completion?: Promise<void>;
}

export interface PersistentRuntime {
  /** Host-owned identity that survives reuse across provider turns. */
  identity: object;
  session: RuntimeSession;
  iterator: AsyncIterator<AgentEvent>;
  /** Stable secrets injected once into the persistent engine process. */
  messageCapability: string;
  /** Set only while the runtime is eligible for warm-pool eviction. */
  idleSince?: number;
  idleTimer?: NodeJS.Timeout;
}

export interface PersistentRuntimeTeardown {
  runtime: PersistentRuntime;
  reason: string;
  projectId?: string;
  operation?: Promise<void>;
  lastError?: string;
}

export interface OpeningPersistentRuntime {
  identity: object;
  projectId: string;
  /** Registered before Adapter.openSession() begins, so deletion and shutdown
   * cannot miss a provider process whose handle has not returned yet. */
  operation: Promise<PersistentRuntime>;
  /** Registered synchronously at provider spawn, before adapter readiness. */
  handle?: RuntimeProcessHandle;
  settled?: boolean;
  terminationConfirmed?: boolean;
  terminationOperation?: Promise<void>;
  lastError?: string;
}

export interface OneShotRuntimeTeardown {
  agentId: string;
  projectId: string;
  runId: string;
  handle: RuntimeProcessHandle;
  operation?: Promise<void>;
  terminationConfirmed?: boolean;
  lastError?: string;
}

export interface CapabilityDiscoveryProcess {
  handle: RuntimeProcessHandle;
  operation?: Promise<void>;
  terminationConfirmed?: boolean;
}

export interface CapabilityDiscoveryAuthority {
  projectId: string;
  /** Present when this authority is bound to one Agent working folder. */
  agentId?: string;
  engineId: string;
  key: string;
  controller: AbortController;
  processes: Set<CapabilityDiscoveryProcess>;
  operation?: Promise<EngineCapabilities>;
  settled: boolean;
}

export interface ModelCatalogDiscoveryAuthority {
  projectId: string;
  engineId: string;
  key: string;
  controller: AbortController;
  processes: Set<CapabilityDiscoveryProcess>;
  operation?: Promise<unknown>;
  settled: boolean;
}

/** One Agent-indexed registry owns every provider process handle. Scheduler Run
 * ownership remains separately fenced in SQLite; this registry is the local
 * admission barrier that prevents overlapping host authority. */
export interface AgentRuntimeAuthority {
  opening?: OpeningPersistentRuntime;
  reusable?: PersistentRuntime;
  closing?: PersistentRuntimeTeardown;
  oneShots: Map<string, OneShotRuntimeTeardown>;
  retryTimer?: NodeJS.Timeout;
  retryAttempt: number;
  retryInProgress?: boolean;
}

/** A deferred user or agent turn.  Queues are per-agent and FIFO. */
export interface PendingTurn {
  text: string;
  communicationEventId?: string;
  model?: string;
  effort?: string;
  speed?: string;
  agentMentionDepth: number;
  agentMentionTrail: string[];
  sourceChannel?: "main";
  sourceConversationId?: string;
  sourceAuthorAgentId?: string;
  attachmentIds?: string[];
}

export interface AgentMessageCapability {
  agentId: string;
  conversationId?: string;
  runId: string;
  v3SchedulerRunId: string;
  v3FencingToken: number;
  mentionDepth: number;
  mentionTrail: string[];
  /** Completed Broadcasts answering a plain shared Master request render as ordinary chat prose. */
  plainSharedReply?: boolean;
  /** Canonical reply route inferred from the Activation that owns this Run. */
  defaultReply?: {
    intent: "broadcast" | "direct_to_user" | "collaboration";
    recipientAgentIds?: string[];
  };
  /** Material reply fingerprints are fenced independently for each selected
   * route when coalesced sources have incompatible authorities. */
  requiredReplyFingerprints?: Record<string, string>;
  /** Canonical visible reply committed by this Run, used to suppress rollover duplicates. */
  inferredReplyCommunicationEventId?: string;
  /** Project artifacts explicitly submitted to this Run's provider context. */
  reachableArtifactIds: string[];
  /** Exact host-authorized tool routes for this Run. */
  availableToolNames: string[];
  /** Canonical authored messages represented in this Run's exact submitted
   * manifest or its exact bounded fresh-reseed manifest. Retrieval must never
   * silently repeat this current-context tail, including on resumed sessions. */
  historyRetrievalExcludedCommunicationEventIds: string[];
  /** Present only for a provider continuity chain with a durable compaction
   * boundary and at least one authorized omitted message. */
  historyRetrievalBoundary?: {
    canonicalOrdinal: number;
    communicationEventId?: string;
  };
}

export type Subscriber = (stored: StoredLogEvent) => void;

export const MAX_TEXT_LENGTH = 64 * 1024;
export const MAX_SSE_SUBSCRIBERS_PER_STREAM = 20;
export const MAX_ATTACHMENTS_PER_MESSAGE = ASSET_LIMITS.maxAssetsPerMessage;
export const MIN_CONFIGURABLE_AGENT_RUN_CONCURRENCY = 1;
export const MAX_CONFIGURABLE_AGENT_RUN_CONCURRENCY = 64;

export function agentMessageEndpoint(
  _request: { protocol: string; headers: Record<string, unknown> },
  configuredBaseUrl?: string,
): string {
  if (configuredBaseUrl) return `${configuredBaseUrl.replace(/\/$/, "")}/api/agent-messages`;
  // Capabilities are injected into host-local runtimes. Never let an external
  // Host/X-Forwarded-* header choose where those bearer tokens are sent.
  return "http://127.0.0.1:8787/api/agent-messages";
}

export interface PonderosaServer extends FastifyInstance {
  /** Stop accepting work and synchronously detach long-lived HTTP streams so
   * Fastify's close lifecycle can reach its durable teardown hooks. */
  prepareForShutdown(): void;
  /** Retry every retained strict cleanup barrier after Fastify has stopped
   * accepting requests. Successful retries are safe and idempotent. */
  retryShutdownCleanup(): Promise<void>;
  /** Promote the exact launcher receipt after a post-close signal retry proves
   * the same generation's strict cleanup completed. */
  completeLauncherShutdownRecovery?: () => void;
}
