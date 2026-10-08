import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  CoordinationV3Store,
  PendingActivationCapacityError,
  type AgentStore,
} from "@ponderosa/agents";
import type {
  CreateTriggerRequest,
  CreateTriggerResponse,
  RunTriggerResponse,
} from "@ponderosa/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  TriggerSourceService,
  normalizeTriggerSourceConfig,
} from "../trigger-service.js";
import { applyCollectionPageHeaders, collectionGenerationKey, sendCollectionPageError, sqliteCollectionPage, type CollectionQuery } from "../collection-page.js";
import {
  parseCreateTrigger,
  parseUpdateTrigger,
} from "../trigger-validation.js";
import {occurrenceProductSql,requestProduct,triggerProductSql} from "../product-scope.js";

interface TriggerChangedEvent {
  type: "trigger_changed";
  projectId: string;
  agentId?: string;
  triggerId: string;
  action: "created" | "updated" | "deleted";
}

export interface TriggerRoutesContext {
  readonly store: Pick<AgentStore, "sqlite" | "getAgent" | "getProject" | "getConversation">;
  readonly coordination: CoordinationV3Store;
  readonly deletingConversationIds: ReadonlySet<string>;
  readonly sources: TriggerSourceService;
  readonly webhookRawBodies: WeakMap<IncomingMessage, Buffer>;
  readonly rejectQuarantinedMutation: (
    target: { projectId: string; agentId?: string },
    reply: FastifyReply,
  ) => boolean;
  readonly appendWorkspace: (event: TriggerChangedEvent) => unknown;
  readonly reconcileOperationalNotifications: () => void;
  readonly resolveOperationalNotification: (key: string) => void;
  readonly notifyScheduler: () => void;
}

