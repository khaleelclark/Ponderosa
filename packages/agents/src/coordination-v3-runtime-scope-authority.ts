import type Database from "better-sqlite3";
import {
  type CommunicationAudience,
  type CommunicationEvent,
  isCommunicationActor,
  isCommunicationAudience,
  isCommunicationEvent,
} from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import {
  runtimeCanonicalAttachmentsAreValid,
  runtimeDispatchAttachmentsAreValid,
} from "./coordination-v3-runtime-validation.js";

export class CoordinationV3RuntimeScopeAuthority {
  constructor(private readonly sqlite: Database.Database) {}

  coordinationScopeKey(conversationId: string | null, agentId: string): string {
    return conversationId ? `conversation:${conversationId}` : `agent:${agentId}`;
  }

  communicationScopeKey(payload: unknown, agentId: string): string {
    if (payload && typeof payload === "object") {
      const root = payload as Record<string, unknown>;
      const communication = root.communication && typeof root.communication === "object"
        ? root.communication as Record<string, unknown>
        : root;
      if (typeof communication.conversationId === "string" && communication.conversationId) {
        return `conversation:${communication.conversationId}`;
      }
    }
    return `agent:${agentId}`;
  }

  /** Runtime communication rows, their actionable deliveries, and every
   * structured identity they reference must remain inside one Project. */
  runtimeCommunicationAuthorityAgrees(input: {
    projectId: string;
    sender: unknown;
    intent: string;
    audience: unknown;
    payload: unknown;
    activations: Array<{ agentId: string; kind?: string; scopeKey: string }>;
  }, requireCurrentAuthorization = true): boolean {
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    if (!isCommunicationActor(input.sender) || !isCommunicationAudience(input.audience)) return false;
    const sender = input.sender;
    const audience = input.audience;
    const payloadRecord = record(input.payload);
    if (!payloadRecord) return false;
    const runtimePayload = payloadRecord as Record<string, unknown>;
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(payloadRecord, key);
    if (hasOwn("communication") && !isCommunicationEvent(payloadRecord.communication)) return false;
    if (hasOwn("dispatch") && !record(payloadRecord.dispatch)) return false;
    const directCanonicalPayload = !hasOwn("communication")
      && (
        Object.prototype.hasOwnProperty.call(payloadRecord, "schemaVersion")
        || Object.prototype.hasOwnProperty.call(payloadRecord, "eventId")
      );
    if (directCanonicalPayload && !isCommunicationEvent(payloadRecord)) return false;
    const communication = hasOwn("communication")
      ? (payloadRecord as Record<string, unknown>).communication as CommunicationEvent
      : directCanonicalPayload ? payloadRecord as unknown as CommunicationEvent : undefined;
    if (communication) {
      const expectedIntent = input.intent === "correction" ? "user_dm"
        : input.intent === "managed_child_failure" ? undefined
          : input.intent;
      if (
        !expectedIntent
        || communication.projectId !== input.projectId
        || communication.intent !== expectedIntent
        || stableJson(communication.sender) !== stableJson(input.sender)
        || !this.communicationAudiencesAgree(communication.audience, input.audience)
      ) return false;
      if (communication.schemaVersion === 2 && communication.intent === "user_dm") {
        const targetAgentIds = this.communicationAudienceAgentIds(communication.audience);
        if (
          communication.sender.kind === "system"
          || (
            communication.sender.kind === "user"
            && communication.sender.userId !== communication.audience.userId
          )
          || (
            communication.sender.kind === "agent"
            && (targetAgentIds.length !== 1 || targetAgentIds[0] !== communication.sender.agentId)
          )
        ) return false;
      }
    } else if (input.intent === "correction") return false;

    const intentAudienceAgrees = input.intent === "broadcast"
      ? audience.kind === "organization"
      : input.intent === "direct_to_user"
        ? audience.kind === "user"
        : input.intent === "user_dm"
          ? audience.kind === "user_agent" || audience.kind === "user_agents"
          : input.intent === "collaboration"
            ? audience.kind === "agents"
            : input.intent === "correction"
              ? (audience.kind === "user_agent" || audience.kind === "user_agents") && sender.kind === "user"
              : input.intent === "managed_child_failure"
                && audience.kind === "agents" && sender.kind === "system";
    if (!intentAudienceAgrees) return false;
    if (audience.kind === "organization" && audience.organizationId !== input.projectId) return false;
    if (
      input.intent === "managed_child_failure"
      && (
        sender.kind !== "system"
        || sender.component !== "runtime-supervisor"
        || audience.kind !== "agents"
        || audience.agentIds.length !== 1
        || typeof runtimePayload.text !== "string"
        || !runtimePayload.text.trim()
        || typeof runtimePayload.childAgentId !== "string"
        || !runtimePayload.childAgentId
        || typeof runtimePayload.executionId !== "string"
        || !runtimePayload.executionId
        || typeof runtimePayload.failure !== "string"
        || !runtimePayload.failure.trim()
        || input.activations.length !== 1
      )
    ) return false;

    const audienceAgentIds = new Set(this.communicationAudienceAgentIds(audience));
    const identityAgentIds = new Set(audienceAgentIds);
    if (sender.kind === "agent") {
      identityAgentIds.add(sender.agentId);
    }
    if (communication && Object.prototype.hasOwnProperty.call(communication, "attachments")) {
      if (!runtimeCanonicalAttachmentsAreValid(communication.attachments)) return false;
      for (const attachment of communication.attachments) {
        identityAgentIds.add(attachment.agentId);
        if (audience.kind !== "organization" && !audienceAgentIds.has(attachment.agentId)) return false;
      }
    }
    const childAgentId = (payloadRecord as Record<string, unknown>).childAgentId;
    if (childAgentId !== undefined) {
      if (typeof childAgentId !== "string" || !childAgentId) return false;
      identityAgentIds.add(childAgentId);
    }

    const conversationIds = new Set<string>();
    const addConversationId = (value: unknown): boolean => {
      if (value === undefined || value === null) return true;
      if (typeof value !== "string" || !value) return false;
      conversationIds.add(value);
      return true;
    };
    if (!addConversationId(communication?.conversationId)) return false;
    const dispatch = record((payloadRecord as Record<string, unknown>).dispatch);
    if (
      !addConversationId(dispatch?.conversationId)
      || !addConversationId(dispatch?.sourceConversationId)
    ) return false;
    for (const activation of input.activations) {
      const prefix = "conversation:";
      if (
        activation.scopeKey.startsWith(prefix)
        && !addConversationId(activation.scopeKey.slice(prefix.length))
      ) {
        return false;
      }
    }
    if (conversationIds.size > 1) return false;
    const conversationId = [...conversationIds][0];

    if (
      dispatch?.communicationEventId !== undefined
      && (
        typeof dispatch.communicationEventId !== "string"
        || !communication
        || dispatch.communicationEventId !== communication.eventId
      )
    ) return false;
    if (dispatch?.targetAuthorAgentId !== undefined) {
      if (typeof dispatch.targetAuthorAgentId !== "string" || !dispatch.targetAuthorAgentId) return false;
      identityAgentIds.add(dispatch.targetAuthorAgentId);
      if (audience.kind !== "organization" && !audienceAgentIds.has(dispatch.targetAuthorAgentId)) return false;
    }
    if (
      dispatch
      && Object.prototype.hasOwnProperty.call(dispatch, "attachments")
      && !runtimeDispatchAttachmentsAreValid(dispatch.attachments)
    ) return false;
    if (dispatch?.recipients !== undefined) {
      if (!Array.isArray(dispatch.recipients)) return false;
      for (const candidate of dispatch.recipients) {
        const recipient = record(candidate);
        if (!recipient || typeof recipient.agentId !== "string" || !recipient.agentId) return false;
        if (
          Object.prototype.hasOwnProperty.call(recipient, "attachments")
          && !runtimeDispatchAttachmentsAreValid(recipient.attachments)
        ) return false;
        identityAgentIds.add(recipient.agentId);
        if (audience.kind !== "organization" && !audienceAgentIds.has(recipient.agentId)) return false;
      }
    }

    for (const agentId of identityAgentIds) {
      if (!this.sqlite.prepare(`
        SELECT 1 FROM agents WHERE id = ? AND project_id = ?
          AND (? = 0 OR archived = 0)
      `).get(agentId, input.projectId, requireCurrentAuthorization ? 1 : 0)) return false;
      if (
        conversationId
        && requireCurrentAuthorization
        && !this.sqlite.prepare(`
          SELECT 1 FROM agent_conversation_memberships
          WHERE conversation_id = ? AND agent_id = ?
        `).get(conversationId, agentId)
      ) return false;
    }
    for (const conversationId of conversationIds) {
      if (!this.sqlite.prepare(`
        SELECT 1 FROM conversations
        WHERE id = ? AND project_id = ? AND (? = 0 OR archived = 0)
      `).get(conversationId, input.projectId, requireCurrentAuthorization ? 1 : 0)) return false;
    }

    const audienceIsOrganization = audience.kind === "organization";
    for (const activation of input.activations) {
      if (input.intent === "managed_child_failure" && activation.kind !== input.intent) return false;
      if (input.intent === "correction" && activation.kind !== "message_correction") return false;
      if (!audienceIsOrganization && !audienceAgentIds.has(activation.agentId)) return false;
      if (
        conversationId
          ? activation.scopeKey !== `conversation:${conversationId}`
          : activation.scopeKey !== `agent:${activation.agentId}`
      ) return false;
      if (requireCurrentAuthorization) {
        if (!this.recipientAuthorizedForActivationScope(
          input.projectId,
          activation.agentId,
          activation.scopeKey,
        )) return false;
      } else if (activation.scopeKey !== `agent:${activation.agentId}`) {
        const conversationPrefix = "conversation:";
        if (!activation.scopeKey.startsWith(conversationPrefix)) return false;
        const conversationId = activation.scopeKey.slice(conversationPrefix.length);
        if (
          !conversationId
          || !this.sqlite.prepare(`
            SELECT 1 FROM conversations WHERE id = ? AND project_id = ?
          `).get(conversationId, input.projectId)
        ) return false;
      }
    }
    return true;
  }

