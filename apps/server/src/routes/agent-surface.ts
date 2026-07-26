import type { FastifyInstance } from "fastify";
import type { CreateServerOptions } from "../app-contracts.js";
import { createAgentEventService } from "../agent-event-service.js";
import { createCommunicationDocumentAuthority } from "../communication-document-authority.js";
import { registerAgentCommunicationRoutes } from "./agent-communications.js";
import { registerAgentCoordinationRoutes } from "./agent-coordination.js";
import { registerAgentDecisionRoutes } from "./agent-decisions.js";
import { registerAgentDirectoryRoutes } from "./agent-directory.js";
import { registerAgentManagementRoutes } from "./agent-management.js";
import { registerAgentRequestCommandRoutes } from "./agent-request-commands.js";
import { registerAgentRuntimeToolRoutes } from "./agent-runtime-tools.js";

type AgentEventsInput = Parameters<typeof createAgentEventService>[0];
type DecisionRoutes = Parameters<typeof registerAgentDecisionRoutes>[1];
type ManagementRoutes = Parameters<typeof registerAgentManagementRoutes>[1];
type RuntimeToolRoutes = Parameters<typeof registerAgentRuntimeToolRoutes>[1];
type DirectoryRoutes = Parameters<typeof registerAgentDirectoryRoutes>[1];
type CoordinationRoutes = Parameters<typeof registerAgentCoordinationRoutes>[1];
type RequestRoutes = Parameters<typeof registerAgentRequestCommandRoutes>[1];
type CommunicationRoutes = Parameters<typeof registerAgentCommunicationRoutes>[1];

interface AgentSurfaceContext {
  opts: CreateServerOptions;
  store: AgentEventsInput["store"];
  coordinationV3: AgentEventsInput["coordinationV3"];
  subscribers: AgentEventsInput["subscribers"];
  recordCommunication: AgentEventsInput["recordCommunication"];
  collaborationViewDetail: AgentEventsInput["collaborationViewDetail"];
  refreshProviderUsageAfterRun: AgentEventsInput["refreshProviderUsageAfterRun"];
  appendWorkspace: AgentEventsInput["appendWorkspace"];
  publishCoordinationV3Changed: AgentEventsInput["publishCoordinationV3Changed"];
  workspace: DecisionRoutes["workspace"];
  agentMessageCapabilities: DecisionRoutes["agentMessageCapabilities"];
  activeRuns: DecisionRoutes["activeRuns"];
  capabilityOwnsAuthoritativeRun: DecisionRoutes["capabilityOwnsAuthoritativeRun"];
  publishWorkspaceSince: DecisionRoutes["publishWorkspaceSince"];
  engines: ManagementRoutes["engines"];
  managementPlans: ManagementRoutes["managementPlans"];
  deletingAgentIds: ManagementRoutes["deletingAgentIds"];
  cachedModelOptions: ManagementRoutes["cachedModelOptions"];
  publicManagementOperations: ManagementRoutes["publicManagementOperations"];
  commitAgentDeletion: ManagementRoutes["commitAgentDeletion"];
  assets: RuntimeToolRoutes["assets"];
  resultCursorSecret: RuntimeToolRoutes["resultCursorSecret"];
  browserSessions: RuntimeToolRoutes["browserSessions"];
  projectBrowserSessions: RuntimeToolRoutes["projectBrowserSessions"];
  projectBrowserGrants: RuntimeToolRoutes["projectBrowserGrants"];
  projectBrowserScope: RuntimeToolRoutes["projectBrowserScope"];
  teamDirectory: DirectoryRoutes["teamDirectory"];
  runAuthorization: CoordinationRoutes["runAuthorization"];
  capabilityMatchesCleanupRun: RequestRoutes["capabilityMatchesCleanupRun"];
  projectCommunicationArtifact: RequestRoutes["projectCommunicationArtifact"];
  requestArtifactAccess: RequestRoutes["requestArtifactAccess"];
  runtimeArtifactMetadata: RequestRoutes["runtimeArtifactMetadata"];
  stageCommunicationArtifact: RequestRoutes["stageCommunicationArtifact"];
  communicationArtifactAccess: CommunicationRoutes["communicationArtifactAccess"];
  reconcileRuntimeCommunicationProjections: CommunicationRoutes["reconcileRuntimeCommunicationProjections"];
  notifyScheduler(): void;
  isClosed(): boolean;
}

