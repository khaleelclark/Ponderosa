import {localMemoryFor} from "../local-memory.js";
import {resourceInProduct,requestProduct} from "../product-scope.js";
import { randomUUID } from "node:crypto";
import type { CommunicationEvent, VoiceReplyStatus } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, StoredLogEvent } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import { VoiceReplyStream } from "../voice-reply-stream.js";
import { canonicalVoiceReplyInput } from "../voice-reply-input.js";

import { voiceMemoryExposure } from "../voice-memory-exposure.js";
import type { VoiceExposurePorts } from "../voice-memory-exposure.js";
import {activeChatResourceOwner} from "../branch-resource-owner.js";

interface Context {
  memoryPorts: VoiceExposurePorts;
  store: AgentStore; coordinationV3: CoordinationV3Store;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  agentMessageCapabilities: ReadonlyMap<string, AgentMessageCapability>;
  capabilityOwnsAuthoritativeRun(capability: AgentMessageCapability, run: ActiveRun | undefined): boolean;
  publish(agentId: string, stored: StoredLogEvent): void;
}
export function registerVoiceReplyRoutes(app: FastifyInstance, c: Context): void {
  for (const presentation of ["voice", "text"] as const) app.post<{ Body: { steeringInjectionId?: string } }>(presentation === "voice" ? "/api/agent-voice-reply" : "/api/agent-reply-stream", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
    const cap = token ? c.agentMessageCapabilities.get(token) : undefined;
    const run = cap ? c.activeRuns.get(cap.agentId) : undefined;
    if (!cap || !run || run.messageCapability !== token || !c.capabilityOwnsAuthoritativeRun(cap, run)) {
      return reply.code(401).send({ error: "invalid or expired reply capability" });
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some(k => k !== "steeringInjectionId") ||
        (request.body.steeringInjectionId !== undefined && typeof request.body.steeringInjectionId !== "string")) {
      return reply.code(400).send({ error: "invalid reply arguments" });
    }
    const injection = c.coordinationV3.latestAcknowledgedSteeringInjection(cap.runId);
    if (injection && request.body.steeringInjectionId !== injection) return reply.code(409).send({ error: "reply steering fence changed" });
    if (!cap.availableToolNames.includes(presentation === "voice" ? "ponderosa_voice_reply" : "ponderosa_reply_stream") || !run.voiceReplyStreamSupported || (presentation === "voice" ? cap.defaultReply?.intent !== "direct_to_user" : !cap.defaultReply) ||
        cap.inferredReplyCommunicationEventId || c.coordinationV3.requestIdsAttachedToRun(cap.runId, cap.agentId).length) {
      return reply.code(409).send({ error: "reply stream unavailable; use ordinary ponderosa_message" });
    }
    const voiceInput = canonicalVoiceReplyInput(c.store, c.coordinationV3, cap, presentation);
    if (!voiceInput) {
      return reply.code(409).send({ error: "no accepted inline Communication on this reply route" });
    }
    const { input } = voiceInput;
    const operationId = request.headers["x-ponderosa-voice-operation-id"];
    if (operationId !== undefined && (typeof operationId !== "string" || !operationId.trim() || operationId.length > 512)) {
      return reply.code(400).send({ error: "invalid voice operation identity" });
    }
    try{localMemoryFor(app)?.beginSpeech(token!);}catch{return reply.code(409).send({error:'Memory changed before voice authorization; start a fresh turn'});}
    if (run.voiceReply && run.voiceReply.snapshot.presentation !== presentation &&
        !(presentation === "voice" && run.voiceReply.snapshot.presentation === undefined)) {
      return reply.code(409).send({ error: "A different reply presentation already owns this Run" });
    }
    if (!run.voiceReply) {
      const t = c.coordinationV3.voiceReplyRunTiming(input.eventId, cap.agentId);
      if (t?.runId !== cap.runId) return reply.code(409).send({ error: "reply input does not own this Run" });
      run.voiceReply = new VoiceReplyStream({ presentation, replyIntent: cap.defaultReply!.intent,
        ...(cap.defaultReply?.recipientAgentIds ? { recipientAgentIds: [...cap.defaultReply.recipientAgentIds] } : {}), projectId: input.projectId, conversationId: cap.conversationId!,
        agentId: cap.agentId, messageId: input.eventId, runId: cap.runId, fence: cap.v3FencingToken,
        steeringInjectionId: injection, streamId: randomUUID(), sequence: 0, text: "", state: "open", acceptedAt: input.createdAt,
        leasedAt: t.leasedAt, runStartedAt: t.runStartedAt, ...run.voiceReplyTiming }, c.coordinationV3.steeringInjectionIds(cap.runId), typeof operationId === "string" ? operationId : undefined);
      c.publish(cap.agentId, c.store.appendEvent(cap.agentId, { type: "voice_reply", reply: { ...run.voiceReply.snapshot } }));
    }
    const result = run.voiceReply.authorizationResult();
    return result.authorized ? result : reply.code(409).send(result);
  });
  for (const presentation of ["voice", "text"] as const) app.get<{ Params: { id: string; messageId: string; agentId: string } }>(
    presentation === "voice" ? "/api/conversations/:id/voice-replies/:messageId/:agentId" : "/api/conversations/:id/reply-streams/:messageId/:agentId", async (request, reply) => {
      const { id, messageId, agentId } = request.params;
      const chat = c.store.getConversation(id); const agent = c.store.getAgent(agentId);
      const runtime = c.coordinationV3.runtimeCommunication(messageId);
      const input = (runtime?.payload as { communication?: CommunicationEvent } | undefined)?.communication;
      if (!chat || !resourceInProduct(c.store,"conversation",id,requestProduct(request)) || !resourceInProduct(c.store,"agent",agentId,requestProduct(request)) || !activeChatResourceOwner(c.store,"conversation",id) || !agent || !activeChatResourceOwner(c.store,"agent",agentId) || agent.conversationId !== id ||
          agent.projectId !== chat.projectId || input?.conversationId !== id || input.projectId !== chat.projectId ||
          (presentation === "voice" && (input.intent !== "user_dm" || input.sender.kind !== "user" || input.sender.userId !== "local-operator" ||
          input.audience.kind !== "user_agents" || input.audience.userId !== "local-operator" ||
          input.audience.agentIds.length !== 1 || input.audience.agentIds[0] !== agentId))) {
        return reply.code(404).send({ error: "voice turn not found" });
      }
      const t = c.coordinationV3.voiceReplyRunTiming(messageId, agentId);
      const active = c.activeRuns.get(agentId)?.voiceReply?.snapshot;
      let s = active?.messageId === messageId && active.runId === t?.runId ? active
        : t?.runId ? c.store.latestVoiceReply(agentId, messageId, t.runId) : undefined;
      // A persisted draft is never a completed reply. After a crashed/ended Run,
      // retain its bytes and expose the interrupted state instead of a live spinner.
      if (s && !(active?.messageId === messageId && active.runId === t?.runId) && ["open", "streaming"].includes(s.state) && t?.runStatus &&
          !["leased", "running"].includes(t.runStatus)) {
        s = { ...s, state: "failed", sequence: s.sequence + 1 };
        // The durable Run outcome owns this projection; reading status adds no event.
      }
      return { messageId, acceptedAt: input.createdAt, ...t,
        memoryExposure: await voiceMemoryExposure({...c.memoryPorts,validateMemory:async runId=>localMemoryFor(app)?.speechStatus(runId)??false}, { agentId, projectId: chat.projectId, conversationId: id, messageId, runId: t?.runId }),
        ...(s?.messageId === messageId && s.runId === t?.runId ? { reply: { ...s } } : {}) } satisfies VoiceReplyStatus;
    });
}
