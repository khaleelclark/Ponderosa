import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type {
  Adapter,
  AgentEvent,
  AgentDeletionPreviewDto,
  EngineAuthStatus,
  EngineAvailabilityStatus,
  EngineCapabilities,
  ReadinessDto,
  RuntimeProcessHandle,
  RuntimeSession,
} from "@ponderosa/core";
import type { AgentStore, ManagedArtifactAsyncReadFaults, StoredLogEvent } from "@ponderosa/agents";
import { ASSET_LIMITS } from "./assets.js";
import type { WorkspaceArtifactReadFaults } from "./project-file-access.js";
import type { WebPushSender } from "./web-push-delivery.js";
import type { BrowserDriverFactory } from "./browser-session-manager.js";

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

export interface ManagementOperation {
  kind: "create_agent" | "rename_agent" | "stop_agent" | "delete_agent" | "set_manager";
  ref?: string;
  targetAgentId?: string;
  parentRef?: string;
  managerAgentId?: string | null;
  title?: string;
  engine?: string;
  model?: string;
  effort?: string;
  instructions?: string;
  /** Server-captured authority for stop_agent. Provider input cannot set it. */
  targetRunId?: string;
}

export interface ManagementPlan {
  id: string;
  agentId: string;
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  operations: ManagementOperation[];
  deletionPreview?: AgentDeletionPreviewDto;
  scopeHash?: string;
  approvalDecisionId?: string;
  createdAt: string;
  appliedAt?: string;
  result?: unknown;
}