export function registerAgentSurface(
  app: FastifyInstance,
  context: AgentSurfaceContext,
) {
  const {
    opts,
    store,
    coordinationV3,
    subscribers,
    recordCommunication,
    collaborationViewDetail,
    refreshProviderUsageAfterRun,
    appendWorkspace,
    publishCoordinationV3Changed,
    workspace,
    agentMessageCapabilities,
    activeRuns,
    capabilityOwnsAuthoritativeRun,
    publishWorkspaceSince,
    engines,
    managementPlans,
    deletingAgentIds,
    cachedModelOptions,
    publicManagementOperations,
    commitAgentDeletion,
    assets,
    resultCursorSecret,
    browserSessions,
    projectBrowserSessions,
    projectBrowserGrants,
    projectBrowserScope,
    teamDirectory,
    runAuthorization,
    capabilityMatchesCleanupRun,
    projectCommunicationArtifact,
    requestArtifactAccess,
    runtimeArtifactMetadata,
    stageCommunicationArtifact,
    communicationArtifactAccess,
    reconcileRuntimeCommunicationProjections,
    notifyScheduler,
    isClosed,
  } = context;

const {
  appendBlockedMentionWarnings,
  appendCollaborationSystemNotice,
  notifyManagerOfChildFailure,
  projectBroadcastToAgentAudit,
  projectBroadcastToAgentAudits,
  projectCommunicationToAgentAudit,
  publish,
  resolveCollaborationIntents,
  resolveExplicitCollaborationIntents,
  subscribe,
} = createAgentEventService({
  store,
  coordinationV3,
  subscribers,
  recordCommunication,
  collaborationViewDetail,
  refreshProviderUsageAfterRun,
  appendWorkspace,
  notifyScheduler: notifyScheduler,
  isClosed: isClosed,
  publishCoordinationV3Changed,
});

registerAgentDecisionRoutes(app, {
  store,
  coordinationV3,
  workspace,
  agentMessageCapabilities,
  activeRuns,
  capabilityOwnsAuthoritativeRun,
  publishWorkspaceSince,
});

registerAgentManagementRoutes(app, {
  store,
  coordinationV3,
  workspace,
  engines,
  managementPlans,
  activeRuns,
  agentMessageCapabilities,
  deletingAgentIds,
  cachedModelOptions,
  capabilityOwnsAuthoritativeRun,
  publicManagementOperations,
  commitAgentDeletion,
  appendWorkspace,
  publishWorkspaceSince,
  notifyScheduler: notifyScheduler,
  authToken: opts.authToken,
});

registerAgentRuntimeToolRoutes(app, {
  store,
  coordinationV3,
  assets,
  resultCursorSecret,
  agentMessageCapabilities,
  activeRuns,
  browserSessions,
  projectBrowserSessions,
  projectBrowserGrants,
  projectBrowserScope,
  capabilityOwnsAuthoritativeRun,
  agentCanReadRuntimeArtifact: (artifact, agentId) =>
    agentCanReadRuntimeArtifact(artifact, agentId),
});

registerAgentDirectoryRoutes(app, {
  store,
  agentMessageCapabilities,
  activeRuns,
  capabilityOwnsAuthoritativeRun,
  teamDirectory,
});

registerAgentCoordinationRoutes(app, {
  store,
  coordinationV3,
  engines,
  deletingAgentIds,
  agentMessageCapabilities,
  activeRuns,
  cachedModelOptions,
  capabilityOwnsAuthoritativeRun,
  recordCommunication,
  projectCommunicationToAgentAudit,
  publishCoordinationV3Changed,
  notifyScheduler: notifyScheduler,
  runAuthorization,
  resolveExplicitCollaborationIntents,
  logWarn: (meta, message) => app.log.warn(meta, message),
});

registerAgentRequestCommandRoutes(app, {
  store,
  coordinationV3,
  agentMessageCapabilities,
  activeRuns,
  capabilityOwnsAuthoritativeRun,
  capabilityMatchesCleanupRun,
  runAuthorization,
  projectCommunicationArtifact,
  requestArtifactAccess,
  runtimeArtifactMetadata,
  stageCommunicationArtifact,
  publishCoordinationV3Changed,
  notifyScheduler: notifyScheduler,
  messageLifecycleFaults: opts.messageLifecycleFaults,
});

registerAgentCommunicationRoutes(app, {
  store,
  coordinationV3,
  workspace,
  agentMessageCapabilities,
  activeRuns,
  capabilityOwnsAuthoritativeRun,
  runAuthorization,
  recordCommunication,
  projectBroadcastToAgentAudits,
  projectCommunicationToAgentAudit,
  resolveExplicitCollaborationIntents,
  appendBlockedMentionWarnings,
  communicationArtifactAccess,
  projectCommunicationArtifact,
  runtimeArtifactMetadata,
  stageCommunicationArtifact,
  publishCoordinationV3Changed,
  publishWorkspaceSince,
  notifyScheduler: notifyScheduler,
  messageLifecycleFaults: opts.messageLifecycleFaults,
  reconcileRuntimeCommunicationProjections,
  publish,
});

const {
  agentCanReadDocument,
  agentCanReadRuntimeArtifact,
  authoritativeCommunicationDocument,
  managedProjectArtifactAgreesWithRuntime,
} = createCommunicationDocumentAuthority(app, {
  store,
  coordinationV3,
  assets,
  communicationArtifactAccess,
  agentMessageCapabilities,
  activeRuns,
  capabilityOwnsAuthoritativeRun,
});
  return {
    appendBlockedMentionWarnings,
    appendCollaborationSystemNotice,
    notifyManagerOfChildFailure,
    projectBroadcastToAgentAudit,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    publish,
    resolveCollaborationIntents,
    resolveExplicitCollaborationIntents,
    subscribe,
    agentCanReadDocument,
    agentCanReadRuntimeArtifact,
    authoritativeCommunicationDocument,
    managedProjectArtifactAgreesWithRuntime,
  };
}
