import {localMemoryFor} from "../local-memory.js";
import {resourceInProduct,requestProduct} from "../product-scope.js";
import { randomUUID } from "node:crypto";
import type { CommunicationEvent, VoiceReplyStatus, ReplyStreamArguments } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store, StoredLogEvent } from "@ponderosa/agents";
import type { FastifyInstance } from "fastify";
import type { ActiveRun, AgentMessageCapability } from "../app-contracts.js";
import { VoiceReplyStream } from "../voice-reply-stream.js";
import { parseReplyStreamArguments, replyStreamSource } from "../reply-stream-publication.js";

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
  for (const presentation of ["voice", "text"] as const) app.post<{ Body: ReplyStreamArguments }>(presentation === "voice" ? "/api/agent-voice-reply" : "/api/agent-reply-stream", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
    const cap = token ? c.agentMessageCapabilities.get(token) : undefined;
    const run = cap ? c.activeRuns.get(cap.agentId) : undefined;
    if (!cap || !run || run.messageCapability !== token || !c.capabilityOwnsAuthoritativeRun(cap, run)) {
      return reply.code(401).send({ error: "invalid or expired reply capability" });
    }
    let args:ReplyStreamArguments;
    try { args=parseReplyStreamArguments(request.body,presentation,c.coordinationV3.steeringInjectionIds(cap.runId)); }
    catch(error){return reply.code(400).send({error:(error as Error).message});}
    const injection = c.coordinationV3.latestAcknowledgedSteeringInjection(cap.runId);
    if (injection && args.steeringInjectionId !== injection) return reply.code(409).send({ error: "reply steering fence changed" });
    const publicationTool=args.publication?.kind==="request_update"?"ponderosa_update_request":"ponderosa_message";
    if (!cap.availableToolNames.includes(presentation === "voice" ? "ponderosa_voice_reply" : "ponderosa_reply_stream") ||
        !cap.availableToolNames.includes(publicationTool) || !run.voiceReplyStreamSupported) {
      return reply.code(409).send({ error: "reply stream unavailable; use ordinary explicit publication" });
    }
    const source = replyStreamSource(c.store,c.coordinationV3,cap,presentation,args.publication);
    if (!source) return reply.code(409).send({ error: "no accepted source on this exact publication route" });
    const operationId = request.headers["x-ponderosa-voice-operation-id"];
    if (operationId !== undefined && (typeof operationId !== "string" || !operationId.trim() || operationId.length > 512)) {
      return reply.code(400).send({ error: "invalid voice operation identity" });
    }
    try{localMemoryFor(app)?.beginSpeech(token!);}catch{return reply.code(409).send({error:'Memory changed before voice authorization; start a fresh turn'});}
    const purpose=args.acknowledgement?"acknowledgement":"answer";
    // Successful exact-source authorization after a new acknowledged steering
    // fence replaces the old stream; persist its invalidation before releasing it.
    if (run.voiceReply && run.voiceReply.snapshot.messageId !== source.messageId &&
        run.voiceReply.snapshot.steeringInjectionId !== injection) {
      if (run.voiceReply.invalidate()) c.publish(cap.agentId,c.store.appendEvent(cap.agentId,{type:"voice_reply",reply:{...run.voiceReply.snapshot}}));
      run.voiceReply=undefined;
    }
    // A received acknowledgement can hand off to a separately authorized final answer.
    if(run.voiceReply?.snapshot.purpose==="acknowledgement" && purpose==="answer" && run.voiceReply.receiptAccepted())run.voiceReply=undefined;
    if(run.voiceReply && (run.voiceReply.snapshot.presentation!==presentation || run.voiceReply.snapshot.purpose!==purpose ||
      JSON.stringify(run.voiceReply.snapshot.publication)!==JSON.stringify(source.publication) || !run.voiceReply.matchesAuthorization(typeof operationId==="string"?operationId:undefined,args.acknowledgement)))
      return reply.code(409).send({error:"A different publication already owns this Run"});
    if (!run.voiceReply) {
      const t=c.store.sqlite.prepare("SELECT created_at,started_at FROM scheduler_runs WHERE id=? AND agent_id=?").get(cap.runId,cap.agentId) as {created_at:string;started_at:string|null}|undefined;
      if(!t)return reply.code(409).send({error:"reply Run unavailable"});
      run.voiceReply = new VoiceReplyStream({ presentation,purpose,publication:source.publication,
        ...(source.publication.kind==="message"?{replyIntent:source.publication.intent,recipientAgentIds:source.publication.recipientAgentIds}:{}),
        projectId:source.projectId,conversationId:source.conversationId,agentId:cap.agentId,messageId:source.messageId,
        runId:cap.runId,fence:cap.v3FencingToken,steeringInjectionId:injection,streamId:randomUUID(),sequence:0,text:"",state:"open",acceptedAt:source.acceptedAt,
        leasedAt:t.created_at,...(t.started_at?{runStartedAt:t.started_at}:{}),...run.voiceReplyTiming },c.coordinationV3.steeringInjectionIds(cap.runId),typeof operationId==="string"?operationId:undefined,args.acknowledgement);
      c.publish(cap.agentId,c.store.appendEvent(cap.agentId,{type:"voice_reply",reply:{...run.voiceReply.snapshot}}));
    }
    const result = run.voiceReply.authorizationResult();
    return result.authorized ? result : reply.code(409).send(result);
  });
  for (const presentation of ["voice", "text"] as const) app.get<{ Params: { id: string; messageId: string; agentId: string } }>(
    presentation === "voice" ? "/api/conversations/:id/voice-replies/:messageId/:agentId" : "/api/conversations/:id/reply-streams/:messageId/:agentId", async (request, reply) => {
      const { id, messageId, agentId } = request.params;
      const chat = c.store.getConversation(id); const agent = c.store.getAgent(agentId);
      const runtime = c.coordinationV3.runtimeCommunicationForEvent(messageId,agentId);
      const input = (runtime?.payload as { communication?: CommunicationEvent } | undefined)?.communication;
      const report=presentation==="text"?c.coordinationV3.getRequest(messageId):undefined;
      const reportSource=report?.recipientAgentId===agentId && report.projectId===chat?.projectId && report.conversationId===id
        ?c.store.sqlite.prepare("SELECT created_at FROM coordination_requests WHERE id=?").get(messageId) as {created_at:string}|undefined:undefined;
      if (!chat || !resourceInProduct(c.store,"conversation",id,requestProduct(request)) || !resourceInProduct(c.store,"agent",agentId,requestProduct(request)) || !activeChatResourceOwner(c.store,"conversation",id) || !agent || !activeChatResourceOwner(c.store,"agent",agentId) || agent.conversationId !== id ||
          agent.projectId !== chat.projectId || (!reportSource && (input?.eventId !== messageId || input.conversationId !== id || input.projectId !== chat.projectId)) ||
          (presentation === "voice" && (input?.intent !== "user_dm" || input.sender.kind !== "user" || input.sender.userId !== "local-operator" ||
          input.audience.kind !== "user_agents" || input.audience.userId !== "local-operator" ||
          input.audience.agentIds.length !== 1 || input.audience.agentIds[0] !== agentId))) {
        return reply.code(404).send({ error: "voice turn not found" });
      }
      const timing: Partial<NonNullable<ReturnType<typeof c.coordinationV3.voiceReplyRunTiming>>> =
        (reportSource ? c.coordinationV3.requestReplyRunTiming(messageId,agentId)
          : c.coordinationV3.voiceReplyRunTiming(messageId,agentId,presentation)) ?? {};
      const {sourceActivationId,...t}=timing;
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
      const activationId=presentation==="text" ? sourceActivationId : runtime?.activations?.find(a=>a.agentId===agentId)?.id;
      const obligation=t?.runId && activationId ? c.coordinationV3.requiredReplyObligationsForRun(t.runId)
        .find(o=>o.sourceActivationId===activationId) : undefined;
      const canonicalReplyEventId=obligation?.satisfiedCommunicationId ?? obligation?.interimCommunicationId;
      return { messageId, acceptedAt: reportSource?.created_at??input!.createdAt, ...t, ...(canonicalReplyEventId ? {canonicalReplyEventId} : {}),
        memoryExposure:await voiceMemoryExposure({...c.memoryPorts,validateMemory:async runId=>localMemoryFor(app)?.speechStatus(runId)??false}, { agentId, projectId: chat.projectId, conversationId: id, messageId, runId: t?.runId,sourceKind:reportSource?'request':'communication' }),
        ...(s?.messageId === messageId && s.runId === t?.runId ? { reply: { ...s } } : {}) } satisfies VoiceReplyStatus;
    });
}