export function registerTriggerRoutes(
  app: FastifyInstance,
  context: TriggerRoutesContext,
): void {
  const {
    appendWorkspace,
    coordination,
    deletingConversationIds,
    notifyScheduler,
    reconcileOperationalNotifications,
    rejectQuarantinedMutation,
    resolveOperationalNotification,
    sources,
    store,
    webhookRawBodies,
  } = context;

  app.get<{ Querystring: CollectionQuery & { projectId?: string; targetAgentId?: string } }>("/api/triggers", async (request, reply) => {
    try {
      const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
      const product=requestProduct(request);
      const conditions: string[] = [triggerProductSql("t",product)];
      const params: unknown[] = [];
      if (request.query.targetAgentId) {
        conditions.push("t.agent_id = ?");
        params.push(request.query.targetAgentId);
      }
      if (request.query.projectId) {
        conditions.push("t.project_id = ?");
        params.push(request.query.projectId);
      }
      if (normalizedSearch) {
        conditions.push("lower(t.name || ' ' || t.instructions || ' ' || t.source_kind) LIKE ? ESCAPE '\\'");
        params.push(`%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`);
      }
      const page = sqliteCollectionPage(store.sqlite, request.query, {
        baseSql: `
          SELECT t.id, t.name AS title, t.updated_at
          FROM trigger_definitions t
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        `,
        params,
        order: "updated",
        scope: `triggers:${product}:${request.query.projectId ?? "*"}:${request.query.targetAgentId ?? "*"}`,
        generationKeys: [
          request.query.targetAgentId
            ? collectionGenerationKey("triggers", `agent:${request.query.targetAgentId}`)
            : request.query.projectId
              ? collectionGenerationKey("triggers", `project:${request.query.projectId}`)
              : "triggers",
        ],
        hydrate: id => coordination.getTriggerDefinition(id),
      });
      applyCollectionPageHeaders(reply, page);
      return page.items;
    } catch (error) {
      return sendCollectionPageError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/projects/:id/triggers",
    async (request, reply) => {
      const project = store.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      let body: CreateTriggerRequest;
      try {
        body = parseCreateTrigger(request.body);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid Automation",
        });
      }
      const conversation = store.getConversation(body.conversationId);
      if (!conversation || conversation.projectId !== project.id || conversation.deletedAt ||
          conversation.archived || deletingConversationIds.has(conversation.id)) {
        return reply.code(400).send({ error: "Automation destination must be an active Chat in this Project" });
      }
      const targetAgent = body.targetAgentId ? store.getAgent(body.targetAgentId) : undefined;
      if (!targetAgent || targetAgent.projectId !== project.id) {
        return reply.code(400).send({ error: "Automation target must be an active Agent in this Project" });
      }
      if (targetAgent.conversationId !== conversation.id) {
        return reply.code(400).send({ error: "Automation target Agent must belong to its destination Chat" });
      }
      if (
        rejectQuarantinedMutation(
          { projectId: project.id, agentId: targetAgent.id },
          reply,
        )
      ) {
        return reply;
      }
      try {
        const normalized = normalizeTriggerSourceConfig(
          body.sourceKind,
          body.sourceConfig,
        );
        const webhookSecret =
          body.sourceKind === "webhook"
            ? sources.createWebhookSecret()
            : undefined;
        const trigger = coordination.createTriggerDefinition({
          projectId: project.id,
          conversationId: body.conversationId,
          targetAgentId: body.targetAgentId,
          name: body.name,
          instructions: body.instructions,
          sourceKind: body.sourceKind,
          sourceConfig: normalized.config,
          enabled: body.enabled,
          runBudget: body.runBudget,
          nextFireAt: normalized.nextFireAt,
          secretCiphertext: webhookSecret?.ciphertext,
          secretFingerprint: webhookSecret?.fingerprint,
        });
        await sources.applyDefinitionChange(undefined, trigger);
        appendWorkspace({
          type: "trigger_changed",
          projectId: trigger.projectId,
          agentId: trigger.targetAgentId,
          triggerId: trigger.id,
          action: "created",
        });
        return reply.code(201).send({
          trigger,
          ...(webhookSecret ? { webhookSecret: webhookSecret.secret } : {}),
        } satisfies CreateTriggerResponse);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid Automation",
        });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/triggers/:id",
    async (request, reply) => {
      const current = coordination.getTriggerDefinition(request.params.id);
      if (!current) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      try {
        const body = parseUpdateTrigger(request.body, current.sourceKind);
        if (current.branchId && Object.keys(body).some(key => key !== "enabled")) throw new Error("Edit Branch trigger configuration through a new Branch deployment");
        if (current.branchId) {
          const branch = store.sqlite.prepare('SELECT deleting FROM branches WHERE id=?').get(current.branchId) as {deleting:number}|undefined;
          if (!branch || branch.deleting) return reply.code(409).send({error:'This Branch is unavailable or being deleted. Trigger intake cannot change.'});
        }
        const proposedConversationId = body.conversationId ?? current.conversationId;
        if (deletingConversationIds.has(current.conversationId) ||
            deletingConversationIds.has(proposedConversationId)) {
          return reply.code(409).send({ error: "Automation Chat deletion is in progress" });
        }
        const proposedConversation = store.getConversation(proposedConversationId);
        if (!current.branchId && (!proposedConversation || proposedConversation.projectId !== current.projectId ||
            proposedConversation.deletedAt || proposedConversation.archived)) {
          return reply.code(400).send({ error: "Automation destination must be an active Chat in this Project" });
        }
        if (rejectQuarantinedMutation(
          { projectId: current.projectId, agentId: current.targetAgentId },
          reply,
        )) return reply;
        const proposedTargetAgentId = body.targetAgentId ?? current.targetAgentId;
        if (proposedTargetAgentId !== current.targetAgentId &&
            rejectQuarantinedMutation(
              { projectId: current.projectId, agentId: proposedTargetAgentId },
              reply,
            )) return reply;
        if (body.enabled === true && current.sourceKind === "webhook" && !current.secretFingerprint) {
          throw new Error("Rotate the webhook signing secret before enabling automatic intake");
        }
        const needsReschedule =
          body.sourceConfig !== undefined ||
          (body.enabled === true && !current.enabled);
        const normalized = needsReschedule
          ? normalizeTriggerSourceConfig(
              current.sourceKind,
              body.sourceConfig ?? current.sourceConfig,
            )
          : undefined;
        const trigger = coordination.updateTriggerDefinition(current.id, {
          ...body,
          ...(normalized
            ? {
                sourceConfig: normalized.config,
                nextFireAt: normalized.nextFireAt ?? null,
              }
            : {}),
        });
        await sources.applyDefinitionChange(current, trigger);
        reconcileOperationalNotifications();
        if (body.enabled === false) {
          resolveOperationalNotification(
            `trigger:${current.id}:watcher-failed`,
          );
          resolveOperationalNotification(
            `trigger:${current.id}:filesystem-persistence`,
          );
        }
        if (trigger) {
          appendWorkspace({
            type: "trigger_changed",
            projectId: trigger.projectId,
            agentId: trigger.targetAgentId,
            triggerId: trigger.id,
            action: "updated",
          });
        }
        return trigger;
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "invalid Automation",
        });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/triggers/:id",
    async (request, reply) => {
      const current = coordination.getTriggerDefinition(request.params.id);
      if (!current) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      if (rejectQuarantinedMutation({ projectId: current.projectId, agentId: current.targetAgentId }, reply)) return reply;
      if (current.branchId) return reply.code(409).send({ error: "Remove the trigger through a Branch deployment" });
      coordination.deleteTriggerDefinition(current.id);
      await sources.applyDefinitionChange(current, undefined);
      reconcileOperationalNotifications();
      appendWorkspace({
        type: "trigger_changed",
        projectId: current.projectId,
        agentId: current.targetAgentId,
        triggerId: current.id,
        action: "deleted",
      });
      return { deleted: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/triggers/:id/rotate-secret",
    async (request, reply) => {
      const current = coordination.getTriggerDefinition(request.params.id);
      if (!current) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      if (rejectQuarantinedMutation({ projectId: current.projectId, agentId: current.targetAgentId }, reply)) return reply;
      if (current.sourceKind !== "webhook") {
        return reply
          .code(400)
          .send({ error: "only webhook Automations have signing secrets" });
      }
      const secret = sources.createWebhookSecret();
      const trigger = coordination.updateTriggerDefinition(current.id, {
        secretCiphertext: secret.ciphertext,
        secretFingerprint: secret.fingerprint,
      })!;
      appendWorkspace({
        type: "trigger_changed",
        projectId: trigger.projectId,
        agentId: trigger.targetAgentId,
        triggerId: trigger.id,
        action: "updated",
      });
      return {
        trigger,
        webhookSecret: secret.secret,
      } satisfies CreateTriggerResponse;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { additionalRuns?: number };
  }>(
    "/api/triggers/:id/allow-runs",
    async (request, reply) => {
      const current = coordination.getTriggerDefinition(request.params.id);
      if (!current) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      if (rejectQuarantinedMutation({ projectId: current.projectId, agentId: current.targetAgentId }, reply)) return reply;
      try {
        const trigger = coordination.allowTriggerRuns(
          request.params.id,
          request.body?.additionalRuns ?? 0,
        );
        if (!trigger) {
          return reply.code(404).send({ error: "Automation not found" });
        }
        reconcileOperationalNotifications();
        notifyScheduler();
        appendWorkspace({
          type: "trigger_changed",
          projectId: trigger.projectId,
          agentId: trigger.targetAgentId,
          triggerId: trigger.id,
          action: "updated",
        });
        return trigger;
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error
              ? error.message
              : "additional Runs could not be allowed",
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { confirmDisabled?: boolean } }>(
    "/api/triggers/:id/run",
    async (request, reply) => {
      const current = coordination.getTriggerDefinition(request.params.id);
      if (!current) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      if (rejectQuarantinedMutation({ projectId: current.projectId, agentId: current.targetAgentId }, reply)) return reply;
      if (!current.enabled && request.body?.confirmDisabled !== true) {
        return reply.code(409).send({
          error: "Confirm this one-time run of the disabled Automation.",
          confirmationRequired: true,
        });
      }
      try {
        const now = new Date().toISOString();
        const result = coordination.recordTriggerOccurrence({
          triggerId: current.id,
          occurrenceKey: `manual:${randomUUID()}`,
          ...(current.branchId ? { branchOperatorManual: true } : {}),
          payload: { kind: "manual_run", requestedAt: now },
          provenance: {
            source: "operator_manual_run",
            actor: "operator",
            requestedAt: now,
            automaticBudgetConsumed: false,
          },
          allowDisabled: !current.enabled,
          now,
        });
        reconcileOperationalNotifications();
        notifyScheduler();
        return result satisfies RunTriggerResponse;
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Automation could not run",
        });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/triggers/:id/occurrences",
    async request => {
      const limit = Number(request.query.limit ?? "100");
      return coordination.listTriggerOccurrences(
        request.params.id,
        Number.isFinite(limit) ? limit : 100,
        requestProduct(request),
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/agents/:id/trigger-occurrences",
    async (request, reply) => {
      if (!store.getAgent(request.params.id)) {
        return reply.code(404).send({ error: "Agent not found" });
      }
      const limit = Number(request.query.limit ?? "100");
      return coordination.listAgentTriggerOccurrences(
        request.params.id,
        Number.isFinite(limit) ? limit : 100,
        requestProduct(request),
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/projects/:id/trigger-occurrences",
    async (request, reply) => {
      if (!store.getProject(request.params.id)) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const limit = Number(request.query.limit ?? "100");
      return coordination.listProjectTriggerOccurrences(
        request.params.id,
        Number.isFinite(limit) ? limit : 100,
        requestProduct(request),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/trigger-occurrences/:id",
    async (request, reply) => {
      const product=requestProduct(request);
      const owned=store.sqlite.prepare(`SELECT 1 FROM trigger_occurrences occurrence WHERE occurrence.id=? AND ${occurrenceProductSql("occurrence",product)}`).get(request.params.id);
      if(!owned)return reply.code(404).send({ error: "Automation occurrence not found" });
      return coordination.getTriggerOccurrence(request.params.id) ??
        reply.code(404).send({ error: "Automation occurrence not found" });
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/trigger-webhooks/:id",
    async (request, reply) => {
      const contentType = request.headers["content-type"]
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        contentType !== "application/json" &&
        !contentType?.endsWith("+json")
      ) {
        return reply
          .code(415)
          .send({ error: "Automation webhooks require a JSON Content-Type" });
      }
      const eventId = request.headers["x-ponderosa-event-id"];
      const timestamp = request.headers["x-ponderosa-timestamp"];
      const signature = request.headers["x-ponderosa-signature"];
      try {
        const result = sources.verifyAndRecordWebhook({
          triggerId: request.params.id,
          eventId: Array.isArray(eventId) ? (eventId[0] ?? "") : (eventId ?? ""),
          timestamp: Array.isArray(timestamp)
            ? (timestamp[0] ?? "")
            : (timestamp ?? ""),
          signature: Array.isArray(signature)
            ? (signature[0] ?? "")
            : (signature ?? ""),
          rawBody: webhookRawBodies.get(request.raw) ?? Buffer.alloc(0),
          payload: request.body,
          remoteAddress: request.ip,
        });
        return reply.code(result.replayed ? 200 : 202).send(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "webhook rejected";
        if (error instanceof PendingActivationCapacityError) {
          return reply
            .code(429)
            .header("Retry-After", "60")
            .send({ error: message });
        }
        if (message.includes("idempotency conflict")) {
          return reply.code(409).send({ error: message });
        }
        if (message.startsWith("canonical JSON exceeds")) {
          return reply.code(400).send({ error: message });
        }
        if (
          message === "webhook Automation not found" ||
          message === "Automation Project is unavailable" ||
          message === "Automation destination or execution Agent is unavailable"
        ) {
          return reply.code(404).send({ error: message });
        }
        return reply.code(401).send({ error: message });
      }
    },
  );
}
