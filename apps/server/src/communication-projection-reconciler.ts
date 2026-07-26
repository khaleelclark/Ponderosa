import {
  deriveCommunicationBehavior,
  type CommunicationEvent,
  type ImageAttachmentDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  ConversationDeliveryIntent,
  CoordinationV3Store,
} from "@ponderosa/agents";
import type { AssetStore, AuthoritativeRuntimeAttachment } from "./assets.js";
import { agentMentionHandle, renderScopedMessage } from "./agent-mentions.js";
import type { createCommunicationArtifactAuthority } from "./communication-artifacts.js";

type CommunicationArtifactAuthority = ReturnType<typeof createCommunicationArtifactAuthority>;

interface CommunicationProjectionReconcilerContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  assets: AssetStore;
  recordCommunication(event: CommunicationEvent): CommunicationEvent;
  projectCommunicationArtifact: CommunicationArtifactAuthority["projectCommunicationArtifact"];
  communicationArtifactAccess: CommunicationArtifactAuthority["communicationArtifactAccess"];
  scheduleCommunicationReconciliation(projectId: string): void;
  logError(meta: Record<string, unknown>, message: string): void;
  logInfo(meta: Record<string, unknown>, message: string): void;
  projectCommunicationToAgentAudit(
    agentId: string,
    event: CommunicationEvent,
    renderedText: string,
    attachments?: ImageAttachmentDto[],
  ): void;
}

