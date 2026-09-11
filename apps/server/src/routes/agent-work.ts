import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type {
  AgentWorkInspectorDto,
  AgentWorkItemDetailsDto,
  AgentWorkItemDto,
} from "@ponderosa/core";
import type { FastifyInstance } from "fastify";
import { sendInspectorJson } from "../inspector-response.js";

export class AgentWorkProjection {
  constructor(
    private readonly store: Pick<
      AgentStore,
      "listAgents" | "getProjectArtifact" | "operatorCanReadProjectArtifact" | "agentCreationPending"
    >,
    private readonly coordination: Pick<
      CoordinationV3Store,
      "agentWorkItems" | "agentWorkItemDetails" | "requestLifecycleDetails"
    >,
    private readonly workspace: Pick<
      WorkspaceStore,
      "listDecisionPage" | "getDecision" | "decisionsForRuns"
    >,
  ) {}

  inspect(input: {
    projectId: string;
    conversationId?: string;
    agentId?: string;
    focusId?: string;
    limit?: number;
  }): AgentWorkInspectorDto {
    const projectAgents = this.store.listAgents(input.projectId);
    const names = new Map(projectAgents.map((agent) => [agent.id, agent.title]));
    const agentName = (id: string | undefined): string =>
      id ? names.get(id) ?? "Deleted Agent" : "You";
    const projection = this.coordination.agentWorkItems(input);
    const items = projection.items.filter((item) =>
      !item.agentIds.some((agentId) => this.store.agentCreationPending(agentId)));
    for (const item of items) {
      if (item.kind === "request") {
        item.title = `${agentName(item.requesterAgentId)} asked ${agentName(item.recipientAgentId)} to work`;
      } else if (item.kind === "join") {
        item.title = item.state === "open"
          ? `${agentName(item.agentIds[0])} is waiting for results`
          : item.state === "satisfied"
            ? `${agentName(item.agentIds[0])} received the required results`
            : `${agentName(item.agentIds[0])}'s wait ended ${item.state.replaceAll("_", " ")}`;
      } else if (item.kind === "activation") {
        item.title = item.providerRecovery
          ? `${agentName(item.agentIds[0])} is provider-blocked`
          : ["pending", "retry_pending"].includes(item.state)
          ? `${agentName(item.agentIds[0])} has a queued wake-up`
          : ["leased", "attached"].includes(item.state)
            ? `${agentName(item.agentIds[0])}'s wake-up is being attached`
            : item.state === "consumed"
              ? `${agentName(item.agentIds[0])}'s wake-up was consumed`
              : `${agentName(item.agentIds[0])}'s wake-up ended ${item.state.replaceAll("_", " ")}`;
      } else if (item.kind === "run") {
        item.title = `${agentName(item.agentIds[0])} Run`;
      } else if (item.kind === "trigger") {
        item.title = item.state === "activated"
          ? `${item.title} woke ${agentName(item.agentIds[0])}`
          : item.state === "pending"
            ? `${item.title} is waiting to wake ${agentName(item.agentIds[0])}`
            : `${item.title} ended ${item.state.replaceAll("_", " ")}`;
      }
    }

    const decisionLimit = input.limit ?? 300;
    const recentDecisionPage = this.workspace.listDecisionPage({
      projectId: input.projectId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      limit: decisionLimit + 1,
    });
    const relatedRunIds = new Set(
      items.flatMap((item) => item.kind === "run" ? [item.recordId] : []),
    );
    const relatedDecisionIds = new Set(items.flatMap((item) =>
      item.kind === "activation"
        ? item.referenceIds.flatMap((reference) =>
          /^decision:([^:]+):response$/u.exec(reference)?.[1] ?? [])
        : []));
    const decisionCandidates = new Map<
      string,
      NonNullable<ReturnType<WorkspaceStore["getDecision"]>>
    >();
    for (const decision of recentDecisionPage.decisions) {
      decisionCandidates.set(decision.id, decision);
    }
    const focusRecordId = input.focusId?.includes(":")
      ? input.focusId.slice(input.focusId.indexOf(":") + 1)
      : input.focusId;
    if (focusRecordId) {
      const focusedDecision = this.workspace.getDecision(focusRecordId);
      if (
        focusedDecision?.projectId === input.projectId
        && (!input.conversationId || focusedDecision.conversationId === input.conversationId)
        && (!input.agentId || focusedDecision.agentId === input.agentId)
      ) decisionCandidates.set(focusedDecision.id, focusedDecision);
    }
    for (const decision of this.workspace.decisionsForRuns(relatedRunIds)) {
      if (
        decision.projectId === input.projectId
        && (!input.conversationId || decision.conversationId === input.conversationId)
      ) decisionCandidates.set(decision.id, decision);
    }
    for (const decisionId of relatedDecisionIds) {
      const decision = this.workspace.getDecision(decisionId);
      if (
        decision?.projectId === input.projectId
        && (!input.conversationId || decision.conversationId === input.conversationId)
      ) decisionCandidates.set(decision.id, decision);
    }
    const orderedDecisions = [...decisionCandidates.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const decisionsTruncated = recentDecisionPage.hasMore
      || orderedDecisions.length > decisionLimit;
    const decisions = orderedDecisions.slice(0, decisionLimit);
    for (const decision of decisions) {
      if (this.store.agentCreationPending(decision.agentId)) continue;
      const runItem = items.find((item) =>
        item.kind === "run" && item.referenceIds.includes(decision.runId));
      const responseActivation = items.find((item) =>
        item.kind === "activation"
        && item.referenceIds.includes(`decision:${decision.id}:response`));
      const relatedItemIds = [runItem?.id, responseActivation?.id]
        .filter((id): id is string => Boolean(id));
      const item: AgentWorkItemDto = {
        id: `decision:${decision.id}`,
        recordId: decision.id,
        referenceIds: [decision.id],
        kind: "decision",
        state: decision.status,
        title: `${agentName(decision.agentId)} asked for your decision`,
        summary: decision.status === "pending" ? decision.question : `Decision ${decision.status}.`,
        agentIds: [decision.agentId],
        relatedItemIds,
        createdAt: decision.createdAt,
        updatedAt: decision.updatedAt,
      };
      items.push(item);
      if (runItem && !runItem.relatedItemIds.includes(item.id)) {
        runItem.relatedItemIds.push(item.id);
      }
      if (responseActivation && !responseActivation.relatedItemIds.includes(item.id)) {
        responseActivation.relatedItemIds.push(item.id);
      }
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const visited = new Set<string>();
    const traces: AgentWorkInspectorDto["traces"] = [];
    const activeStates = new Set([
      "open",
      "in_progress",
      "waiting_dependency",
      "awaiting_answer",
      "pending",
      "retry_pending",
      "attached",
      "leased",
      "running",
    ]);
    const kindOrder: AgentWorkItemDto["kind"][] = [
      "trigger",
      "request",
      "decision",
      "join",
      "activation",
      "run",
    ];
    for (
      const root of [...items].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    ) {
      if (visited.has(root.id)) continue;
      const component: AgentWorkItemDto[] = [];
      const queue = [root.id];
      while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        const current = byId.get(id);
        if (!current) continue;
        visited.add(id);
        component.push(current);
        queue.push(...current.relatedItemIds);
      }
      const ordered = component.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const headline = [...ordered]
        .sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind))[0]!;
      const componentById = new Map(ordered.map((item) => [item.id, item]));
      const needsAttention = (item: AgentWorkItemDto): boolean => {
        if (item.kind === "request") {
          return ["blocked", "failed", "outcome_unknown", "expired", "recipient_unavailable"]
            .includes(item.state);
        }
        if (item.kind === "join") return ["impossible", "expired"].includes(item.state);
        if (item.kind === "trigger") return item.state === "dead_lettered";
        if (item.kind === "activation") {
          if (!["failed", "outcome_unknown"].includes(item.state)) return false;
          return !item.relatedItemIds.some((id) => {
            const related = componentById.get(id);
            return related?.kind === "request" && related.state === "completed";
          });
        }
        if (item.kind === "run" && ["failed", "outcome_unknown"].includes(item.state)) {
          return !item.relatedItemIds.some((id) => {
            const related = componentById.get(id);
            return related?.kind === "activation"
              && ["retry_pending", "pending", "attached", "consumed"].includes(related.state);
          });
        }
        return false;
      };
      const completedRecoveryFor = (failure: AgentWorkItemDto): boolean => {
        if (
          failure.kind === "request"
          && failure.relatedItemIds.some((id) => {
            const related = componentById.get(id);
            return related?.kind === "request"
              && [
                "open",
                "in_progress",
                "waiting_dependency",
                "awaiting_answer",
                "completed",
              ].includes(related.state)
              && related.updatedAt >= failure.updatedAt;
          })
        ) return true;
        const activationIds = new Set<string>();
        const addLaterActivation = (id: string): void => {
          const candidate = componentById.get(id);
          if (candidate?.kind === "activation" && candidate.createdAt >= failure.updatedAt) {
            activationIds.add(candidate.id);
          }
        };
        for (const relatedId of failure.relatedItemIds) {
          const related = componentById.get(relatedId);
          if (!related) continue;
          addLaterActivation(related.id);
          if (failure.kind === "request" && related.kind === "join") {
            related.relatedItemIds.forEach(addLaterActivation);
          }
          if (failure.kind === "run" && related.kind === "activation") {
            related.relatedItemIds
              .filter((id) => id !== failure.id)
              .forEach(addLaterActivation);
          }
        }
        const queue = [...activationIds];
        const visitedActivations = new Set<string>();
        while (queue.length) {
          const activationId = queue.shift()!;
          if (visitedActivations.has(activationId)) continue;
          visitedActivations.add(activationId);
          const activation = componentById.get(activationId);
          if (!activation) continue;
          for (const relatedId of activation.relatedItemIds) {
            const related = componentById.get(relatedId);
            if (
              related?.kind === "run"
              && related.id !== failure.id
              && related.state === "completed"
              && related.updatedAt >= failure.updatedAt
            ) return true;
            if (
              related?.kind === "activation"
              && related.createdAt >= failure.updatedAt
              && !visitedActivations.has(related.id)
            ) queue.push(related.id);
          }
        }
        return false;
      };
      const attentionItems = ordered
        .filter(needsAttention)
        .filter((item) => !completedRecoveryFor(item));
      const active = ordered.some((item) => activeStates.has(item.state));
      const pendingDecision = ordered.some((item) =>
        item.kind === "decision" && item.state === "pending");
      const state = pendingDecision || attentionItems.length > 0
        ? "attention"
        : active ? "active" : "finished";
      const counts = new Map<AgentWorkItemDto["kind"], number>();
      for (const item of ordered) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
      const providerBlockedActivations = ordered.filter((item) => item.kind === "activation" && item.providerRecovery);
      const blockedJoinIds = new Set(providerBlockedActivations.flatMap((activation) =>
        activation.relatedItemIds.filter((id) => componentById.get(id)?.kind === "join")));
      const joins = ordered.filter((item) => item.kind === "join" && blockedJoinIds.has(item.id));
      const joinMemberRequestIds = new Set(joins.flatMap((join) => join.joinMemberRequestIds ?? []));
      const joinRequests = ordered.filter((item) =>
        item.kind === "request" && joinMemberRequestIds.has(item.recordId));
      const completedRequests = joinRequests.filter((item) => item.state === "completed");
      const blockedRecovery = providerBlockedActivations[0]?.providerRecovery;
      const synthesisPending = Boolean(blockedRecovery && joins.length > 0 && completedRequests.length > 0);
      const countSummary = kindOrder.flatMap((kind) => {
        const count = counts.get(kind);
        return count
          ? [`${count} ${kind === "activation" ? "wake-up" : kind}${count === 1 ? "" : "s"}`]
          : [];
      }).join(" · ");
      const summary = blockedRecovery
        ? synthesisPending
          ? `${completedRequests.length} child result${completedRequests.length === 1 ? " is" : "s are"} ready. ${agentName(providerBlockedActivations[0]?.agentIds[0])} synthesis is pending because the provider is unavailable.`
          : `${agentName(providerBlockedActivations[0]?.agentIds[0])} is provider-blocked. The same wake-up remains eligible for retry.`
        : countSummary;
      traces.push({
        id: `trace:${headline.id}`,
        state,
        title: headline.title,
        summary,
        agentIds: [...new Set(ordered.flatMap((item) => item.agentIds))],
        itemIds: ordered.map((item) => item.id),
        ...(blockedRecovery ? { coordinationRecovery: {
          state: synthesisPending ? "synthesis_pending" as const : "provider_blocked" as const,
          classification: blockedRecovery.classification,
          retryEligible: blockedRecovery.retryEligible,
          nextRetryAt: blockedRecovery.nextRetryAt,
          activationIds: providerBlockedActivations.map((item) => item.recordId),
          requestIds: joinRequests.map((item) => item.recordId),
          joinIds: joins.map((item) => item.recordId),
          completedChildResults: completedRequests.length,
        } } : {}),
        createdAt: ordered[0]!.createdAt,
        updatedAt: ordered.reduce(
          (latest, item) => item.updatedAt > latest ? item.updatedAt : latest,
          ordered[0]!.updatedAt,
        ),
      });
    }
    const traceRank = { attention: 0, active: 1, finished: 2 } as const;
    traces.sort((left, right) =>
      traceRank[left.state] - traceRank[right.state]
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id));
    items.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    const itemBudget = input.limit ?? 300;
    const selectedTraces: typeof traces = [];
    const selectedItemIds = new Set<string>();
    const itemMatchesFocus = (item: AgentWorkItemDto): boolean => Boolean(
      input.focusId && (
        item.id === input.focusId
        || item.recordId === input.focusId
        || item.referenceIds.includes(input.focusId)
        || item.recordId === focusRecordId
        || Boolean(focusRecordId && item.referenceIds.includes(focusRecordId))
      ),
    );
    const focusedTrace = input.focusId
      ? traces.find((trace) => trace.itemIds.some((id) => {
        const item = byId.get(id);
        return item ? itemMatchesFocus(item) : false;
      }))
      : undefined;
    if (focusedTrace) {
      selectedTraces.push(focusedTrace);
      focusedTrace.itemIds.forEach((id) => selectedItemIds.add(id));
    }
    for (const trace of traces) {
      if (trace.id === focusedTrace?.id) continue;
      const additions = trace.itemIds.filter((id) => !selectedItemIds.has(id));
      if (
        selectedTraces.length > 0
        && selectedItemIds.size + additions.length > itemBudget
        && trace.state === "finished"
      ) continue;
      selectedTraces.push(trace);
      additions.forEach((id) => selectedItemIds.add(id));
    }
    selectedTraces.sort((left, right) =>
      traceRank[left.state] - traceRank[right.state]
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id));
    const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
    const responseTruncated = selectedTraces.length < traces.length;
    return {
      projectId: input.projectId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      generatedAt: new Date().toISOString(),
      ...(projection.truncated || decisionsTruncated || responseTruncated
        ? { truncated: true }
        : {}),
      agents: projectAgents.map((agent) => ({ id: agent.id, title: agent.title })),
      traces: selectedTraces,
      items: selectedItems,
    };
  }

  itemDetails(input: {
    projectId: string;
    conversationId?: string;
    kind: AgentWorkItemDto["kind"];
    recordId: string;
  }): AgentWorkItemDetailsDto | undefined {
    const focused = this.coordination.agentWorkItems({
      projectId: input.projectId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      focusId: `${input.kind}:${input.recordId}`,
      limit: 1,
    }).items.find((item) => item.kind === input.kind && item.recordId === input.recordId);
    if (focused?.agentIds.some((agentId) => this.store.agentCreationPending(agentId))) {
      return undefined;
    }
    let details: AgentWorkItemDetailsDto["details"] | undefined;
    let requestLifecycle: AgentWorkItemDetailsDto["requestLifecycle"];
    if (input.kind === "decision") {
      const decision = this.workspace.getDecision(input.recordId);
      if (
        !decision
        || decision.projectId !== input.projectId
        || this.store.agentCreationPending(decision.agentId)
        || (input.conversationId && decision.conversationId !== input.conversationId)
      ) return undefined;
      details = [
        { label: "Decision ID", value: decision.id },
        { label: "Run ID", value: decision.runId },
        { label: "Mode", value: decision.mode },
        { label: "Blocking", value: decision.blocking ? "yes" : "no" },
        ...(decision.context ? [{ label: "Context", value: decision.context }] : []),
        ...(decision.response
          ? [{ label: "Response", value: JSON.stringify(decision.response) }]
          : []),
      ];
    } else {
      details = this.coordination.agentWorkItemDetails({
        ...input,
        kind: input.kind as Exclude<AgentWorkItemDto["kind"], "decision">,
      });
      if (input.kind === "request") {
        const lifecycle = this.coordination.requestLifecycleDetails({
          projectId: input.projectId,
          ...(input.conversationId
            ? { conversationId: input.conversationId }
            : {}),
          recordId: input.recordId,
        });
        if (lifecycle) {
          requestLifecycle = {
            ...lifecycle,
            updates: lifecycle.updates.map((update) => ({
              ...update,
              artifacts: update.artifacts.map((artifact) => {
                const available = this.store.getProjectArtifact(
                  input.projectId,
                  artifact.id,
                );
                const operatorAuthorized = available
                  && this.store.operatorCanReadProjectArtifact(
                    input.projectId,
                    artifact.id,
                  );
                return operatorAuthorized
                  ? {
                      ...artifact,
                      ...(available.previewUrl
                        ? { previewUrl: available.previewUrl }
                        : {}),
                      ...(available.downloadUrl
                        ? { downloadUrl: available.downloadUrl }
                        : {}),
                    }
                  : artifact;
              }),
            })),
          };
        }
      }
    }
    return details
      ? {
        projectId: input.projectId,
        itemId: `${input.kind}:${input.recordId}`,
        recordId: input.recordId,
        details,
        ...(requestLifecycle ? { requestLifecycle } : {}),
      }
      : undefined;
  }
}

