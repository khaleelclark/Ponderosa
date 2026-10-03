import { agentCanReadRequest, type ArtifactDto, type CommunicationEvent } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  RuntimeArtifactInputV3,
  RuntimeArtifactV3,
} from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { AssetStore } from "./assets.js";
import type { ActiveRun, AgentMessageCapability } from "./app-contracts.js";
import type { createCommunicationArtifactAuthority } from "./communication-artifacts.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface CommunicationDocumentAuthorityContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  communicationArtifactAccess: CommunicationArtifactAuthority["communicationArtifactAccess"];
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  capabilityOwnsAuthoritativeRun(
    capability: AgentMessageCapability,
    run: ActiveRun | undefined,
  ): boolean;
}

export function createCommunicationDocumentAuthority(
  app: FastifyInstance,
  context: CommunicationDocumentAuthorityContext,
) {
  const {
    store,
    coordinationV3,
    assets,
    communicationArtifactAccess,
    agentMessageCapabilities,
    activeRuns,
    capabilityOwnsAuthoritativeRun,
  } = context;

  function agentCanReadDocument(event: CommunicationEvent, agentId: string): boolean {
    const agent = store.getAgent(agentId);
    if (!agent || agent.projectId !== event.projectId || agent.archived) return false;
    if (event.intent === "broadcast") return event.conversationId === agent.conversationId;
    if (event.intent === "user_dm") {
      return (event.audience.kind === "user_agent"
        ? event.audience.agentId === agentId
        : event.audience.kind === "user_agents" && event.audience.agentIds.includes(agentId)) ||
        (event.sender.kind === "agent" && event.sender.agentId === agentId);
    }
    if (event.intent === "collaboration") {
      return event.audience.agentIds.includes(agentId) || (event.sender.kind === "agent" && event.sender.agentId === agentId);
    }
    return false;
  }

  function agentCanReadRuntimeArtifact(
    artifact: RuntimeArtifactV3,
    agentId: string,
  ): boolean {
    if (store.agentCanReadProjectArtifact(artifact.projectId, artifact.id, agentId)) return true;
    if (artifact.ownerKind === "request_update") {
      const request = coordinationV3.requestForUpdate(artifact.ownerId);
      return Boolean(request && request.projectId === artifact.projectId &&
        agentCanReadRequest(request, agentId));
    }
    const runtime = coordinationV3.runtimeCommunication(artifact.ownerId);
    const payload = runtime?.payload && typeof runtime.payload === "object"
      ? runtime.payload as { communication?: unknown }
      : undefined;
    const candidate = payload?.communication ?? runtime?.payload;
    if (!candidate || typeof candidate !== "object") return false;
    const event = candidate as CommunicationEvent;
    return event.projectId === artifact.projectId && agentCanReadDocument(event, agentId);
  }

  function managedProjectArtifactAgreesWithRuntime(
    managed: ArtifactDto,
    runtime: RuntimeArtifactInputV3,
  ): boolean {
    const provenanceAgrees = runtime.originAgentId
      ? managed.agentId === runtime.originAgentId && managed.originAgentId === runtime.originAgentId &&
        managed.executionId === runtime.executionId
      : managed.agentId === managed.originAgentId && managed.executionId === undefined;
    return managed.id === runtime.id && managed.kind === "document" &&
      managed.path === `communication/${runtime.id}.md` &&
      managed.summary === runtime.title && managed.mediaType === runtime.mediaType &&
      managed.size === runtime.byteLength && provenanceAgrees;
  }

  function authoritativeCommunicationDocument(projectId: string, documentId: string) {
    if (!store.getProject(projectId)) return undefined;
    const event = store.readCommunicationEvents(projectId)
      .find((candidate) => candidate.document?.id === documentId);
    const document = event?.document;
    if (!event || !document || document.mediaType !== "text/markdown" || !document.title.trim()) return undefined;
    const validAuthor = event.sender.kind === "agent"
      ? document.authorAgentId === event.sender.agentId &&
        document.executionId === event.sender.executionId && !document.authorUserId
      : event.sender.kind === "user"
        ? document.authorUserId === event.sender.userId && !document.authorAgentId && !document.executionId
        : false;
    if (!validAuthor) return undefined;
    if (document.artifactId !== document.id) return undefined;
    const authoritative = assets.authoritativeRuntimeArtifactById(projectId, document.artifactId);
    if (!authoritative || authoritative.artifact.id !== document.id ||
        authoritative.artifact.title !== document.title ||
        authoritative.artifact.mediaType !== document.mediaType ||
        authoritative.artifact.byteLength !== document.byteLength ||
        authoritative.artifact.originAgentId !== document.authorAgentId ||
        authoritative.artifact.executionId !== document.executionId) return undefined;
    const managed = store.getProjectArtifact(projectId, document.artifactId);
    const access = store.getProjectArtifactAccess(projectId, document.artifactId);
    if (!managed || !managedProjectArtifactAgreesWithRuntime(managed, authoritative.artifact) ||
        JSON.stringify(access) !== JSON.stringify(communicationArtifactAccess(event))) return undefined;
    return { event, document: { ...document, content: authoritative.body.toString("utf8") } };
  }

  app.get<{ Params: { documentId: string } }>("/api/agent-documents/:documentId", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const capability = token ? agentMessageCapabilities.get(token) : undefined;
    const active = capability ? activeRuns.get(capability.agentId) : undefined;
    if (!capability || !capabilityOwnsAuthoritativeRun(capability, active) || active!.messageCapability !== token) {
      return reply.code(401).send({ error: "invalid or expired agent document capability" });
    }
    const agent = store.getAgent(capability.agentId);
    const found = agent ? authoritativeCommunicationDocument(agent.projectId, request.params.documentId) : undefined;
    if (!found || !agentCanReadDocument(found.event, capability.agentId)) return reply.code(404).send({ error: "document not found" });
    return { ...found.document };
  });

  return {
    agentCanReadDocument,
    agentCanReadRuntimeArtifact,
    authoritativeCommunicationDocument,
    managedProjectArtifactAgreesWithRuntime,
  };
}