export function createCommunicationProjectionReconciler(
  context: CommunicationProjectionReconcilerContext,
) {
  const {
    store,
    coordinationV3,
    assets,
    recordCommunication,
    projectCommunicationArtifact,
    communicationArtifactAccess,
    scheduleCommunicationReconciliation,
    logError,
    logInfo,
    projectCommunicationToAgentAudit,
  } = context;

  async function reconcileRuntimeCommunicationProjections(filter?: {
    projectId?: string;
    communicationEventId?: string;
  }): Promise<number> {
    let repaired = 0;
    let skippedUnavailableTargets = 0;
    const repairedProjectIds = new Set<string>();
    const exactCanonicalEvents = new Map<string, CommunicationEvent>();
    for (const row of coordinationV3.runtimeCommunications()) {
      if (filter?.projectId && row.projectId !== filter.projectId) continue;
      const payload = row.payload && typeof row.payload === "object"
        ? row.payload as Record<string, unknown>
        : undefined;
      const candidate = payload?.communication ?? row.payload;
      if (!candidate || typeof candidate !== "object") continue;
      let event = candidate as Partial<CommunicationEvent>;
      if (
        typeof event.eventId !== "string" ||
        typeof event.projectId !== "string" ||
        typeof event.text !== "string" ||
        typeof event.createdAt !== "string" ||
        event.projectId !== row.projectId
      ) continue;
      const communicationEventId = event.eventId;
      if (filter?.communicationEventId && communicationEventId !== filter.communicationEventId) continue;
      const runtimeArtifacts = coordinationV3.runtimeArtifacts("communication", row.id);
      let artifactsAvailable = true;
      for (const artifact of runtimeArtifacts) {
        if (!assets.authoritativeRuntimeArtifact(row.projectId, artifact)) {
          artifactsAvailable = false;
          break;
        }
      }
      if (!artifactsAvailable) {
        logError({ runtimeCommunicationId: row.id, communicationEventId }, "runtime communication artifact is unavailable; projection remains uncommitted");
        continue;
      }
      const dispatch = payload?.dispatch && typeof payload.dispatch === "object"
        ? payload.dispatch as Record<string, unknown>
        : undefined;

      const recipientAgentIds = coordinationV3.communicationRecipientAgentIds(row.projectId, row.id);
      const expectedAttachmentOwners = new Map<string, string>();
      let attachmentEnvelopeValid = true;
      const expectAttachment = (owner: unknown, raw: unknown): void => {
        if (typeof owner !== "string" || !raw || typeof raw !== "object" || Array.isArray(raw)) {
          attachmentEnvelopeValid = false;
          return;
        }
        const expected = raw as Record<string, unknown>;
        if (typeof expected.id !== "string" || typeof expected.name !== "string" ||
            typeof expected.mediaType !== "string" || !Number.isSafeInteger(expected.size)) {
          attachmentEnvelopeValid = false;
          return;
        }
        const prior = expectedAttachmentOwners.get(expected.id);
        if (prior !== undefined && prior !== owner) attachmentEnvelopeValid = false;
        expectedAttachmentOwners.set(expected.id, owner);
      };
      for (const raw of event.attachments ?? []) expectAttachment(raw.agentId, raw);
      if (Array.isArray(dispatch?.recipients)) {
        for (const value of dispatch.recipients) {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            attachmentEnvelopeValid = false;
            continue;
          }
          const recipient = value as Record<string, unknown>;
          if (recipient.attachments === undefined) continue;
          if (!Array.isArray(recipient.attachments)) {
            attachmentEnvelopeValid = false;
            continue;
          }
          for (const raw of recipient.attachments) expectAttachment(recipient.agentId, raw);
        }
      }
      if (Array.isArray(dispatch?.attachments)) {
        const canonicalOwners = new Set(dispatch.attachments.flatMap((raw) => {
          const id = raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : undefined;
          const owner = typeof id === "string" ? expectedAttachmentOwners.get(id) : undefined;
          return owner ? [owner] : [];
        }));
        const owner = recipientAgentIds.length === 1
          ? recipientAgentIds[0]
          : canonicalOwners.size === 1
            ? [...canonicalOwners][0]
            : undefined;
        for (const raw of dispatch.attachments) expectAttachment(owner, raw);
      }
      const validateReservedAttachments = (): Map<string, AuthoritativeRuntimeAttachment> | undefined => {
        if (!attachmentEnvelopeValid) return undefined;
        const reserved = assets.authoritativeRuntimeCommunicationAttachments(row.id);
        if (!reserved || reserved.length !== expectedAttachmentOwners.size) return undefined;
        const byKey = new Map(reserved.map((item) =>
          [`${item.attachment.agentId}\0${item.attachment.id}`, item] as const));
        for (const [attachmentId, owner] of expectedAttachmentOwners) {
          const authoritative = byKey.get(`${owner}\0${attachmentId}`);
          if (!authoritative) return undefined;
          const appearances: unknown[] = [
            ...(event.attachments ?? []).filter((item) => item.id === attachmentId),
            ...(Array.isArray(dispatch?.attachments)
              ? dispatch.attachments.filter((item) => item && typeof item === "object" &&
                  (item as Record<string, unknown>).id === attachmentId)
              : []),
            ...(Array.isArray(dispatch?.recipients) ? dispatch.recipients.flatMap((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return [];
              const recipient = value as Record<string, unknown>;
              return Array.isArray(recipient.attachments)
                ? recipient.attachments.filter((item) => item && typeof item === "object" &&
                    (item as Record<string, unknown>).id === attachmentId)
                : [];
            }) : []),
          ];
          for (const appearance of appearances) {
            const expected = appearance as Record<string, unknown>;
            if (expected.name !== authoritative.attachment.name ||
                expected.mediaType !== authoritative.attachment.mediaType ||
                expected.size !== authoritative.attachment.size ||
                (expected.agentId !== undefined && expected.agentId !== authoritative.attachment.agentId) ||
                (expected.sha256 !== undefined && expected.sha256 !== authoritative.contentHash) ||
                (expected.localPath !== undefined && expected.localPath !== authoritative.localPath)) return undefined;
          }
        }
        return byKey;
      };
      let reservedAttachments = validateReservedAttachments();
      if (!reservedAttachments) {
        logError({ runtimeCommunicationId: row.id, communicationEventId },
          "runtime communication attachment is unavailable; canonical projection remains uncommitted");
        continue;
      }

      // The runtime row is the durable handoff boundary. Multi-recipient sends
      // deliberately store target-owned copies under dispatch.recipients; the
      // top-level form remains for single-recipient/direct legacy handoffs.
      const rawRecipientSets: Array<{ agentId: string; rawAttachments: unknown[] }> = [];
      if (Array.isArray(dispatch?.recipients)) {
        for (const value of dispatch.recipients) {
          if (!value || typeof value !== "object") continue;
          const recipient = value as Record<string, unknown>;
          if (typeof recipient.agentId !== "string" || !Array.isArray(recipient.attachments)) continue;
          rawRecipientSets.push({ agentId: recipient.agentId, rawAttachments: recipient.attachments });
        }
      }
      if (Array.isArray(dispatch?.attachments)) {
        for (const agentId of recipientAgentIds) {
          if (!rawRecipientSets.some((recipient) => recipient.agentId === agentId)) {
            rawRecipientSets.push({ agentId, rawAttachments: dispatch.attachments });
          }
        }
      }

      const attachmentsByAgent = new Map<string, ImageAttachmentDto[]>();
      for (const { agentId, rawAttachments } of rawRecipientSets) {
        if (attachmentsByAgent.has(agentId) || new Set(rawAttachments.map((raw) =>
          raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : undefined)).size !== rawAttachments.length) continue;
        const recovered: ImageAttachmentDto[] = [];
        for (const raw of rawAttachments) {
          if (!raw || typeof raw !== "object") continue;
          const expected = raw as Record<string, unknown>;
          if (typeof expected.id !== "string") continue;
          const authoritative = reservedAttachments.get(`${agentId}\0${expected.id}`);
          if (!authoritative || authoritative.attachment.name !== expected.name ||
              authoritative.attachment.mediaType !== expected.mediaType ||
              authoritative.attachment.size !== expected.size) continue;
          recovered.push({ ...authoritative.attachment, state: "associated" });
        }
        if (recovered.length === rawAttachments.length) attachmentsByAgent.set(agentId, recovered);
      }

      const firstRecoveredAttachments = [...attachmentsByAgent.values()].find((items) => items.length > 0);
      if (!event.attachments?.length && firstRecoveredAttachments?.length) {
        event = { ...event, attachments: firstRecoveredAttachments };
      }
      try {
        let canonical = store.getCommunicationEvent(row.projectId, communicationEventId);
        if (!canonical) {
          reservedAttachments = validateReservedAttachments();
          if (!reservedAttachments) throw new Error("runtime Communication attachment changed before canonical projection");
          canonical = recordCommunication(event as CommunicationEvent);
          repaired += 1;
          repairedProjectIds.add(row.projectId);
        }
        if (!canonical) continue;
        if (filter?.projectId && filter.communicationEventId) exactCanonicalEvents.set(canonical.eventId, canonical);
        for (const artifact of runtimeArtifacts) {
          projectCommunicationArtifact(
            row.projectId,
            artifact.originAgentId ?? (canonical.sender.kind === "agent" ? canonical.sender.agentId : "local-operator"),
            { ...artifact, createdAt: artifact.createdAt, mediaType: "text/markdown" },
            communicationArtifactAccess(canonical),
          );
        }

        const behavior = deriveCommunicationBehavior(canonical);
        const projectionTargets = behavior.projectionTargets.filter((target) => {
          if (target.surface === "conversation" || target.surface === "collaboration_view") {
            const conversation = store.getConversation(target.projectionKey);
            return Boolean(conversation && conversation.projectId === canonical.projectId && !conversation.archived);
          }
          if (target.surface === "direct_agent_audit" || target.surface === "agent_inbox") {
            const agent = store.getAgent(target.projectionKey);
            return Boolean(agent && agent.projectId === canonical.projectId && !agent.archived);
          }
          return true;
        });
        skippedUnavailableTargets += behavior.projectionTargets.length - projectionTargets.length;
        const recipientIds = behavior.deliveryRecipients.flatMap((recipient) =>
          recipient.kind === "agent" ? [recipient.agentId] : []);
        const roomAttachments = canonical.attachments ?? firstRecoveredAttachments;
        const role = canonical.sender.kind === "user" ? "user" : canonical.sender.kind === "system" ? "system" : "assistant";
        const dispatchText = typeof dispatch?.text === "string" ? dispatch.text : canonical.text;
        const conversationText = canonical.intent === "broadcast"
          ? canonical.sender.kind === "agent" || dispatch?.shareWithOrganization === true
            ? dispatchText
            : renderScopedMessage("broadcast", canonical.text)
          : canonical.schemaVersion === 2 && canonical.intent === "user_dm" && canonical.sender.kind === "agent"
            ? renderScopedMessage("user", canonical.text)
            : canonical.schemaVersion === 2 && canonical.intent === "user_dm" &&
                canonical.sender.kind === "user" && !Array.isArray(dispatch?.recipients)
              ? (() => {
                  const targetAgentId = typeof dispatch?.targetAuthorAgentId === "string"
                    ? dispatch.targetAuthorAgentId
                    : recipientIds.length === 1 ? recipientIds[0] : undefined;
                  const target = targetAgentId ? store.getAgent(targetAgentId) : undefined;
                  return target ? `#${agentMentionHandle(target.title)} ${dispatchText}`.trimEnd() : dispatchText;
                })()
              : dispatchText;
        const roomTarget = projectionTargets.find((target) =>
          target.surface === "conversation" || target.surface === "collaboration_view");
        if (roomTarget && canonical.conversationId) {
          const channel = roomTarget.surface === "collaboration_view" ? "collaboration" : "main";
          const roomMessage = store.getConversationMessages(canonical.conversationId, channel)
            .find((message) => message.communicationEventId === canonical.eventId);
          const deliveryIntents: ConversationDeliveryIntent[] = recipientIds.map((agentId) => ({
            targetAgentId: agentId,
            relayDepth: 0,
            mentionTrail: [],
            kind: canonical.intent === "collaboration" ? "tag" : "direct",
            ...(canonical.intent === "collaboration" ? { audience: canonical.audienceSelector ?? "mention" } : {}),
            ...(attachmentsByAgent.get(agentId)?.length
              ? { attachmentIds: attachmentsByAgent.get(agentId)!.map((item) => item.id) }
              : {}),
          }));
          if (!roomMessage) {
            store.appendConversationMessage(
              canonical.conversationId,
              {
                role,
                text: conversationText,
                ...(roomAttachments?.length ? { attachments: roomAttachments } : {}),
              },
              canonical.sender.kind === "agent" ? canonical.sender.agentId : undefined,
              channel,
              deliveryIntents.length ? deliveryIntents : undefined,
              canonical.idempotencyKey,
              canonical.eventId,
            );
            repaired += 1;
            repairedProjectIds.add(canonical.projectId);
          } else if (roomAttachments?.length && !roomMessage.attachments?.length) {
            const enriched = store.appendCommunicationProjection(canonical.projectId, {
              eventId: canonical.eventId, surface: roomTarget.surface, projectionKey: canonical.conversationId,
              projectedAt: roomMessage.createdAt,
              message: {
                messageId: roomMessage.id, role: roomMessage.role, renderedText: roomMessage.text,
                createdAt: roomMessage.createdAt, attachments: roomAttachments,
                ...(roomMessage.authorAgentId ? { authorAgentId: roomMessage.authorAgentId } : {}),
              },
            });
            if (!enriched.replayed) {
              repaired += 1;
              repairedProjectIds.add(canonical.projectId);
            }
          }
        }

        for (const target of projectionTargets.filter((item) => item.surface === "direct_agent_audit")) {
          const before = store.readCommunicationProjections(canonical.projectId).find((projection) =>
            projection.eventId === canonical.eventId && projection.surface === target.surface &&
            projection.projectionKey === target.projectionKey);
          const targetAttachments = attachmentsByAgent.get(target.projectionKey) ??
            (canonical.sender.kind === "agent" && canonical.sender.agentId === target.projectionKey
              ? roomAttachments ?? []
              : []);
          const auditText = canonical.intent === "broadcast"
            ? renderScopedMessage("broadcast", canonical.text)
            : dispatchText;
          projectCommunicationToAgentAudit(target.projectionKey, canonical, auditText, targetAttachments);
          const after = store.readCommunicationProjections(canonical.projectId).find((projection) =>
            projection.eventId === canonical.eventId && projection.surface === target.surface &&
            projection.projectionKey === target.projectionKey);
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            repaired += 1;
            repairedProjectIds.add(canonical.projectId);
          }
        }

        for (const [agentId, recipientAttachments] of attachmentsByAgent) {
          if (!recipientAttachments.length) continue;
          const agent = store.getAgent(agentId);
          if (!agent || agent.projectId !== canonical.projectId || agent.archived) continue;
          await assets.associate(canonical.projectId, agentId, recipientAttachments.map((item) => item.id));
        }
      } catch (error) {
        logError({
          err: error,
          runtimeCommunicationId: row.id,
          communicationEventId,
        }, "runtime communication projection recovery failed");
      }
    }
    if (skippedUnavailableTargets > 0) {
      logInfo({ skippedUnavailableTargets },
        "runtime communication recovery skipped unavailable historical projection surfaces");
    }
    for (const projectId of repairedProjectIds) scheduleCommunicationReconciliation(projectId);
    if (filter?.projectId && filter.communicationEventId) {
      const canonical = [...exactCanonicalEvents.values()][0] ??
        store.getCommunicationEvent(filter.projectId, filter.communicationEventId);
      const projections = canonical ? store.readCommunicationProjections(filter.projectId) : [];
      // Legacy audit-first recovery can already own the one stable room
      // dispatch under the canonical idempotency receipt while the newer V3
      // runtime row has a different deterministic event ID. That durable
      // dispatch is the exact-once visible placement; manufacturing a second
      // room message would violate its identity.
      const receiptMessage = canonical?.conversationId && canonical.idempotencyKey
        ? store.getConversationMessageByReceiptKey(canonical.conversationId, canonical.idempotencyKey)
        : undefined;
      const incompleteTargets = canonical ? deriveCommunicationBehavior(canonical).projectionTargets.filter((target) => {
        if (target.surface === "conversation" || target.surface === "collaboration_view") {
          const conversation = store.getConversation(target.projectionKey);
          if (!conversation || conversation.projectId !== canonical.projectId || conversation.archived) return false;
        } else if (target.surface === "direct_agent_audit") {
          const agent = store.getAgent(target.projectionKey);
          if (!agent || agent.projectId !== canonical.projectId || agent.archived) return false;
        } else {
          return false;
        }
        return !((target.surface === "conversation" || target.surface === "collaboration_view") && receiptMessage) &&
          !projections.some((projection) => projection.eventId === canonical.eventId &&
            projection.surface === target.surface && projection.projectionKey === target.projectionKey && projection.message);
      }) : [];
      if (!canonical || incompleteTargets.length > 0) {
        throw new Error("runtime communication projection recovery is incomplete; exact retry remains safe");
      }
      // A prior crash may have left cached red evidence even when another
      // durable handoff already supplied the missing metadata. Exact replay
      // always invalidates that evidence before it can report success.
      scheduleCommunicationReconciliation(filter.projectId);
    }
    return repaired;
  }

  return { reconcileRuntimeCommunicationProjections };
}
