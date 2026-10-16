import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  AgentDto,
  AgentMentionBindingDto,
  AssetDto,
  CommunicationEvent,
  ConversationDto,
  ConversationMessageDto,
  CreateConversationMessageRequest,
  CreateMultiAgentDirectMessageRequest,
  MultiAgentDirectMessageResponse,
  QueuedConversationMessageDto,
} from "@ponderosa/core";
import { messageTagTokens, normalizeCanonicalText } from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
  ManagedArtifactAccess,
  WorkspaceStore,
} from "@ponderosa/agents";
import { stableJson } from "@ponderosa/agents";
import { ASSET_LIMITS, AssetError, type AssetStore } from "../assets.js";
import { cleanupUncommittedCommunicationArtifact } from "../communication-artifacts.js";
import { leaseConversationDelivery, reconcileLeasedCommunicationReplay } from "../delivery-leases.js";
import { renderScopedMessage, stripLeadingScopeTag } from "../agent-mentions.js";

export { leaseConversationDelivery } from "../delivery-leases.js";

export interface PreparedCommunicationArtifact {
  id: string;
  role: "long_text" | "document";
  title: string;
  mediaType: "text/markdown";
  blobPath: string;
  blobHash: string;
  byteLength: number;
  originAgentId?: string;
  executionId?: string;
  createdAt: string;
  /** True only when this staging attempt created the removable authority reservation. */
  reservationCreated?: true;
}
type RuntimeArtifactInput = NonNullable<
  Parameters<CoordinationV3Store["recordRuntimeCommunication"]>[0]["artifacts"]
>[number];

type PreparedCommunication = {
  canonicalText: string;
  publishedText: string;
  artifact?: PreparedCommunicationArtifact;
  document?: CommunicationEvent["document"];
};

export interface ConversationDeliveryRouteDependencies {
  withMessagePresentation: (projectId: string, messages: ConversationMessageDto[]) => ConversationMessageDto[];
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  projectDeletionInProgress: (projectId: string) => boolean;
  agentDeletionInProgress: (agentId: string) => boolean;
  attachmentDeletionInProgress: (agentId: string, attachmentId: string) => boolean;
  assetReconciliationInProgress: (agentId: string) => boolean;
  conversationDeliveryLeases: Map<string, number>;
  agentDeliveryLeases: Map<string, number>;
  assetMetadata: (agentId: string, id: string) => ReturnType<AssetStore["read"]>;
  prepareUserCommunicationText: (input: {
    projectId: string;
    communicationId: string;
    text: string;
    createdAt: string;
  }) => Promise<PreparedCommunication>;
  runtimeArtifactMetadata: (artifact: PreparedCommunicationArtifact) => RuntimeArtifactInput;
  recordCommunication: (event: CommunicationEvent) => CommunicationEvent;
  reconcileRuntimeCommunicationProjections: (filter?: {
    projectId?: string;
    communicationEventId?: string;
  }) => Promise<number>;
  projectCommunicationArtifact: (
    projectId: string,
    fallbackAgentId: string,
    artifact: PreparedCommunicationArtifact,
    access: ManagedArtifactAccess,
  ) => void;
  communicationArtifactAccess: (communication: CommunicationEvent) => ManagedArtifactAccess;
  projectBroadcastToAgentAudits: (
    event: Extract<CommunicationEvent, { intent: "broadcast" }>,
    excludedAgentIds?: Iterable<string>,
    attachments?: AssetDto[],
  ) => void;
  projectCommunicationToAgentAudit: (
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: AssetDto[],
  ) => void;
  appendWorkspace: (event: Parameters<WorkspaceStore["append"]>[0]) => unknown;
  publishCoordinationV3Changed: (
    agentId: string,
    options?: { conversationIds?: string[] },
  ) => void;
  notifyScheduler: () => void;
}

const MAX_ATTACHMENTS_PER_MESSAGE = ASSET_LIMITS.maxAssetsPerMessage;
const AGENT_MENTION_BINDING_FIELDS = {
  projectId: true,
  handle: true,
  agentId: true,
  currentHandle: true,
  currentTitle: true,
} as const satisfies Record<Exclude<keyof AgentMentionBindingDto, "available">, true>;
const AGENT_MENTION_BINDING_KEYS = Object.keys(
  AGENT_MENTION_BINDING_FIELDS,
) as (keyof AgentMentionBindingDto)[];

function isAgentMentionBinding(value: unknown): value is AgentMentionBindingDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return keys.length === AGENT_MENTION_BINDING_KEYS.length &&
    AGENT_MENTION_BINDING_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(candidate, key) &&
      typeof candidate[key] === "string" && Boolean(candidate[key].trim()));
}

