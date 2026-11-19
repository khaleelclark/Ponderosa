import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { activeChatOwnerSql, type AgentStore } from "@ponderosa/agents";
import type { ChatArchivesDto } from "@ponderosa/core";
import { requestProduct } from "../product-scope.js";

export function chatArchiveHeldWork(store: AgentStore, chatId?: string): ChatArchivesDto["heldWork"] {
  const rows = store.sqlite.prepare(`
    SELECT entry.id, c.id AS chatId, c.title AS chatTitle, a.title AS agentTitle, entry.kind, entry.created_at AS createdAt,
      substr(COALESCE(json_extract(entry.payload_json,'$.dispatch.text'),json_extract(entry.payload_json,'$.text')),1,500) AS preview,
      EXISTS (SELECT 1 FROM context_rollovers r
        WHERE r.agent_id=entry.agent_id AND (
          (r.state='requested' AND entry.kind='context_rollover_handoff' AND r.id=json_extract(entry.payload_json,'$.rolloverId'))
          OR (r.state='continuation_ready' AND r.continuation_activation_id=entry.id AND EXISTS (
            SELECT 1 FROM activation_sources source JOIN agent_activations handoff ON handoff.id=source.activation_id
            WHERE source.source_kind='context_rollover' AND source.source_id=r.id AND handoff.kind='context_rollover_handoff'
              AND (json_type(handoff.payload_json,'$.settingsTransition')='object' OR json_type(handoff.payload_json,'$.workingCopyTransition')='object')
          ))
        )
      ) AS blocksNewWork
    FROM activation_sources hold JOIN agent_activations entry ON entry.id=hold.activation_id
    JOIN agents a ON a.id=entry.agent_id JOIN conversations c ON c.id=hold.source_id
    WHERE hold.source_kind='chat_archive_hold' AND entry.state IN ('pending','retry_pending')
      AND a.deleted_at IS NULL AND c.branch_id IS NULL AND ${activeChatOwnerSql('c')}
      AND NOT EXISTS (SELECT 1 FROM chat_archives archive
        WHERE archive.conversation_id=c.id OR archive.conversation_id=a.conversation_id)
      ${chatId ? 'AND (c.id=? OR a.conversation_id=?)' : ''}
    ORDER BY blocksNewWork DESC, entry.created_at, entry.id LIMIT 200
  `).all(...(chatId ? [chatId, chatId] : [])) as (Omit<ChatArchivesDto["heldWork"][number], "blocksNewWork"> & { blocksNewWork: number })[];
  return rows.map(row => ({ ...row, blocksNewWork: Boolean(row.blocksNewWork) }));
}

interface Dependencies {
  store: AgentStore;
  hasLocalRun(agentId: string): boolean;
  hasProviderOperation(agentId: string): boolean;
  stopRun(agentId: string, runId: string, key: string): void;
  drainProviders(agentIds: Set<string>): Promise<void>;
  hasIntake(chatId: string): boolean;
  notifyScheduler(): void;
  publishChanged(projectId: string, chatId: string): void;
}

