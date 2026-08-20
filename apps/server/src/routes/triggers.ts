import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  CoordinationV3Store,
  PendingActivationCapacityError,
  type AgentStore,
} from "@ponderosa/agents";
import type {
  CreateTriggerResponse,
  RunTriggerResponse,
  TriggerDefinitionDto,
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

interface TriggerChangedEvent {
  type: "trigger_changed";
  projectId: string;
  agentId: string;
  triggerId: string;
  action: "created" | "updated" | "deleted";
}

export interface TriggerRoutesContext {
  readonly store: Pick<AgentStore, "sqlite" | "getAgent" | "getProject">;
  readonly coordination: CoordinationV3Store;
  readonly sources: TriggerSourceService;
  readonly webhookRawBodies: WeakMap<IncomingMessage, Buffer>;
  readonly rejectQuarantinedMutation: (
    target: { projectId: string; agentId: string },
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
    notifyScheduler,
    reconcileOperationalNotifications,
    rejectQuarantinedMutation,
    resolveOperationalNotification,
    sources,
    store,
    webhookRawBodies,
  } = context;

  app.get<{ Querystring: CollectionQuery & { projectId?: string; agentId?: string } }>("/api/triggers", async (request, reply) => {
    try {
      const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (request.query.agentId) {
        conditions.push("agent_id = ?");
        params.push(request.query.agentId);
      }
      if (request.query.projectId) {
        conditions.push("project_id = ?");
        params.push(request.query.projectId);
      }
      if (normalizedSearch) {
        conditions.push("lower(name || ' ' || instructions || ' ' || source_kind) LIKE ? ESCAPE '\\\\'");
        params.push(`%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`);
      }
      const page = sqliteCollectionPage(store.sqlite, request.query, {
        baseSql: `
          SELECT id, name AS title, updated_at
          FROM trigger_definitions
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        `,
        params,
        order: "updated",
        scope: `triggers:${request.query.projectId ?? "*"}:${request.query.agentId ?? "*"}`,
        generationKeys: [
          request.query.agentId
            ? collectionGenerationKey("triggers", `agent:${request.query.agentId}`)
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

  app.get<{ Params: { id: string }; Querystring: CollectionQuery }>(
    "/api/agents/:id/triggers",
    async (request, reply) => {
      if (!store.getAgent(request.params.id)) {
        return reply.code(404).send({ error: "agent not found" });
      }
      try {
        const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
        const page = sqliteCollectionPage(store.sqlite, request.query, {
          baseSql: `
            SELECT id, name AS title, updated_at
            FROM trigger_definitions
            WHERE agent_id = ?
              ${normalizedSearch ? "AND lower(name || ' ' || instructions || ' ' || source_kind) LIKE ? ESCAPE '\\\\'" : ""}
          `,
          params: normalizedSearch
            ? [request.params.id, `%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
            : [request.params.id],
          order: "updated",
          scope: `agent-triggers:${request.params.id}`,
          generationKeys: [collectionGenerationKey("triggers", `agent:${request.params.id}`)],
          hydrate: id => coordination.getTriggerDefinition(id),
        });
        applyCollectionPageHeaders(reply, page);
        return page.items;
      } catch (error) {
        return sendCollectionPageError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/agents/:id/triggers",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      if (
        rejectQuarantinedMutation(
          { projectId: agent.projectId, agentId: agent.id },
          reply,
        )
      ) {
        return reply;
      }
      try {
        const body = parseCreateTrigger(request.body);
        const normalized = normalizeTriggerSourceConfig(
          body.sourceKind,
          body.sourceConfig,
        );
        const webhookSecret =
          body.sourceKind === "webhook"
            ? sources.createWebhookSecret()
            : undefined;
        const trigger = coordination.createTriggerDefinition({
          projectId: agent.projectId,
          conversationId: body.conversationId,
          agentId: agent.id,
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
          agentId: trigger.agentId,
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
      if (rejectQuarantinedMutation(current, reply)) return reply;
      try {
        const body = parseUpdateTrigger(request.body, current.sourceKind);
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
            agentId: trigger.agentId,
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
      if (rejectQuarantinedMutation(current, reply)) return reply;
      coordination.deleteTriggerDefinition(current.id);
      await sources.applyDefinitionChange(current, undefined);
      reconcileOperationalNotifications();
      appendWorkspace({
        type: "trigger_changed",
        projectId: current.projectId,
        agentId: current.agentId,
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
      if (rejectQuarantinedMutation(current, reply)) return reply;
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
        agentId: trigger.agentId,
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
      if (rejectQuarantinedMutation(current, reply)) return reply;
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
          agentId: trigger.agentId,
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
      if (rejectQuarantinedMutation(current, reply)) return reply;
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
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/trigger-occurrences/:id",
    async (request, reply) =>
      coordination.getTriggerOccurrence(request.params.id) ??
      reply.code(404).send({ error: "Automation occurrence not found" }),
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
          message === "webhook Automation owner is unavailable"
        ) {
          return reply.code(404).send({ error: message });
        }
        return reply.code(401).send({ error: message });
      }
    },
  );
}