export interface CreateServerOptions {
  dataDir: string;
  /** Starts only canonical crash cleanup, never listeners, triggers, or Run leasing. */
  startupMode?: "serve" | "shutdown_recovery";
  /** Launcher-owned data root. Runtime state remains under dataDir. */
  launcherDataDir?: string;
  /** Exact installed launcher generation used to fence shutdown receipts. */
  launcherGeneration?: string;
  store?: AgentStore;
  engines: EngineRegistration[];
  webDist?: string;
  authToken?: string;
  /** Installed-build identity. Development and test embeddings may omit it. */
  buildVersion?: string;
  releaseChannel?: string;
  /** Host-launcher security is enabled only for installed loopback builds.
   * The launcher secret never enters a browser; it creates one-time browser
   * bootstraps that exchange into HttpOnly local sessions. */
  launcherSecurity?: {
    controlToken: string;
    bootstrapTtlMs?: number;
    sessionTtlMs?: number;
    now?: () => number;
    randomToken?: () => string;
  };
  /** Validated production listener boundary. Tests embedding the server default safely to loopback. */
  networkSecurity?: ReadinessDto["networkSecurity"];
  /** Deterministic test seam; production resolves and pins public DNS itself. */
  linkFaviconLoader?: (target: URL) => Promise<{ body: Buffer; mediaType: string }>;
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
  /** Immutable source revision for deploy/runtime parity checks. */
  buildRevision?: string;
  /** Host-local origin injected into runtime tools; agents run on this server host. */
  agentBaseUrl?: string;
  logger?: boolean;
  /** Deterministic scheduling seams for retry tests; production uses host timers and randomness. */
  deliveryScheduling?: {
    now?: () => number;
    random?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    /** Test-only internal claim response override. */
    claimStatus?: () => number | undefined;
  };
  /** Deterministic execution-lease supervision seams; production uses one host timer per active run. */
  executionLeaseScheduling?: {
    leaseMs?: number;
    /** Persistent runtimes prove process liveness at this cadence. */
    heartbeatMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Bound persistent runtime resources after a turn becomes idle. */
  runtimeSessionScheduling?: {
    idleTtlMs?: number;
    /** Maximum number of completed runtimes kept warm across all agents. */
    maxIdleSessions?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Deterministic provider-authority cleanup retry seams. Production uses
   * capped exponential backoff with jitter. */
  runtimeAuthorityRetryScheduling?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Deterministic shutdown fault seam; never enabled in production. */
  shutdownFaults?: {
    backgroundCleanup?: () => void | Promise<void>;
    /** Strict provider-runtime close barrier fault used to prove that launcher
     * shutdown cannot publish a clean receipt when provider teardown fails. */
    providerClose?: () => void | Promise<void>;
    /** Maximum time non-authority cleanup may delay process shutdown. Provider
     * and browser process termination remain strict, separately awaited barriers. */
    backgroundCleanupTimeoutMs?: number;
  };
  /** Deterministic same-process event-consumer fault seam; never enabled in production configuration. */
  runtimeEventFaults?: {
    beforePersist?: (context: { agentId: string; runId: string; generation: number; event: AgentEvent }) => void | Promise<void>;
    stallAfterMs?: number;
    onOwnershipState?: (context: { agentId: string; runId: string; generation: number; state: RuntimeOwnershipState }) => void;
  };
  /** Deterministic post-commit deletion cleanup fault seam for recovery tests. */
  agentDeletionCleanupFaults?: {
    beforeServerCleanup?: (receiptId: string) => void | Promise<void>;
    runtimeTerminationTimeoutMs?: number;
  };
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
  /** Deterministic message-claim race seam; never enabled in production configuration. */
  messageLifecycleFaults?: {
    beforeRunClaim?: (context: { agentId: string; runId: string }) => void | Promise<void>;
    afterRunClaim?: (context: { agentId: string; runId: string; generation: number }) => void | Promise<void>;
    /** Crash seam after the authoritative SQLite commit and before append-only
     * chat/artifact projections. */
    afterCommunicationArtifactCommit?: (context: {
      kind: "communication" | "request_update";
      ownerId: string;
      artifactIds: string[];
    }) => void | Promise<void>;
    /** Deterministic crash seam immediately after the canonical append and
     * before any catalog association can expose artifact bytes. */
    afterCanonicalCommunicationAppend?: (context: {
      communicationEventId: string;
      artifactIds: string[];
    }) => void;
    /** Crash seams around queued-edit outbox reconciliation. SQLite has
     * already committed before either hook can run. */
    afterQueuedEditSqliteCommit?: (context: { activationId: string; revisionId: string }) => void | Promise<void>;
    afterQueuedEditRevisionAppend?: (context: { activationId: string; revisionId: string }) => void | Promise<void>;
  };
  /** Deterministic Project-file replacement seam; never enabled in production configuration. */
  projectFilePreviewFaults?: {
    afterResolve?: (resolvedPath: string) => void | Promise<void>;
  };
  /** Deterministic workspace-derived artifact read seams; never enabled in production configuration. */
  workspaceArtifactReadFaults?: WorkspaceArtifactReadFaults;
  /** Deterministic async managed-artifact read seam; never enabled in production configuration. */
  managedArtifactReadFaults?: ManagedArtifactAsyncReadFaults;
  /** Deterministic startup capability seam; production probes the exact platform authority. */
  artifactFilesystemCapabilityProbe?: () => ReadinessDto["checks"]["artifactFilesystem"];
  /** Deterministic process-containment seam; production probes the native authority. */
  processContainmentCapabilityProbe?: () => ReadinessDto["checks"]["processContainment"];
  /** Web Push configuration/test seams. Production reads host-only VAPID env. */
  webPush?: {
    publicKey?: string;
    privateKey?: string;
    subject?: string;
    sender?: WebPushSender;
    retryDelaysMs?: readonly number[];
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
  };
  /** Test seam or host override for the engine-agnostic browser driver. */
  browserDriverFactory?: BrowserDriverFactory;
  /** Bound each fallible Project-deletion cleanup barrier. Production defaults
   * to five seconds; tests may shorten the quarantine path. */
  projectDeletionCleanupTimeoutMs?: number;
  /** Deterministic post-commit Project tombstone cleanup seam; never enabled
   * in production configuration. */
  projectDeletionCleanupFaults?: {
    afterTombstoneRemoval?: (projectId: string) => void;
  };
}

export interface ActiveRun {
  runId: string;
  startedAt: string;
  executionId: string;
  leaseExpiresAt: string;
  controller: AbortController;
  messageCapability: string;
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
