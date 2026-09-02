import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  AgentDto,
  AgentMentionBindingDto,
  AssetDto,
  CommunicationEvent,
  ConversationDto,
  CreateConversationMessageRequest,
  CreateMultiAgentDirectMessageRequest,
  MultiAgentDirectMessageResponse,
  QueuedConversationMessageDto,
} from "@ponderosa/core";
import { messageTagTokens, normalizeCanonicalText } from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
  ManagedArtifactAccess,
  WorkspaceStore,
} from "@ponderosa/agents";
import { ASSET_LIMITS, AssetError, type AssetStore } from "../assets.js";
import { renderScopedMessage, stripLeadingScopeTag } from "../agent-mentions.js";

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
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  projectDeletionInProgress: (projectId: string) => boolean;
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

function isActiveConversationAgent(
  agent: Pick<AgentDto, "projectId" | "conversationId" | "archived"> | undefined,
  conversation: Pick<ConversationDto, "id" | "projectId">,
): boolean {
  return Boolean(agent && !agent.archived &&
    agent.projectId === conversation.projectId && agent.conversationId === conversation.id);
}

function requestedRuntimeSelection(body: {
  model?: unknown;
  effort?: unknown;
  speed?: unknown;
}): { model?: string; effort?: string; speed?: string } | undefined {
  const values = [body.model, body.effort, body.speed];
  if (values.some(value =>
    value !== undefined &&
    (typeof value !== "string" || value.trim().length > 200)
  )) return undefined;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  const speed = typeof body.speed === "string" ? body.speed.trim() : "";
  return {
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
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress,
    assetMetadata,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    recordCommunication,
    reconcileRuntimeCommunicationProjections,
    projectCommunicationArtifact,
    communicationArtifactAccess,
    projectBroadcastToAgentAudits,
    projectCommunicationToAgentAudit,
    appendWorkspace,
    publishCoordinationV3Changed,
    notifyScheduler,
  } = dependencies;
  app.post<{
    Params: { id: string };
    Body: CreateConversationMessageRequest;
  }>("/api/conversations/:id/messages", async (request, reply) => {
    const messageStartedAt = performance.now();
    const requestedText = typeof request.body?.text === "string"
      ? normalizeCanonicalText(request.body.text).trim()
      : undefined;
    const rawText = requestedText ? stripLeadingScopeTag(requestedText, "broadcast") : "";
    const requestedAssets = request.body?.attachments ?? [];
    const requestedRecipientAgentMentions: unknown = request.body?.recipientAgentMentions;
    const requestedRecipientAttachments = request.body?.recipientAttachments ?? [];
    const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
    const runtimeSelection = requestedRuntimeSelection(request.body ?? {});
    if (!runtimeSelection) {
      return reply.code(400).send({ error: "model, effort, and speed must be strings of at most 200 characters" });
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
        requestedRecipientAgentMentions.some((binding) => !binding ||
          typeof binding.agentId !== "string" || !binding.agentId.trim() ||
          typeof binding.handle !== "string" || !binding.handle.trim()))) {
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
        new Set(requestedRecipientAttachments.map((entry) => entry.agentId)).size !== requestedRecipientAttachments.length ||
        requestedRecipientAttachments.some((entry) =>
          !entry || !recipientAgentIds.includes(entry.agentId) ||
          !Array.isArray(entry.attachmentIds) ||
          entry.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
          new Set(entry.attachmentIds).size !== entry.attachmentIds.length
        )) {
      return reply.code(400).send({ error: "broadcast recipient attachments must belong to unique explicit recipients" });
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must contain 1 to 200 characters" });
    const master = store.getConversation(request.params.id);
    if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
    if (projectDeletionInProgress(master.projectId)) return reply.code(409).send({ error: "Project deletion is in progress" });
    const agentIdsByHandle = new Map<string, string[]>();
    for (const agent of store.listAgents(master.projectId)) {
      if (!isActiveConversationAgent(agent, master)) continue;
      const handle = agent.handle.toLocaleLowerCase();
      if (!handle || ["broadcast", "everyone", "user"].includes(handle)) continue;
      agentIdsByHandle.set(handle, [...(agentIdsByHandle.get(handle) ?? []), agent.id]);
    }
    const authoredAgentHandles = [...new Set(messageTagTokens(requestedText ?? "")
      .map((token) => token.handle.toLocaleLowerCase())
      .filter((handle) => agentIdsByHandle.has(handle)))].sort();
    const boundHandles = recipientAgentMentions
      .map((binding) => binding.handle.toLocaleLowerCase())
      .sort();
    if (authoredAgentHandles.join("\0") !== boundHandles.join("\0")) {
      return reply.code(400).send({ error: "every targeted #Agent mention must have one canonical binding" });
    }
    if (recipientAgentMentions.some((binding) => {
      const matches = agentIdsByHandle.get(binding.handle.toLocaleLowerCase()) ?? [];
      return matches.length !== 1 || matches[0] !== binding.agentId;
    })) {
      return reply.code(400).send({ error: "Broadcast Agent mention binding is stale, ambiguous, or invalid" });
    }
    const recipientAgents = recipientAgentIds.map((agentId) => store.getAgent(agentId));
    if (recipientAgents.some((agent) => !isActiveConversationAgent(agent, master))) {
      return reply.code(404).send({ error: "broadcast recipient not found" });
    }
    if (!Array.isArray(requestedAssets) || requestedAssets.length > MAX_ATTACHMENTS_PER_MESSAGE) return reply.code(400).send({ error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} assets are allowed` });
    const validatedAssets: AssetDto[] = [];
    for (const requested of requestedAssets) {
      const owner = store.getAgent(requested.agentId);
      const stored = owner?.projectId === master.projectId && owner.conversationId === master.id
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
    const eventId = `broadcast-${createHash("sha256").update(`${master.id}\0${idempotencyKey}`).digest("hex")}`;
    const existingRuntime = coordinationV3.runtimeCommunication(eventId);
    const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
    const validationCompletedAt = performance.now();
    let prepared: Awaited<ReturnType<typeof prepareUserCommunicationText>>;
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
          communication: communicationInput,
          ...(recipientAgentIds.length ? {
            dispatch: {
              conversationId: master.id,
              sourceConversationId: master.id,
              sourceChannel: "main" as const,
              shareWithOrganization: true,
              communicationEventId: eventId,
              text: prepared.publishedText,
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
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "broadcast conflict" });
    }
    const sqliteIntakeCompletedAt = performance.now();
    const communication = recordCommunication(communicationInput);
    const canonicalAppendCompletedAt = performance.now();
    if (intake.replayed) await reconcileRuntimeCommunicationProjections({
      projectId: communicationInput.projectId,
      communicationEventId: communicationInput.eventId,
    });
    if (prepared.artifact) projectCommunicationArtifact(
      master.projectId,
      "local-operator",
      prepared.artifact,
      communicationArtifactAccess(communication),
    );
    const replayedMessage = communication && intake.replayed
      ? store.getConversationMessages(master.id).find((candidate) => candidate.communicationEventId === communication.eventId)
      : undefined;
    const message = replayedMessage ?? store.appendConversationMessage(request.params.id, {
      role: request.body.role,
      text: renderScopedMessage("broadcast", prepared.publishedText),
      attachments: validatedAssets,
    }, undefined, "main", undefined, undefined, communication?.eventId);
    const projectionCompletedAt = performance.now();
    const assetsByAgent = new Map<string, Set<string>>();
    for (const asset of [
      ...validatedAssets,
      ...[...recipientAssets.values()].flat(),
    ]) {
      const ids = assetsByAgent.get(asset.agentId) ?? new Set<string>();
      ids.add(asset.id);
      assetsByAgent.set(asset.agentId, ids);
    }
    await Promise.all([...assetsByAgent].map(([agentId, ids]) =>
      assets.associate(master.projectId, agentId, [...ids]),
    ));
    if (communication?.intent === "broadcast" && message) {
      projectBroadcastToAgentAudits(communication, [], validatedAssets);
      for (const agentId of recipientAgentIds) {
        const attachments = new Map(
          [
            ...validatedAssets,
            ...(recipientAssets.get(agentId) ?? []),
          ].map((attachment) => [attachment.id, attachment]),
        );
        projectCommunicationToAgentAudit(
          agentId,
          communication,
          renderScopedMessage("broadcast", communication.text),
          [...attachments.values()],
        );
      }
    }
    if (message) appendWorkspace({ type: "conversation_changed", projectId: master.projectId, conversationId: master.id, action: "message" });
    for (const agentId of recipientAgentIds) {
      publishCoordinationV3Changed(agentId, {
        conversationIds: [master.id],
      });
    }
    if (recipientAgentIds.length) notifyScheduler();
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
    return message ?? reply.code(404).send({ error: "conversation not found" });
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
      const rawText = request.body?.text ?? "";
      let recipients = request.body?.recipients ?? [];
      const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
      const activeRunDelivery = request.body?.activeRunDelivery ?? "steer";
      const runtimeSelection = requestedRuntimeSelection(request.body ?? {});
      if (!runtimeSelection) {
        return reply.code(400).send({ error: "model, effort, and speed must be strings of at most 200 characters" });
      }
      if (activeRunDelivery !== "steer" && activeRunDelivery !== "queue") {
        return reply.code(400).send({ error: "activeRunDelivery must be steer or queue" });
      }
      if (!rawText.trim()) return reply.code(400).send({ error: "text is required" });
      if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
      if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 100) {
        return reply.code(400).send({ error: "1 to 100 recipients are required" });
      }
      let agentIds = recipients.map((recipient) => recipient.agentId?.trim());
      if (agentIds.some((id) => !id) || new Set(agentIds).size !== agentIds.length) {
        return reply.code(400).send({ error: "recipient agent IDs must be unique" });
      }
      for (const recipient of recipients) {
        const ids = recipient.attachmentIds ?? [];
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_MESSAGE || new Set(ids).size !== ids.length) {
          return reply.code(400).send({ error: `each recipient supports at most ${MAX_ATTACHMENTS_PER_MESSAGE} unique attachments` });
        }
      }
      const master = store.getConversation(request.params.id);
      if (!master || master.archived) return reply.code(404).send({ error: "conversation not found" });
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
        else if (target.archived) unavailableRecipients.push({ agentId: recipient.agentId, reason: "archived" });
        else if (target.projectId !== master.projectId) unavailableRecipients.push({ agentId: recipient.agentId, reason: "wrong_project" });
      });
      const unavailableIds = new Set(unavailableRecipients.map(recipient => recipient.agentId));
      recipients = recipients.filter(recipient => !unavailableIds.has(recipient.agentId));
      if (recipients.length === 0) {
        return reply.code(409).send({
          error: "No addressed Agent remains available",
          unavailableRecipients,
        });
      }
      agentIds = recipients.map(recipient => recipient.agentId);
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
        const receiptKey = `multi-direct:${master.id}:${idempotencyKey}`;
        const eventId = `user-dm-${createHash("sha256").update(receiptKey).digest("hex")}`;
        const existingRuntime = coordinationV3.runtimeCommunication(eventId);
        const createdAt = existingRuntime?.createdAt ?? new Date().toISOString();
        const prepared = await prepareUserCommunicationText({
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
        const intents: ConversationDeliveryIntent[] = recipients.map((recipient) => ({
          targetAgentId: recipient.agentId, relayDepth: 0, mentionTrail: [], kind: "direct",
          ...(recipient.attachmentIds?.length ? { attachmentIds: recipient.attachmentIds } : {}),
        }));
        const intake = coordinationV3.recordRuntimeCommunication({
          id: eventId,
          projectId: master.projectId,
          sender: communication.sender,
          intent: communication.intent,
          audience: communication.audience,
          payload: {
            communication,
            dispatch: {
              conversationId: master.id,
              text: prepared.publishedText,
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
        const canonicalCommunication = recordCommunication(communication);
        if (intake.replayed) await reconcileRuntimeCommunicationProjections({
          projectId: communication.projectId,
          communicationEventId: communication.eventId,
        });
        if (prepared.artifact) projectCommunicationArtifact(
          master.projectId,
          "local-operator",
          prepared.artifact,
          communicationArtifactAccess(canonicalCommunication),
        );
        store.appendCommunicationProjection(master.projectId, {
          eventId, surface: "user_inbox", projectionKey: "local-operator", projectedAt: createdAt,
        });
        let message = store.getConversationMessageByReceiptKey(master.id, receiptKey);
        if (!message) {
          try {
            message = store.appendConversationMessage(
              master.id,
              { text: prepared.publishedText, attachments: attachmentsByAgent[0] },
              undefined,
              "main",
              intents,
              receiptKey,
              eventId,
            );
          } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid direct message" });
          }
        }
        if (!message) return reply.code(503).send({ error: "direct message projection could not be recorded; retry is safe" });
        if (!intake.replayed) {
          await Promise.all(recipients.map((recipient) => assets.associate(master.projectId, recipient.agentId, recipient.attachmentIds ?? [])));
          recipients.forEach((recipient, index) =>
            projectCommunicationToAgentAudit(recipient.agentId, communication, prepared.publishedText, attachmentsByAgent[index]),
          );
        }
        for (const recipient of recipients) {
          publishCoordinationV3Changed(recipient.agentId, {
            conversationIds: [master.id],
          });
        }
        notifyScheduler();
        const deliveryIdByAgentId = new Map(
          (intake.activations ?? []).map((activation) => [activation.agentId, activation.id]),
        );
        if (deliveryIdByAgentId.size !== recipients.length ||
            recipients.some((recipient) => !deliveryIdByAgentId.has(recipient.agentId))) {
          throw new Error("direct message activation ownership mismatch");
        }
        return {
          messageId: message.id,
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
      }
    },
  );
  app.get<{ Params: { id: string } }>("/api/conversations/:id/queued-messages", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    if (!conversation || conversation.archived) return reply.code(404).send({ error: "conversation not found" });
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
