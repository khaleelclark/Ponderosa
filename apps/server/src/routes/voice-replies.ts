import { randomUUID } from "node:crypto";
import type { CommunicationEvent, VoiceReplyStatus } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, StoredLogEvent } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import { VoiceReplyStream } from "../voice-reply-stream.js";
import { canonicalVoiceReplyInput } from "../voice-reply-input.js";

import { voiceMemoryExposure } from "../voice-memory-exposure.js";
import type { MemoryAuthorityPorts } from "../memory-authority.js";

interface Context {
  memoryPorts: MemoryAuthorityPorts;
  store: AgentStore; coordinationV3: CoordinationV3Store;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  capabilityOwnsAuthoritativeRun(capability: AgentMessageCapability, run: ActiveRun | undefined): boolean;
  publish(agentId: string, stored: StoredLogEvent): void;
}
export function registerVoiceReplyRoutes(app: FastifyInstance, c: Context): void {
  app.post<{ Body: { steeringInjectionId?: string } }>("/api/agent-voice-reply", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
    const cap = token ? c.agentMessageCapabilities.get(token) : undefined;
    const run = cap ? c.activeRuns.get(cap.agentId) : undefined;
    if (!cap || !run || run.messageCapability !== token || !c.capabilityOwnsAuthoritativeRun(cap, run)) {
      return reply.code(401).send({ error: "invalid or expired voice reply capability" });
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some(k => k !== "steeringInjectionId") ||
        (request.body.steeringInjectionId !== undefined && typeof request.body.steeringInjectionId !== "string")) {
      return reply.code(400).send({ error: "invalid voice reply arguments" });
    }
    const injection = c.coordinationV3.latestAcknowledgedSteeringInjection(cap.runId);
    if (injection && request.body.steeringInjectionId !== injection) return reply.code(409).send({ error: "voice reply steering fence changed" });
    if (!cap.availableToolNames.includes("ponderosa_voice_reply") || !run.voiceReplyStreamSupported || cap.defaultReply?.intent !== "direct_to_user" ||
        cap.inferredReplyCommunicationEventId || c.coordinationV3.requestIdsAttachedToRun(cap.runId, cap.agentId).length) {
      return reply.code(409).send({ error: "voice stream unavailable; use ordinary ponderosa_message" });
    }
    const voiceInput = canonicalVoiceReplyInput(c.store, c.coordinationV3, cap);
    if (!voiceInput) {
      return reply.code(409).send({ error: "no sole accepted inline voice Direct Message for this Run" });
    }
    const { input } = voiceInput;
    const operationId = request.headers["x-ponderosa-voice-operation-id"];
    if (operationId !== undefined && (typeof operationId !== "string" || !operationId.trim() || operationId.length > 512)) {
      return reply.code(400).send({ error: "invalid voice operation identity" });
    }
    if (!run.voiceReply) {
      const t = c.coordinationV3.voiceReplyRunTiming(input.eventId, cap.agentId);
      if (t?.runId !== cap.runId) return reply.code(409).send({ error: "voice input does not own this Run" });
      run.voiceReply = new VoiceReplyStream({ projectId: input.projectId, conversationId: cap.conversationId!,
        agentId: cap.agentId, messageId: input.eventId, runId: cap.runId, fence: cap.v3FencingToken,
        steeringInjectionId: injection, streamId: randomUUID(), sequence: 0, text: "", state: "open", acceptedAt: input.createdAt,
        leasedAt: t.leasedAt, runStartedAt: t.runStartedAt, ...run.voiceReplyTiming }, c.coordinationV3.steeringInjectionIds(cap.runId), typeof operationId === "string" ? operationId : undefined);
      c.publish(cap.agentId, c.store.appendEvent(cap.agentId, { type: "voice_reply", reply: { ...run.voiceReply.snapshot } }));
    }
    const result = run.voiceReply.authorizationResult();
    return result.authorized ? result : reply.code(409).send(result);
  });
  app.get<{ Params: { id: string; messageId: string; agentId: string } }>(
    "/api/conversations/:id/voice-replies/:messageId/:agentId", async (request, reply) => {
      const { id, messageId, agentId } = request.params;
      const chat = c.store.getConversation(id); const agent = c.store.getAgent(agentId);
      const runtime = c.coordinationV3.runtimeCommunication(messageId);
      const input = (runtime?.payload as { communication?: CommunicationEvent } | undefined)?.communication;
      if (!chat || chat.archived || !agent || agent.archived || agent.conversationId !== id ||
          agent.projectId !== chat.projectId || input?.conversationId !== id || input.projectId !== chat.projectId ||
          input.intent !== "user_dm" || input.sender.kind !== "user" || input.sender.userId !== "local-operator" ||
          input.audience.kind !== "user_agents" || input.audience.userId !== "local-operator" ||
          input.audience.agentIds.length !== 1 || input.audience.agentIds[0] !== agentId) {
        return reply.code(404).send({ error: "voice turn not found" });
      }
      const t = c.coordinationV3.voiceReplyRunTiming(messageId, agentId);
      const active = c.activeRuns.get(agentId)?.voiceReply?.snapshot;
      const s = active?.messageId === messageId && active.runId === t?.runId ? active
        : c.store.readEventsSince(agentId, Math.max(0, c.store.lastSeqOf(agentId) - 256), 256)
          .map(e => e.event).filter(e => e.type === "voice_reply" && e.reply.messageId === messageId && e.reply.runId === t?.runId)
          .flatMap(e => e.type === "voice_reply" ? [e.reply] : []).at(-1);
      return { messageId, acceptedAt: input.createdAt, ...t,
        memoryExposure: voiceMemoryExposure(c.memoryPorts, { agentId, projectId: chat.projectId, conversationId: id, messageId, runId: t?.runId }),
        ...(s?.messageId === messageId && s.runId === t?.runId ? { reply: { ...s } } : {}) } satisfies VoiceReplyStatus;
    });
}