  /** One fail-closed authority boundary for every Activation consumer. */
  recipientAuthorizedForActivationScope(
    projectId: string,
    agentId: string,
    scopeKey: string,
  ): boolean {
    const activeAgent = this.sqlite.prepare(`
      SELECT 1 FROM agents
      WHERE id = ? AND project_id = ? AND archived = 0
    `).get(agentId, projectId);
    if (!activeAgent) return false;
    if (scopeKey === `agent:${agentId}`) return true;
    const conversationPrefix = "conversation:";
    if (!scopeKey.startsWith(conversationPrefix)) return false;
    const conversationId = scopeKey.slice(conversationPrefix.length);
    if (!conversationId) return false;
    return Boolean(this.sqlite.prepare(`
      SELECT 1
      FROM conversations conversation
      JOIN agent_conversation_memberships membership
        ON membership.conversation_id = conversation.id
      WHERE conversation.id = ? AND conversation.project_id = ?
        AND conversation.archived = 0 AND membership.agent_id = ?
    `).get(conversationId, projectId, agentId));
  }

  private communicationAudienceAgentIds(audience: CommunicationAudience): string[] {
    if (audience.kind === "agents" || audience.kind === "user_agents") return audience.agentIds;
    if (audience.kind === "user_agent") return [audience.agentId];
    return [];
  }

  private communicationAudiencesAgree(
    left: CommunicationAudience,
    right: CommunicationAudience,
  ): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "organization" && right.kind === "organization") {
      return left.organizationId === right.organizationId;
    }
    if (left.kind === "user" && right.kind === "user") return left.userId === right.userId;
    if (left.kind === "user_agent" && right.kind === "user_agent") {
      return left.userId === right.userId && left.agentId === right.agentId;
    }
    if (left.kind === "user_agents" && right.kind === "user_agents") {
      return left.userId === right.userId
        && stableJson([...new Set(left.agentIds)].sort())
          === stableJson([...new Set(right.agentIds)].sort());
    }
    return left.kind === "agents" && right.kind === "agents"
      && stableJson([...new Set(left.agentIds)].sort())
        === stableJson([...new Set(right.agentIds)].sort());
  }
}