export function conversationDeliveryRequestFingerprint(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function isActiveConversationAgent(
  agent: Pick<AgentDto, "projectId" | "conversationId"> | undefined,
  conversation: Pick<ConversationDto, "id" | "projectId">,
): boolean {
  return Boolean(agent &&
    agent.projectId === conversation.projectId && agent.conversationId === conversation.id);
}

function replayedDirectRecipient(
  coordinationV3: CoordinationV3Store,
  projectId: string,
  activationByAgentId: ReadonlyMap<string, string>,
  agentId: string,
): MultiAgentDirectMessageResponse["recipients"][number] {
  const deliveryId = activationByAgentId.get(agentId);
  if (!deliveryId) return { agentId, queued: true, state: "preparing" };
  const activation = coordinationV3.activation(deliveryId, projectId);
  if (!activation) return { agentId, queued: true, deliveryId, state: "preparing" };
  if (activation.state === "pending" || activation.state === "retry_pending") {
    return {
      agentId,
      queued: true,
      deliveryId,
      state: activation.state === "retry_pending" ? "retrying" : "queued",
    };
  }
  if (activation.state === "attached") {
    return { agentId, queued: false, deliveryId, state: "started" };
  }
  return {
    agentId,
    queued: false,
    deliveryId,
    state: activation.state === "failed" || activation.state === "outcome_unknown" ||
      activation.state === "cancelled"
      ? activation.state
      : "delivered",
  };
}

function requestedRuntimeSelection(body: {
  engine?: unknown;
  model?: unknown;
  effort?: unknown;
  speed?: unknown;
}): { engine?: string; model?: string; effort?: string; speed?: string } | undefined {
  const values = [body.engine, body.model, body.effort, body.speed];
  if (values.some(value =>
    value !== undefined &&
    (typeof value !== "string" || value.trim().length > 200)
  )) return undefined;
  const engine = typeof body.engine === "string" ? body.engine.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  const speed = typeof body.speed === "string" ? body.speed.trim() : "";
  return {
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
  };
}

export function registerConversationDeliveryRoutes(
  app: FastifyInstance,
  dependencies: ConversationDeliveryRouteDependencies,
): void {
  const {
    withMessagePresentation,
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress,
    agentDeletionInProgress,
    attachmentDeletionInProgress = () => false,
    assetReconciliationInProgress = () => false,
    conversationDeliveryLeases,
    agentDeliveryLeases,
    assetMetadata,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    reconcileRuntimeCommunicationProjections,
    appendWorkspace,
    publishCoordinationV3Changed,
    notifyScheduler,
  } = dependencies;
  function presentedMessage(projectId: string, message: ConversationMessageDto | undefined): ConversationMessageDto | undefined {
    if (!message) return undefined;
    try {
      return withMessagePresentation(projectId, [message])[0];
    } catch (error) {
      // Intake is already durable. Use the existing committed/recovering response,
      // never a send failure or an incomplete message that looks like a deleted recipient.
      app.log.error({ err: error, communicationEventId: message.communicationEventId }, "Committed message presentation unavailable");
      return undefined;
    }
  }
  app.post<{
    Params: { id: string };
    Body: CreateConversationMessageRequest;
  }>("/api/conversations/:id/messages", async (request, reply) => {
    const messageStartedAt = performance.now();
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => ![
          "text", "attachments", "recipientAgentMentions", "recipientAttachments",
          "engine", "model", "effort", "speed", "activeRunDelivery", "idempotencyKey",
        ].includes(key))) {
      return reply.code(400).send({ error: "message body contains unknown or invalid fields" });
    }
    if (typeof request.body?.text !== "string") {
      return reply.code(400).send({ error: "text must be a string" });
    }
    if (Object.prototype.hasOwnProperty.call(request.body, "role")) {
      return reply.code(400).send({ error: "role is not supported for user messages" });
    }
    const requestedText = normalizeCanonicalText(request.body.text).trim();
    const rawText = requestedText ? stripLeadingScopeTag(requestedText, "broadcast") : "";
    const requestedAssets = request.body?.attachments ?? [];
    const requestedRecipientAgentMentions: unknown = request.body?.recipientAgentMentions;
    const requestedRecipientAttachments = request.body?.recipientAttachments ?? [];
    const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
    const runtimeSelection = requestedRuntimeSelection(request.body ?? {});
    if (!runtimeSelection) {
      return reply.code(400).send({ error: "engine, model, effort, and speed must be strings of at most 200 characters" });
    }
    if (!rawText && (!Array.isArray(requestedAssets) || requestedAssets.length === 0)) {
      return reply.code(400).send({ error: "broadcast text or an attachment is required" });
    }
    if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
      return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
    }
    if (requestedRecipientAgentMentions !== undefined &&
        (!Array.isArray(requestedRecipientAgentMentions) ||
        requestedRecipientAgentMentions.length > 100 ||
        requestedRecipientAgentMentions.some((binding) => !isAgentMentionBinding(binding)))) {
      return reply.code(400).send({ error: "Broadcast Agent mention bindings must be unique and limited to 100" });
    }
    const recipientAgentMentions =
      (requestedRecipientAgentMentions ?? []) as AgentMentionBindingDto[];
    const recipientAgentIds = recipientAgentMentions.map((binding) => binding.agentId);
    if (
        new Set(recipientAgentIds).size !== recipientAgentIds.length ||
        new Set(recipientAgentMentions.map((binding) => binding.handle.toLocaleLowerCase())).size !==
          recipientAgentMentions.length
    ) {
      return reply.code(400).send({ error: "Broadcast Agent mention bindings must be unique and limited to 100" });
    }
    if (!Array.isArray(requestedRecipientAttachments) ||
        requestedRecipientAttachments.length > recipientAgentIds.length ||
        requestedRecipientAttachments.some((entry) =>
          !entry || typeof entry !== "object" || Array.isArray(entry) ||
          Object.keys(entry).some((key) => !["agentId", "attachmentIds"].includes(key)) ||
          typeof entry.agentId !== "string" || !recipientAgentIds.includes(entry.agentId) ||
          !Array.isArray(entry.attachmentIds) ||
          entry.attachmentIds.some((id) => typeof id !== "string" || !id) ||
          entry.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
          new Set(entry.attachmentIds).size !== entry.attachmentIds.length) ||
        new Set(requestedRecipientAttachments.map((entry) => entry.agentId)).size !== requestedRecipientAttachments.length) {
      return reply.code(400).send({ error: "broadcast recipient attachments must belong to unique explicit recipients" });
    }
    if (typeof request.body?.idempotencyKey !== "string") {
      return reply.code(400).send({ error: "idempotencyKey must contain 1 to 200 characters" });
    }
    const idempotencyKey = request.body.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must contain 1 to 200 characters" });
    if (!Array.isArray(requestedAssets) ||
        requestedAssets.length > MAX_ATTACHMENTS_PER_MESSAGE ||
        requestedAssets.some((asset) => !asset || typeof asset !== "object" || Array.isArray(asset) ||
          Object.keys(asset).some((key) => ![
            "id", "agentId", "conversationId", "name", "mediaType", "size", "width", "height", "sha256",
            "state", "createdAt", "url", "downloadUrl", "previewUrl", "unavailable",
          ].includes(key)) ||
          typeof asset.id !== "string" || !asset.id ||
          typeof asset.agentId !== "string" || !asset.agentId ||
          (asset.conversationId !== undefined &&
            (asset.conversationId !== request.params.id || asset.agentId !== request.params.id)))) {
      return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} valid assets are allowed` });
    }
    const eventId = `broadcast-${createHash("sha256").update(`${request.params.id}\0${idempotencyKey}`).digest("hex")}`;
    const requestFingerprint = conversationDeliveryRequestFingerprint({
      version: 1,
      kind: "broadcast",
      conversationId: request.params.id,
      text: requestedText,
      recipients: recipientAgentMentions.map(({ agentId, handle }) => ({ agentId, handle })),
      attachments: requestedAssets.map((asset) => ({ agentId: asset.agentId, id: asset.id,
        ...(asset.conversationId ? { conversationId: asset.conversationId } : {}) })),
      recipientAttachments: requestedRecipientAttachments,
      activeRunDelivery,
      runtimeSelection,
    });
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const existingPayload = existingRuntime?.payload as {
      requestFingerprint?: string;
      communication?: CommunicationEvent;
      dispatch?: { recipients?: Array<{ agentId?: string; attachments?: Array<{ id?: string }> }> };
    } | undefined;
    if (existingPayload?.requestFingerprint) {
      if (existingPayload.requestFingerprint !== requestFingerprint) {
        return reply.code(409).send({ error: "runtime communication ID collision" });
      }
      const replayAgentIds = [...new Set([
        ...(existingPayload.dispatch?.recipients ?? []).flatMap((recipient) =>
          typeof recipient.agentId === "string" && recipient.agentId.trim() ? [recipient.agentId.trim()] : []),
        ...(existingPayload.communication?.attachments ?? []).flatMap((attachment) =>
          attachment.conversationId ? [] : [attachment.agentId]),
      ])];
      const replay = await reconcileLeasedCommunicationReplay({
        conversationLeases: conversationDeliveryLeases,
        agentLeases: agentDeliveryLeases,
        conversationId: request.params.id,
        agentIds: replayAgentIds,
        projectId: existingRuntime!.projectId,
        communicationEventId: eventId,
        reconcile: reconcileRuntimeCommunicationProjections,
        read: () => store.getProjectedConversationMessageById(request.params.id, "main", eventId),
      });
      if (!replay.recovered) return reply.code(202).send({
        communicationEventId: eventId,
        committed: true,
        recovering: true,
        replayed: true,
      });
      const replayedMessage = replay.value;
      return presentedMessage(existingRuntime!.projectId, replayedMessage) ?? reply.code(202).send({
        communicationEventId: eventId,
        committed: true,
        recovering: true,
        replayed: true,
      });
    }
    const master = store.getConversation(request.params.id);
    if (!master) return reply.code(404).send({ error: "conversation not found" });
    if (projectDeletionInProgress(master.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
    const agentIdsByHandle = new Map<string, string[]>();
    for (const agent of store.listAgents(master.projectId)) {
      if (!isActiveConversationAgent(agent, master)) continue;
      const handle = agent.handle.toLocaleLowerCase();
      if (!handle || ["broadcast", "everyone", "user"].includes(handle)) continue;
      agentIdsByHandle.set(handle, [...(agentIdsByHandle.get(handle) ?? []), agent.id]);
    }
    const boundHandles = recipientAgentMentions
      .map((binding) => binding.handle.toLocaleLowerCase())
      .sort();
    const boundHandleSet = new Set(boundHandles);
    const authoredAgentHandles = [...new Set(messageTagTokens(requestedText ?? "")
      .map((token) => token.handle.toLocaleLowerCase())
      .filter((handle) => boundHandleSet.has(handle) || agentIdsByHandle.has(handle)))].sort();
    if (authoredAgentHandles.join("\0") !== boundHandles.join("\0")) {
      return reply.code(400).send({ error: "every targeted #Agent mention must have one canonical binding" });
    }
    if (recipientAgentMentions.some((binding) => {
      const agent = store.getAgent(binding.agentId);
      return binding.projectId !== master.projectId ||
        !isActiveConversationAgent(agent, master);
    })) {
      return reply.code(400).send({ error: "Broadcast Agent mention binding is stale, ambiguous, or invalid" });
    }
    const recipientAgents = recipientAgentIds.map((agentId) => store.getAgent(agentId));
    if (recipientAgents.some((agent) => !isActiveConversationAgent(agent, master))) {
      return reply.code(404).send({ error: "broadcast recipient not found" });
    }
    const attachmentOwnerIds = requestedAssets.flatMap((asset) => asset.conversationId ? [] : [asset.agentId]);
    const attachmentOwners = attachmentOwnerIds.map((agentId) => store.getAgent(agentId));
    if (attachmentOwners.some((agent) => !isActiveConversationAgent(agent, master))) {
      return reply.code(404).send({ error: "asset owner not found" });
    }
    const leasedAgentIds = [...new Set([...recipientAgentIds, ...attachmentOwnerIds])];
    const attachmentUserIds = [...new Set([
      ...attachmentOwnerIds,
      ...requestedRecipientAttachments.map((entry) => entry.agentId),
    ])];
    if (requestedAssets.some((asset) => attachmentDeletionInProgress(asset.agentId, asset.id)) ||
        requestedRecipientAttachments.some((entry) => entry.attachmentIds.some((id) =>
          attachmentDeletionInProgress(entry.agentId, id)))) {
      return reply.code(409).send({ error: "Asset deletion is in progress" });
    }
    if (attachmentUserIds.some(assetReconciliationInProgress)) {
      return reply.code(409).send({ error: "Asset cleanup is in progress" });
    }
    if (leasedAgentIds.some(agentDeletionInProgress)) {
      return reply.code(409).send({ error: "Agent deletion is in progress" });
    }
    const releaseDeliveryLease = leaseConversationDelivery(
      conversationDeliveryLeases,
      agentDeliveryLeases,
      master.id,
      leasedAgentIds,
    );
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
    let artifactCommitted = false;
    try {
    const validatedAssets: AssetDto[] = [];
    for (const requested of requestedAssets) {
      const owner = requested.conversationId ? undefined : store.getAgent(requested.agentId);
      const stored = requested.conversationId === master.id && requested.agentId === master.id
        ? await assetMetadata(master.id, requested.id)
        : owner?.projectId === master.projectId && owner.conversationId === master.id
          ? await assetMetadata(owner.id, requested.id) : undefined;
      if (!stored) return reply.code(404).send({ error: "asset not found" });
      const { projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile, associatedAt: _associatedAt, ...publicAsset } = stored;
      validatedAssets.push({ ...publicAsset, state: "associated" });
    }
    if (validatedAssets.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) return reply.code(413).send({ error: "message asset quota exceeded" });
    const requestedRecipientAttachmentIds = new Map(
      requestedRecipientAttachments.map((entry) => [entry.agentId, entry.attachmentIds]),
    );
    const recipientAssets = new Map<string, AssetDto[]>();
    for (const agentId of recipientAgentIds) {
      const attached = await Promise.all(
        (requestedRecipientAttachmentIds.get(agentId) ?? []).map((id) =>
          assetMetadata(agentId, id),
        ),
      );
      if (attached.some((item) => !item || item.agentId !== agentId)) {
        return reply.code(404).send({ error: "broadcast recipient attachment not found" });
      }
      const publicAssets = (attached as NonNullable<(typeof attached)[number]>[]).map((item) => {
        const {
          projectId: _projectId,
          originalFile: _originalFile,
          previewFile: _previewFile,
          associatedAt: _associatedAt,
          ...publicAsset
        } = item;
        return { ...publicAsset, state: "associated" as const };
      }) as AssetDto[];
      if (publicAssets.reduce((sum, item) => sum + item.size, 0) > ASSET_LIMITS.maxMessageBytes) {
        return reply.code(413).send({ error: "broadcast recipient attachment quota exceeded" });
      }
      recipientAssets.set(agentId, publicAssets);
    }
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
    const validationCompletedAt = performance.now();
    try {
      prepared = await prepareUserCommunicationText({ projectId: master.projectId, communicationId: eventId, text: rawText, createdAt });
    } catch (error) {
      const status = error instanceof AssetError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "long-text artifact staging failed" });
    }
    const artifactPreparationCompletedAt = performance.now();
    const communicationInput: CommunicationEvent = {
      eventId,
      schemaVersion: 2,
      projectId: master.projectId,
      conversationId: master.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: master.projectId },
      text: prepared.publishedText,
      ...(recipientAgentIds.length ? {
        identity: {
          senderLabel: "User",
          recipientLabels: Object.fromEntries(recipientAgents.map(agent => [agent!.id, agent!.title])),
          recipientHandles: Object.fromEntries(recipientAgents.map(agent => [agent!.id, agent!.handle])),
        },
      } : {}),
      ...(validatedAssets.length ? { attachments: validatedAssets } : {}),
      ...(prepared.document ? { document: prepared.document } : {}),
      createdAt,
      idempotencyKey: `broadcast:${master.id}:${idempotencyKey}`,
    };
    let intake;
    try {
      intake = coordinationV3.recordRuntimeCommunication({
        id: eventId,
        projectId: master.projectId,
        sender: communicationInput.sender,
        intent: communicationInput.intent,
        audience: communicationInput.audience,
        payload: {
          requestFingerprint,
          communication: communicationInput,
          ...(recipientAgentIds.length ? {
            dispatch: {
              conversationId: master.id,
              sourceConversationId: master.id,
              sourceChannel: "main" as const,
              shareWithOrganization: true,
              communicationEventId: eventId,
              text: prepared.publishedText,
              conversationText: renderScopedMessage("broadcast", prepared.publishedText),
              conversationAttachmentIds: validatedAssets.map((attachment) => attachment.id),
              ...(prepared.artifact ? {
                artifactId: prepared.artifact.id,
                resultRef: `ponderosa://artifact/${prepared.artifact.id}`,
              } : {}),
              activeRunDelivery,
              ...runtimeSelection,
              recipients: recipientAgentIds.map((agentId) => ({
                agentId,
                attachments: (recipientAssets.get(agentId) ?? []).map((item) => ({
                  id: item.id,
                  name: item.name,
                  mediaType: item.mediaType,
                  size: item.size,
                })),
              })),
            },
          } : {}),
        },
        ...(prepared.artifact ? { artifacts: [runtimeArtifactMetadata(prepared.artifact)] } : {}),
        ...(recipientAgentIds.length ? {
          activations: recipientAgentIds.map((agentId, index) => ({
            agentId,
            kind: "human_message" as const,
            priority: 100,
            dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" as const : "next_run" as const,
            promptClass: "human" as const,
            dedupeKey: `communication:${eventId}:${agentId}:${index}`,
          })),
        } : {}),
        now: createdAt,
      });
      artifactCommitted = true;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "broadcast conflict" });
    }
    const sqliteIntakeCompletedAt = performance.now();
    try {
      await reconcileRuntimeCommunicationProjections({
        projectId: communicationInput.projectId,
        communicationEventId: communicationInput.eventId,
      });
    } catch {
      try { if (recipientAgentIds.length) notifyScheduler(); } catch { /* recovery is durable */ }
      return reply.code(202).send({
        communicationEventId: communicationInput.eventId,
        committed: true,
        recovering: true,
        replayed: intake.replayed,
      });
    }
    const canonicalAppendCompletedAt = performance.now();
    let message;
    try {
      message = store.getProjectedConversationMessageById(master.id, "main", communicationInput.eventId);
    } catch {
      try { if (recipientAgentIds.length) notifyScheduler(); } catch { /* recovery is durable */ }
      return reply.code(202).send({
        communicationEventId: communicationInput.eventId,
        committed: true,
        recovering: true,
        replayed: intake.replayed,
      });
    }
    const projectionCompletedAt = performance.now();
    try {
      if (message) appendWorkspace({ type: "conversation_changed", projectId: master.projectId, conversationId: master.id, action: "message" });
    } catch { /* canonical communication remains durable; clients can refresh */ }
    try {
      for (const agentId of recipientAgentIds) {
        publishCoordinationV3Changed(agentId, {
          conversationIds: [master.id],
        });
      }
      if (recipientAgentIds.length) notifyScheduler();
    } catch { /* durable broadcast remains authoritative */ }
    const completedAt = performance.now();
    const phase = (end: number, start: number) => Math.round((end - start) * 10) / 10;
    reply.header("Server-Timing", [
      `validation;dur=${phase(validationCompletedAt, messageStartedAt)}`,
      `artifact;dur=${phase(artifactPreparationCompletedAt, validationCompletedAt)}`,
      `sqlite;dur=${phase(sqliteIntakeCompletedAt, artifactPreparationCompletedAt)}`,
      `canonical;dur=${phase(canonicalAppendCompletedAt, sqliteIntakeCompletedAt)}`,
      `projection;dur=${phase(projectionCompletedAt, canonicalAppendCompletedAt)}`,
      `publish;dur=${phase(completedAt, projectionCompletedAt)}`,
      `total;dur=${phase(completedAt, messageStartedAt)}`,
    ].join(", "));
    app.log.debug({
      durationMs: phase(completedAt, messageStartedAt),
      validationMs: phase(validationCompletedAt, messageStartedAt),
      artifactMs: phase(artifactPreparationCompletedAt, validationCompletedAt),
      sqliteMs: phase(sqliteIntakeCompletedAt, artifactPreparationCompletedAt),
      canonicalMs: phase(canonicalAppendCompletedAt, sqliteIntakeCompletedAt),
      projectionMs: phase(projectionCompletedAt, canonicalAppendCompletedAt),
      publishMs: phase(completedAt, projectionCompletedAt),
      recipientCount: recipientAgentIds.length,
      replayed: intake.replayed,
      passive: recipientAgentIds.length === 0,
    }, "conversation message persisted");
      return presentedMessage(master.projectId, message) ?? reply.code(202).send({
        communicationEventId: communicationInput.eventId,
        committed: true,
        recovering: true,
        replayed: intake.replayed,
      });
    } finally {
      if (!artifactCommitted) {
        cleanupUncommittedCommunicationArtifact({
          projectId: master.projectId,
          artifact: prepared?.artifact,
          runtimeArtifact: (artifactId) => coordinationV3.runtimeArtifact(artifactId),
          removeRuntimeArtifactReservation: (projectId, artifactId) =>
            assets.removeRuntimeArtifactReservation(projectId, artifactId),
        });
      }
      releaseDeliveryLease();
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>("/api/conversations/:id/next-run-deliveries", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "conversation not found" });
    const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 50" });
    }
    return {
      receipts: coordinationV3.operatorNextRunDeliveryReceipts({
        projectId: conversation.projectId,
        conversationId: conversation.id,
        publisherUserId: "local-operator",
        limit,
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: CreateMultiAgentDirectMessageRequest }>(
    "/api/conversations/:id/direct-messages",
    async (request, reply) => {
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
          Object.keys(request.body).some((key) => ![
            "text", "recipients", "idempotencyKey", "activeRunDelivery", "engine", "model", "effort", "speed",
          ].includes(key))) {
        return reply.code(400).send({ error: "direct message body contains unknown or invalid fields" });
      }
      const rawText = request.body?.text;
      let recipients = request.body?.recipients ?? [];
      if (typeof rawText !== "string") return reply.code(400).send({ error: "text is required" });
      if (typeof request.body?.idempotencyKey !== "string") {
        return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      }
      const idempotencyKey = request.body.idempotencyKey.trim();
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      const runtimeSelection = requestedRuntimeSelection(request.body ?? {});
      if (!runtimeSelection) {
        return reply.code(400).send({ error: "engine, model, effort, and speed must be strings of at most 200 characters" });
      }
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      if (!rawText.trim()) return reply.code(400).send({ error: "text is required" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 100 ||
          recipients.some((recipient) => !recipient || typeof recipient !== "object" || Array.isArray(recipient) ||
            Object.keys(recipient).some((key) => !["agentId", "attachmentIds"].includes(key)) ||
            typeof recipient.agentId !== "string" || !recipient.agentId.trim())) {
        return reply.code(400).send({ error: "1 to 100 recipients are required" });
      }
      recipients = recipients.map((recipient) => ({
        ...recipient,
        agentId: recipient.agentId.trim(),
      }));
      let agentIds = recipients.map((recipient) => recipient.agentId);
      if (agentIds.some((id) => !id) || new Set(agentIds).size !== agentIds.length) {
        return reply.code(400).send({ error: "recipient agent IDs must be unique" });
      }
      for (const recipient of recipients) {
        const ids = recipient.attachmentIds ?? [];
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id) ||
            ids.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(ids).size !== ids.length) {
          return reply.code(400).send({ error: `each recipient supports at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique attachments` });
        }
      }
      const receiptKey = `multi-direct:${request.params.id}:${idempotencyKey}`;
      const eventId = `user-dm-${createHash("sha256").update(receiptKey).digest("hex")}`;
      const requestFingerprint = conversationDeliveryRequestFingerprint({
        version: 1,
        kind: "direct",
        conversationId: request.params.id,
        text: rawText,
        recipients: recipients.map((recipient, index) => ({
          agentId: agentIds[index],
          attachmentIds: recipient.attachmentIds ?? [],
        })),
        activeRunDelivery,
        runtimeSelection,
      });
      const existingRuntime = coordinationV3.runtimeCommunication(eventId);
      const existingPayload = existingRuntime?.payload as {
        requestFingerprint?: string;
        unavailableRecipients?: MultiAgentDirectMessageResponse["unavailableRecipients"];
        communication?: CommunicationEvent;
        dispatch?: { recipients?: Array<{ agentId?: string; attachments?: Array<{ id?: string }> }> };
      } | undefined;
      if (existingPayload?.requestFingerprint) {
        if (existingPayload.requestFingerprint !== requestFingerprint) {
          return reply.code(409).send({ error: "runtime communication ID collision" });
        }
        const activationByAgentId = new Map(
          (existingRuntime?.activations ?? []).map((activation) => [activation.agentId, activation.id]),
        );
        const dispatchRecipients = (existingPayload.dispatch?.recipients ?? [])
          .flatMap((recipient) => recipient.agentId ? [recipient.agentId] : []);
        const audience = existingPayload.communication?.audience;
        const originalRecipients = dispatchRecipients.length
          ? dispatchRecipients
          : audience?.kind === "user_agents"
            ? [...audience.agentIds]
            : audience?.kind === "user_agent"
              ? [audience.agentId]
              : agentIds;
        const recoveringResponse = (messageId = eventId) => ({
          messageId,
          replayed: true,
          recipients: originalRecipients.map((agentId) => replayedDirectRecipient(
            coordinationV3,
            existingRuntime!.projectId,
            activationByAgentId,
            agentId,
          )),
          ...(existingPayload.unavailableRecipients?.length ? {
            unavailableRecipients: existingPayload.unavailableRecipients,
          } : {}),
          communicationEventId: eventId,
          committed: true,
          recovering: true,
        });
        const replayAgentIds = [...new Set((existingPayload.dispatch?.recipients ?? []).flatMap((recipient) =>
          typeof recipient.agentId === "string" && recipient.agentId.trim() ? [recipient.agentId.trim()] : []))];
        const replay = await reconcileLeasedCommunicationReplay({
          conversationLeases: conversationDeliveryLeases,
          agentLeases: agentDeliveryLeases,
          conversationId: request.params.id,
          agentIds: replayAgentIds,
          projectId: existingRuntime!.projectId,
          communicationEventId: eventId,
          reconcile: reconcileRuntimeCommunicationProjections,
          read: () => store.getConversationMessageByReceiptKey(request.params.id, receiptKey),
        });
        if (!replay.recovered) return reply.code(202).send(recoveringResponse());
        const message = replay.value;
        if (!message) return reply.code(202).send(recoveringResponse());
        const presented = presentedMessage(existingRuntime!.projectId, message);
        if (!presented) return reply.code(202).send(recoveringResponse(message.id));
        return {
          messageId: message.id,
          message: presented,
          replayed: true,
          recipients: originalRecipients.map((agentId) => replayedDirectRecipient(
            coordinationV3,
            existingRuntime!.projectId,
            activationByAgentId,
            agentId,
          )),
          ...(existingPayload.unavailableRecipients?.length ? {
            unavailableRecipients: existingPayload.unavailableRecipients,
          } : {}),
        } satisfies MultiAgentDirectMessageResponse;
      }
      const master = store.getConversation(request.params.id);
      if (!master) return reply.code(404).send({ error: "conversation not found" });
      if (projectDeletionInProgress(master.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
      const targets = agentIds.map((agentId) => store.getAgent(agentId));
      if (targets.some((target) =>
        target && target.projectId === master.projectId && target.conversationId !== master.id
      )) {
        return reply.code(409).send({ error: "Addressed Agents must belong to this Chat" });
      }
      const unavailableRecipients: NonNullable<MultiAgentDirectMessageResponse["unavailableRecipients"]> = [];
      recipients.forEach((recipient, index) => {
        const target = targets[index];
        if (!target) unavailableRecipients.push({ agentId: recipient.agentId, reason: "missing" });
        else if (target.projectId !== master.projectId) unavailableRecipients.push({ agentId: recipient.agentId, reason: "wrong_project" });
      });
      const unavailableIds = new Set(unavailableRecipients.map(recipient => recipient.agentId));
      const skippedRecipientAttachments = recipients.flatMap((recipient, index) => {
        const target = targets[index];
        return unavailableIds.has(recipient.agentId) && target && recipient.attachmentIds?.length
          ? [{ projectId: target.projectId, agentId: target.id, attachmentIds: recipient.attachmentIds }]
          : [];
      });
      recipients = recipients.filter(recipient => !unavailableIds.has(recipient.agentId));
      if (recipients.length === 0) {
        return reply.code(409).send({
          error: "No addressed Agent remains available",
          unavailableRecipients,
        });
      }
      agentIds = recipients.map(recipient => recipient.agentId);
      if (recipients.some((recipient) => (recipient.attachmentIds ?? []).some((id) =>
        attachmentDeletionInProgress(recipient.agentId, id)))) {
        return reply.code(409).send({ error: "Asset deletion is in progress" });
      }
      if (recipients.some((recipient) => (recipient.attachmentIds?.length ?? 0) > 0 &&
          assetReconciliationInProgress(recipient.agentId))) {
        return reply.code(409).send({ error: "Asset cleanup is in progress" });
      }
      if (agentIds.some(agentDeletionInProgress)) {
        return reply.code(409).send({ error: "Agent deletion is in progress" });
      }
      const releaseDeliveryLease = leaseConversationDelivery(
        conversationDeliveryLeases,
        agentDeliveryLeases,
        master.id,
        agentIds,
      );
      let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>> | undefined;
      let artifactCommitted = false;
      try {
        const attachmentsByAgent = await Promise.all(recipients.map(async (recipient) => {
          const attached = await Promise.all((recipient.attachmentIds ?? []).map((id) => assetMetadata(recipient.agentId, id)));
          if (attached.some((item) => !item || item.agentId !== recipient.agentId)) throw new AssetError(404, "direct message attachment not found");
          if (attached.reduce((sum, item) => sum + (item?.size ?? 0), 0) > ASSET_LIMITS.maxMessageBytes) {
            throw new AssetError(413, "message asset quota exceeded");
          }
          return (attached as NonNullable<(typeof attached)[number]>[]).map((item) => {
            const {
              projectId: _projectId, originalFile: _originalFile, previewFile: _previewFile,
              associatedAt: _associatedAt, ...publicAsset
            } = item;
            return { ...publicAsset, state: "associated" as const };
          }) as AssetDto[];
        }));
        const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
        prepared = await prepareUserCommunicationText({
          projectId: master.projectId, communicationId: eventId, text: rawText, createdAt,
        });
        const communication: CommunicationEvent = {
          eventId, schemaVersion: 2, projectId: master.projectId, conversationId: master.id,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: { kind: "user_agents", userId: "local-operator", agentIds: agentIds as [string, ...string[]] },
          text: prepared.publishedText,
          ...(attachmentsByAgent.some((items) => items.length) ? { attachments: attachmentsByAgent.flat() } : {}),
          ...(prepared.document ? { document: prepared.document } : {}),
          createdAt, idempotencyKey: receiptKey,
        };
        const intake = coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: master.projectId,
          sender: communication.sender,
          intent: communication.intent,
          audience: communication.audience,
          payload: {
            requestFingerprint,
            ...(unavailableRecipients.length ? { unavailableRecipients } : {}),
            ...(skippedRecipientAttachments.length ? { skippedRecipientAttachments } : {}),
            communication,
            dispatch: {
              conversationId: master.id,
              text: prepared.publishedText,
              conversationAttachmentIds: (attachmentsByAgent[0] ?? []).map((attachment) => attachment.id),
              ...(prepared.artifact ? {
                artifactId: prepared.artifact.id,
                resultRef: `ponderosa://artifact/${prepared.artifact.id}`,
              } : {}),
              activeRunDelivery,
              ...runtimeSelection,
              recipients: recipients.map((recipient, index) => ({
                agentId: recipient.agentId,
                attachments: (attachmentsByAgent[index] ?? []).map((item) => ({
                  id: item.id, name: item.name, mediaType: item.mediaType, size: item.size,
                })),
              })),
            },
          },
          ...(prepared.artifact ? { artifacts: [runtimeArtifactMetadata(prepared.artifact)] } : {}),
          activations: recipients.map((recipient, index) => ({
            agentId: recipient.agentId,
            kind: "human_message",
            priority: 100,
            dispatchPolicy: activeRunDelivery === "steer" ? "steer_or_run" : "next_run",
            promptClass: "human",
            dedupeKey: `communication:${eventId}:${recipient.agentId}:${index}`,
          })),
          now: createdAt,
        });
        artifactCommitted = true;
        const deliveryIdByAgentId = new Map(
          (intake.activations ?? []).map((activation) => [activation.agentId, activation.id]),
        );
        const recoveringResponse = (): MultiAgentDirectMessageResponse & {
          communicationEventId: string; committed: true; recovering: true;
        } => ({
          messageId: communication.eventId,
          replayed: intake.replayed,
          recipients: recipients.map((recipient) => ({
            agentId: recipient.agentId,
            queued: true,
            deliveryId: deliveryIdByAgentId.get(recipient.agentId),
            state: "queued",
          })),
          ...(unavailableRecipients.length ? { unavailableRecipients } : {}),
          communicationEventId: communication.eventId,
          committed: true,
          recovering: true,
        });
        try {
          await reconcileRuntimeCommunicationProjections({
            projectId: communication.projectId,
            communicationEventId: communication.eventId,
          });
        } catch {
          try { notifyScheduler(); } catch { /* recovery is durable */ }
          return reply.code(202).send(recoveringResponse());
        }
        let message;
        try {
          message = store.getConversationMessageByReceiptKey(master.id, receiptKey);
        } catch {
          try { notifyScheduler(); } catch { /* recovery is durable */ }
          return reply.code(202).send(recoveringResponse());
        }
        if (!message) return reply.code(202).send(recoveringResponse());
        try {
          for (const recipient of recipients) {
            publishCoordinationV3Changed(recipient.agentId, {
              conversationIds: [master.id],
            });
          }
          notifyScheduler();
        } catch { /* durable direct message remains authoritative */ }
        if (deliveryIdByAgentId.size !== recipients.length ||
            recipients.some((recipient) => !deliveryIdByAgentId.has(recipient.agentId))) {
          return reply.code(202).send(recoveringResponse());
        }
        const presented = presentedMessage(master.projectId, message);
        if (!presented) return reply.code(202).send(recoveringResponse());
        return {
          messageId: message.id,
          message: presented,
          replayed: intake.replayed,
          recipients: recipients.map((recipient) => ({
            agentId: recipient.agentId,
            queued: true,
            deliveryId: deliveryIdByAgentId.get(recipient.agentId),
            state: "queued" as const,
          })),
          ...(unavailableRecipients.length ? { unavailableRecipients } : {}),
        } satisfies MultiAgentDirectMessageResponse;
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.statusCode).send({ error: error.message });
        return reply.code(409).send({ error: error instanceof Error ? error.message : "direct message conflict" });
      } finally {
        if (!artifactCommitted) {
          cleanupUncommittedCommunicationArtifact({
            projectId: master.projectId,
            artifact: prepared?.artifact,
            runtimeArtifact: (artifactId) => coordinationV3.runtimeArtifact(artifactId),
            removeRuntimeArtifactReservation: (projectId, artifactId) =>
              assets.removeRuntimeArtifactReservation(projectId, artifactId),
          });
        }
        releaseDeliveryLease();
      }
    },
  );
  app.get<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "conversation not found" });
    const pending = coordinationV3.pendingActivations(conversation.projectId);
    const perAgentPosition = new Map<string, number>();
    return pending.flatMap((activation) => {
      if (activation.dispatchPolicy !== "next_run") return [];
      const payload = activation.payload && typeof activation.payload === "object"
        ? activation.payload as { communication?: CommunicationEvent; dispatch?: { conversationId?: string; text?: string } }
        : undefined;
      const communication = payload?.communication;
      if (payload?.dispatch?.conversationId !== conversation.id ||
          communication?.sender.kind !== "user" || communication.sender.userId !== "local-operator") return [];
      const position = (perAgentPosition.get(activation.agentId) ?? 0) + 1;
      perAgentPosition.set(activation.agentId, position);
      const message = store.getConversationMessages(conversation.id, "main")
        .find((candidate) => candidate.communicationEventId === communication.eventId);
      return [{
        deliveryId: activation.id,
        messageId: message?.id ?? communication.eventId,
        conversationId: conversation.id,
        targetAgentId: activation.agentId,
        text: payload.dispatch?.text ?? message?.text ?? communication.text,
        position,
        createdAt: activation.createdAt,
        status: "queued",
      } satisfies QueuedConversationMessageDto];
    });
  });
}