export function registerChatArchiveRoutes(app: FastifyInstance, deps: Dependencies): void {
  const { store } = deps;
  const db = store.sqlite;
  const inProgress = new Set<string>();
  const publishChanged = (projectId: string, chatId: string) => {
    try { deps.publishChanged(projectId, chatId); }
    catch (err) { app.log.error({ err, chatId }, "Chat archive change committed; workspace refresh remains pending"); }
  };
  const ordinaryChat = (id: string) => db.prepare(`
    SELECT c.id, c.project_id FROM conversations c
    WHERE c.id=? AND c.branch_id IS NULL AND ${activeChatOwnerSql('c')}
  `).get(id) as { id: string; project_id: string } | undefined;
  const archiveState = (id: string) => db.prepare(
    "SELECT archived_at FROM chat_archives WHERE conversation_id=?",
  ).get(id) as { archived_at: string | null } | undefined;
  const activeRuns = (id: string) => db.prepare(`
    SELECT r.agent_id AS agentId, r.id AS runId, a.title
    FROM scheduler_runs r JOIN agents a ON a.id=r.agent_id
    WHERE r.status IN ('leased','running') AND (a.conversation_id=? OR r.scope_key=?)
    ORDER BY r.id
  `).all(id, `conversation:${id}`) as { agentId: string; runId: string; title: string }[];
  app.get("/api/chat-archives", async (request, reply) => {
    if (requestProduct(request) !== "dev") return reply.code(404).send({ error: "Chat archives belong to Chats" });
    const chats = db.prepare(`
      SELECT c.id, c.project_id AS projectId, c.title, archive.archived_at AS archivedAt
      FROM chat_archives archive JOIN conversations c ON c.id=archive.conversation_id
      WHERE c.branch_id IS NULL AND ${activeChatOwnerSql('c')}
      ORDER BY archive.archived_at DESC, c.id
    `).all() as { id: string; projectId: string; title: string; archivedAt: string | null }[];
    return {
      chats: chats.flatMap(chat => chat.archivedAt ? [{ ...chat, archivedAt: chat.archivedAt, workingDirectory: store.getConversation(chat.id)?.workingDirectory }] : []),
      pendingChats: chats.flatMap(({ archivedAt, ...chat }) => archivedAt ? [] : [{ ...chat, workingDirectory: store.getConversation(chat.id)?.workingDirectory }]),
      heldWork: chatArchiveHeldWork(store),
    };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/archive-preview", async (request, reply) => {
    const { id } = request.params;
    if (requestProduct(request) !== "dev" || !ordinaryChat(id)) return reply.code(404).send({ error: "Chat not found" });
    return {
      activeRuns: activeRuns(id),
      pending: archiveState(id)?.archived_at === null,
      workingDirectory: store.getConversation(id)?.workingDirectory,
    };
  });

  app.post<{ Params: { id: string }; Body: { stopRunIds?: unknown } }>("/api/conversations/:id/archive", async (request, reply) => {
    const { id } = request.params;
    const chat = requestProduct(request) === "dev" ? ordinaryChat(id) : undefined;
    if (!chat) return reply.code(404).send({ error: "Chat not found" });
    const targets = request.body?.stopRunIds ?? [];
    if (!Array.isArray(targets) || targets.some(target => typeof target !== "string")) {
      return reply.code(400).send({ error: "Expected a list of Run IDs to stop" });
    }
    const previous = archiveState(id);
    if (previous?.archived_at) return { archived: true };
    if (inProgress.has(id) || deps.hasIntake(id)) {
      return reply.code(409).send({ error: "Wait for in-progress Chat work and try again" });
    }
    const runs = activeRuns(id);
    if (runs.some(run => !targets.includes(run.runId))) {
      return reply.code(409).send({ error: "Active Runs changed. Review the Runs before archiving." });
    }
    const ownedAgents = new Set(store.listAgents(chat.project_id)
      .filter(agent => agent.conversationId === id).map(agent => agent.id));
    const drainingAgents = new Set([...ownedAgents, ...runs.map(run => run.agentId)]);
    if ([...drainingAgents].some(deps.hasProviderOperation)) {
      return reply.code(409).send({ error: "Wait for the Agent provider operation to finish before archiving" });
    }
    // Establish the dispatch hold before stopping anything, including on
    // retries after a server restart between Stop and archive completion.
    db.prepare("INSERT OR IGNORE INTO chat_archives (conversation_id) VALUES (?)").run(id);
    inProgress.add(id);
    try {
      for (const run of runs) deps.stopRun(run.agentId, run.runId, `archive:${run.runId}`);
      const deadline = Date.now() + 8_000;
      while (activeRuns(id).length || [...drainingAgents].some(deps.hasLocalRun)) {
        if (Date.now() >= deadline) throw new Error("Run cleanup is still pending. Review the active Agents and try again.");
        await delay(80);
      }
      await deps.drainProviders(ownedAgents);
      if (!ordinaryChat(id) || deps.hasIntake(id)) throw new Error("Chat ownership or activity changed. Try again.");
      db.transaction(() => {
        db.prepare("UPDATE chat_archives SET archived_at=? WHERE conversation_id=?").run(new Date().toISOString(), id);
        db.prepare("UPDATE conversations SET updated_at=updated_at WHERE id=?").run(id);
      })();
      publishChanged(chat.project_id, id);
      return { archived: true };
    } catch (error) {
      if (!previous) {
        db.prepare("DELETE FROM chat_archives WHERE conversation_id=? AND archived_at IS NULL").run(id);
        deps.notifyScheduler();
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Chat could not be archived" });
    } finally {
      inProgress.delete(id);
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/restore", async (request, reply) => {
    const { id } = request.params;
    const chat = requestProduct(request) === "dev" ? ordinaryChat(id) : undefined;
    if (!chat) return reply.code(404).send({ error: "Chat not found" });
    if (inProgress.has(id) || archiveState(id)?.archived_at === null) {
      return reply.code(409).send({ error: "Resume the pending archive and finish cleanup before restoring this Chat" });
    }
    db.transaction(() => {
      if (!archiveState(id)) return;
      db.prepare(`
        INSERT OR IGNORE INTO activation_sources (activation_id, source_kind, source_id)
        SELECT entry.id, 'chat_archive_hold', ? FROM agent_activations entry JOIN agents a ON a.id=entry.agent_id
        WHERE entry.state IN ('pending','retry_pending') AND (entry.scope_key=? OR a.conversation_id=?)
      `).run(id, `conversation:${id}`, id);
      db.prepare("DELETE FROM chat_archives WHERE conversation_id=?").run(id);
      db.prepare("UPDATE conversations SET updated_at=updated_at WHERE id=?").run(id);
    })();
    publishChanged(chat.project_id, id);
    return { restored: true };
  });

  app.post<{ Params: { id: string }; Body: { activationId?: unknown } }>(
    "/api/conversations/:id/release-archived-work", async (request, reply) => {
      const { id } = request.params;
      const activation = request.body?.activationId;
      const chat = requestProduct(request) === "dev" ? ordinaryChat(id) : undefined;
      if (!chat) return reply.code(404).send({ error: "Chat not found" });
      if (typeof activation !== "string") return reply.code(400).send({ error: "Activation ID is required" });
      if (archiveState(id)) return reply.code(409).send({ error: "Restore the Chat first" });
      const result = db.prepare(`
        DELETE FROM activation_sources WHERE source_kind='chat_archive_hold' AND source_id=? AND activation_id=?
          AND EXISTS (SELECT 1 FROM agent_activations entry JOIN agents a ON a.id=entry.agent_id
            WHERE entry.id=activation_sources.activation_id AND entry.state IN ('pending','retry_pending') AND a.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM chat_archives archive WHERE archive.conversation_id=a.conversation_id))
      `).run(id, activation);
      if (!result.changes) return reply.code(409).send({ error: "This work is no longer held for this Chat" });
      deps.notifyScheduler();
      publishChanged(chat.project_id, id);
      return { released: true };
    },
  );
}