export function registerAgentWorkRoutes(
  app: FastifyInstance,
  context: {
    store: Pick<AgentStore, "getProject" | "getConversation" | "getAgent" | "agentCreationPending">;
    projection: AgentWorkProjection;
  },
): void {
  const { store, projection } = context;
  app.get<{
    Params: { id: string };
    Querystring: { conversationId?: string; agentId?: string; focusId?: string; limit?: string };
  }>("/api/projects/:id/agent-work", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (request.query.conversationId) {
      const conversation = store.getConversation(request.query.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(404).send({ error: "conversation not found in project" });
      }
    }
    if (request.query.agentId) {
      const agent = store.getAgent(request.query.agentId);
      if (!agent || agent.projectId !== project.id || store.agentCreationPending(agent.id)) {
        return reply.code(404).send({ error: "agent not found in project" });
      }
    }
    const parsedLimit = request.query.limit === undefined
      ? undefined
      : Number(request.query.limit);
    if (
      parsedLimit !== undefined
      && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1_000)
    ) {
      return reply.code(400).send({ error: "limit must be an integer between 1 and 1000" });
    }
    const focusId = request.query.focusId?.trim();
    if (request.query.focusId !== undefined && (!focusId || focusId.length > 500)) {
      return reply.code(400).send({ error: "focusId must be between 1 and 500 characters" });
    }
    const result = projection.inspect({
      projectId: project.id,
      ...(request.query.conversationId
        ? { conversationId: request.query.conversationId }
        : {}),
      ...(request.query.agentId ? { agentId: request.query.agentId } : {}),
      ...(focusId ? { focusId } : {}),
      ...(parsedLimit ? { limit: parsedLimit } : {}),
    });
    return sendInspectorJson(reply, request.headers["accept-encoding"], result);
  });

  app.get<{
    Params: { id: string; kind: string; recordId: string };
    Querystring: { conversationId?: string };
  }>("/api/projects/:id/agent-work/items/:kind/:recordId", async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (request.query.conversationId) {
      const conversation = store.getConversation(request.query.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        return reply.code(404).send({ error: "conversation not found in project" });
      }
    }
    const kinds = new Set<AgentWorkItemDto["kind"]>([
      "request",
      "join",
      "activation",
      "run",
      "trigger",
      "decision",
    ]);
    if (!kinds.has(request.params.kind as AgentWorkItemDto["kind"])) {
      return reply.code(400).send({ error: "invalid Agent work item kind" });
    }
    const result = projection.itemDetails({
      projectId: project.id,
      ...(request.query.conversationId
        ? { conversationId: request.query.conversationId }
        : {}),
      kind: request.params.kind as AgentWorkItemDto["kind"],
      recordId: request.params.recordId,
    });
    if (!result) {
      return reply.code(404).send({ error: "Agent work item not found in scope" });
    }
    return sendInspectorJson(reply, request.headers["accept-encoding"], result);
  });
}
