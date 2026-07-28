import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import type {
  AgentDto,
  AllChatItemDto,
  AllChatPageDto,
  CommunicationEvent,
  CommunicationProjection,
  GlobalChatSearchAuthorDto,
  GlobalChatSearchResponseDto,
  MessageDto,
  ProjectDto,
  ProjectedCommunicationMessage,
} from "@ponderosa/core";
import { deriveCommunicationBehavior } from "@ponderosa/core";
import type { Db } from "./db.js";
import { chatSearchMessages } from "./schema.js";
import {
  AgentChatSearchReadModel,
  type GlobalChatSearchInput,
} from "./store-chat-search-read-model.js";
import type { ContextReadBoundary, ContextSourcePage } from "./store-types.js";

interface CommunicationIndexView {
  byId: Map<string, CommunicationEvent>;
}

interface ProjectionIndexView {
  projections: CommunicationProjection[];
  byTuple: Map<string, CommunicationProjection>;
}

type ProjectedMessagePage = {
  messages: ProjectedCommunicationMessage[];
  hasMore: boolean;
  cursor?: string;
};

export class AgentChatFeedProjection {
  private readonly chatSearch: AgentChatSearchReadModel;

  constructor(
    private readonly db: Db,
    private readonly client: Database.Database,
    private readonly communicationIndex: (projectId: string) => CommunicationIndexView,
    private readonly projectionIndex: (projectId: string) => ProjectionIndexView,
    private readonly communicationProjectionAllowed: (
      projectId: string,
      projection: CommunicationProjection,
    ) => boolean,
    private readonly readProjectedCommunicationMessages: (
      projectId: string,
      surface: CommunicationProjection["surface"],
      projectionKey: string,
      limit?: number,
    ) => ProjectedCommunicationMessage[],
    private readonly readProjectedCommunicationMessagePage: (
      projectId: string,
      surface: CommunicationProjection["surface"],
      projectionKey: string,
      input: { limit: number; cursor?: string; focusId?: string },
    ) => ProjectedMessagePage,
    private readonly materializeProjectedCommunicationMessages: (
      projectId: string,
      projections: CommunicationProjection[],
    ) => ProjectedCommunicationMessage[],
    private readonly rowToAgentDto: (agentId: string) => AgentDto | undefined,
    private readonly getAgent: (agentId: string) => AgentDto | undefined,
    private readonly listAgents: (projectId: string) => AgentDto[],
    private readonly listProjects: () => ProjectDto[],
    private readonly encodeHistoryCursor: (input: {
      stream: string;
      scope: string;
      orderKey: string;
      rowKey: string;
    }) => string,
    private readonly decodeHistoryCursor: (
      cursor: string,
      stream: string,
      scope: string,
    ) => { orderKey: string; rowKey: string },
  ) {
    this.chatSearch = new AgentChatSearchReadModel(client);
  }

  private globalChatSearchRowKey(projection: Pick<CommunicationProjection, "eventId" | "surface" | "projectionKey">): string {
    return JSON.stringify([projection.surface, projection.projectionKey, projection.eventId]);
  }

  /** Increment one rebuildable search row from one bounded projection record. */
  upsertGlobalChatSearchProjection(projectId: string, projection: CommunicationProjection): void {
    const rowKey = this.globalChatSearchRowKey(projection);
    const chatKind = projection.surface === "conversation"
      ? "conversation"
      : projection.surface === "collaboration_view"
        ? "collaboration"
      : projection.surface === "direct_agent_audit"
        ? "agent"
        : undefined;
    const message = projection.message;
    const event = this.communicationIndex(projectId).byId.get(projection.eventId);
    if (!chatKind || !message || !event || !this.communicationProjectionAllowed(projectId, projection)) {
      this.db.delete(chatSearchMessages).where(eq(chatSearchMessages.rowKey, rowKey)).run();
      this.refreshAllChatFeedEvent(projectId, projection.eventId);
      return;
    }
    const canonicalRole = event.sender.kind === "agent"
      ? "assistant"
      : event.sender.kind === "user"
        ? "user"
        : message.role;
    const authorAgentId = event.sender.kind === "agent" ? event.sender.agentId : message.authorAgentId;
    const behavior = deriveCommunicationBehavior(event);
    this.db.insert(chatSearchMessages).values({
      rowKey,
      projectId,
      chatKind,
      chatId: projection.projectionKey,
      messageId: message.messageId,
      communicationEventId: event.eventId,
      role: canonicalRole,
      authorAgentId: authorAgentId ?? null,
      timestamp: message.createdAt,
      orderKey: message.orderKey ?? message.createdAt,
      text: message.renderedText ?? event.text,
      conversationId: event.conversationId ?? null,
      communicationIntent: event.intent,
      senderKind: event.sender.kind,
      senderAgentId: event.sender.kind === "agent" ? event.sender.agentId : null,
      contextPolicy: behavior.contextPolicy,
    }).onConflictDoUpdate({
      target: chatSearchMessages.rowKey,
      set: {
        projectId,
        chatKind,
        chatId: projection.projectionKey,
        messageId: message.messageId,
        communicationEventId: event.eventId,
        role: canonicalRole,
        authorAgentId: authorAgentId ?? null,
        timestamp: message.createdAt,
        orderKey: message.orderKey ?? message.createdAt,
        text: message.renderedText ?? event.text,
        conversationId: event.conversationId ?? null,
        communicationIntent: event.intent,
        senderKind: event.sender.kind,
        senderAgentId: event.sender.kind === "agent" ? event.sender.agentId : null,
        contextPolicy: behavior.contextPolicy,
      },
    }).run();
    this.refreshAllChatFeedEvent(projectId, projection.eventId);
  }

  /** Choose one active placement for a canonical communication. This work is
   * paid when a placement/lifecycle event changes, never on each Messages read. */
  private refreshAllChatFeedEvent(projectId: string, eventId: string): void {
    const row = this.client.prepare(`
      SELECT search.row_key AS rowKey, search.order_key AS orderKey
      FROM chat_search_messages search
      LEFT JOIN conversations conversation
        ON search.chat_kind IN ('conversation', 'collaboration')
        AND conversation.id = search.chat_id AND conversation.archived = 0
      LEFT JOIN agents chat_agent
        ON search.chat_kind = 'agent'
        AND chat_agent.id = search.chat_id AND chat_agent.archived = 0
      WHERE search.project_id = ? AND search.communication_event_id = ?
        AND (conversation.id IS NOT NULL OR chat_agent.id IS NOT NULL)
      ORDER BY CASE search.chat_kind
        WHEN 'conversation' THEN 0
        WHEN 'collaboration' THEN 1
        ELSE CASE WHEN search.chat_id = search.author_agent_id THEN 2 ELSE 3 END
      END, search.chat_id, search.row_key
      LIMIT 1
    `).get(projectId, eventId) as { rowKey: string; orderKey: string } | undefined;
    if (!row) {
      this.client.prepare(`
        DELETE FROM all_chat_feed_projection
        WHERE project_id = ? AND communication_event_id = ?
      `).run(projectId, eventId);
      return;
    }
    this.client.prepare(`
      INSERT INTO all_chat_feed_projection(
        project_id, communication_event_id, row_key, order_key
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, communication_event_id) DO UPDATE SET
        row_key = excluded.row_key, order_key = excluded.order_key
    `).run(projectId, eventId, row.rowKey, row.orderKey);
  }

  refreshAllChatFeedProject(projectId: string): void {
    const eventIds = this.client.prepare(`
      SELECT DISTINCT communication_event_id AS eventId
      FROM chat_search_messages WHERE project_id = ?
    `).all(projectId) as Array<{ eventId: string }>;
    for (const { eventId } of eventIds) this.refreshAllChatFeedEvent(projectId, eventId);
  }

  /** Rebuild the disposable global Chat search index from canonical ledgers. */
  rebuildGlobalChatSearchProjection(): void {
    this.db.delete(chatSearchMessages).run();
    this.client.prepare(`DELETE FROM all_chat_feed_projection`).run();
    for (const project of this.listProjects()) {
      for (const projection of this.projectionIndex(project.id).projections) {
        this.upsertGlobalChatSearchProjection(project.id, projection);
      }
    }
  }

  getProjectedAgentMessages(agentId: string, limit?: number): MessageDto[] {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return [];
    const projected = this.readProjectedCommunicationMessages(agent.projectId, "direct_agent_audit", agentId, limit);
    return this.projectedAgentMessageDtos(agentId, projected);
  }

  getProjectedAgentMessagePage(
    agentId: string,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: MessageDto[]; hasMore: boolean; cursor?: string } {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return { messages: [], hasMore: false };
    const page = this.readProjectedCommunicationMessagePage(agent.projectId, "direct_agent_audit", agentId, input);
    return { ...page, messages: this.projectedAgentMessageDtos(agentId, page.messages) };
  }

  getProjectedAgentMessageById(agentId: string, id: string): MessageDto | undefined {
    const agent = this.rowToAgentDto(agentId);
    if (!agent) return undefined;
    const row = this.client.prepare(`
      SELECT communication_event_id AS eventId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'agent' AND chat_id = ?
        AND (message_id = ? OR communication_event_id = ?)
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(agent.projectId, agentId, id, id) as { eventId: string } | undefined;
    if (!row) return undefined;
    const projection = this.projectionIndex(agent.projectId).byTuple.get(
      `${row.eventId}\u0000direct_agent_audit\u0000${agentId}`,
    );
    if (!projection) return undefined;
    return this.projectedAgentMessageDtos(
      agentId,
      this.materializeProjectedCommunicationMessages(agent.projectId, [projection]),
    )[0];
  }

  getAgentPrivateContextSourcePage(
    agentId: string,
    input: {
      limit: number;
      conversationId?: string;
      before?: ContextReadBoundary;
      excludeCommunicationEventId?: string;
      includeAuthoredBroadcasts: boolean;
    },
  ): ContextSourcePage<MessageDto> {
    const agent = this.getAgent(agentId);
    if (!agent) return { items: [], hasMore: false };
    const limit = Math.max(1, Math.min(input.limit, 100));
    const read = (intentPredicate: string, extra: unknown[] = []) => this.client.prepare(`
        SELECT communication_event_id AS eventId, timestamp AS createdAt, message_id AS messageId
        FROM chat_search_messages
        WHERE project_id = ? AND chat_kind = 'agent' AND chat_id = ?
          AND ${input.conversationId ? "conversation_id = ?" : "conversation_id IS NULL"}
          AND ${intentPredicate}
          ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
          ${input.before ? "AND (timestamp < ? OR (timestamp = ? AND message_id < ?))" : ""}
        ORDER BY timestamp DESC, message_id DESC LIMIT ?
      `).all(...[
        agent.projectId,
        agentId,
        ...(input.conversationId ? [input.conversationId] : []),
        ...extra,
        ...(input.excludeCommunicationEventId ? [input.excludeCommunicationEventId] : []),
        ...(input.before ? [input.before.createdAt, input.before.createdAt, input.before.id] : []),
        limit + 1,
      ]) as Array<{ eventId: string; createdAt: string; messageId: string }>;
    const privateRows = read("communication_intent IN ('user_dm', 'collaboration')");
    const authoredBroadcastRows = input.includeAuthoredBroadcasts
      ? read("communication_intent = 'broadcast' AND sender_agent_id = ?", [agentId])
      : [];
    const rows = [...privateRows, ...authoredBroadcastRows]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.messageId.localeCompare(left.messageId));
    const selected = rows.slice(0, limit);
    const index = this.projectionIndex(agent.projectId);
    const projected = selected.flatMap((row) => {
      const projection = index.byTuple.get(`${row.eventId}\u0000direct_agent_audit\u0000${agentId}`);
      return projection ? [projection] : [];
    });
    return {
      hasMore: privateRows.length > limit || authoredBroadcastRows.length > limit || rows.length > limit,
      items: this.projectedAgentMessageDtos(
        agentId,
        this.materializeProjectedCommunicationMessages(agent.projectId, projected),
      ).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
    };
  }

  private projectedAgentMessageDtos(agentId: string, projected: ProjectedCommunicationMessage[]): MessageDto[] {
    const projectId = this.rowToAgentDto(agentId)?.projectId;
    const communicationById = projectId
      ? this.communicationIndex(projectId).byId
      : new Map<string, CommunicationEvent>();
    return projected
      .flatMap((message) => {
        if (message.sequence === undefined || message.role === "system") return [];
        const communication = communicationById.get(message.eventId);
        return [{
          id: message.messageId,
          communicationEventId: message.eventId,
          ...(communication
            ? { communicationIntent: communication.intent }
            : {}),
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          agentId,
          seq: message.sequence,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.authorAgentId ? { authorAgentId: message.authorAgentId } : {}),
          ...(message.executionId ? { executionId: message.executionId } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          ...(message.document ? { document: message.document } : {}),
          ...(message.citations?.length ? { citations: message.citations } : {}),
        } satisfies MessageDto];
      });
  }

  /**
   * Bounded global search over rebuildable human-facing communication views.
   * Project chat is preferred when one canonical message is visible on both a
   * Project chat and an Agent audit timeline, avoiding duplicate search hits.
   */
  searchGlobalChats(
    input: GlobalChatSearchInput = {},
  ): GlobalChatSearchResponseDto {
    return this.chatSearch.searchGlobalChats(input);
  }

  /**
   * Read one deduplicated, workspace-wide page of authored communication.
   * Project and Team placements are preferred over their duplicate Agent audit
   * projections. The rebuildable index supplies only bounded placement keys;
   * text is rematerialized from the canonical Communication ledger so edits are
   * reflected without making SQLite authoritative.
   */
  getAllChatPage(input: { limit?: number; cursor?: string } = {}): AllChatPageDto {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const boundary = input.cursor
      ? this.decodeHistoryCursor(input.cursor, "all-chat", "workspace")
      : undefined;
    type AllChatRow = {
      rowKey: string;
      projectId: string;
      projectLabel: string;
      chatKind: "conversation" | "collaboration" | "agent";
      chatId: string;
      chatTitle: string;
      messageId: string;
      eventId: string;
      role: "user" | "assistant" | "system";
      authorAgentId: string | null;
      authorTitle: string | null;
      orderKey: string;
    };
    const rows = this.client.prepare(`
      SELECT
        search.row_key AS rowKey,
        search.project_id AS projectId,
        project.label AS projectLabel,
        search.chat_kind AS chatKind,
        search.chat_id AS chatId,
        COALESCE(conversation.title, chat_agent.title) AS chatTitle,
        search.message_id AS messageId,
        search.communication_event_id AS eventId,
        search.role AS role,
        search.author_agent_id AS authorAgentId,
        author_agent.title AS authorTitle,
        feed.order_key AS orderKey
      FROM all_chat_feed_projection feed
      JOIN chat_search_messages search ON search.row_key = feed.row_key
      JOIN projects project ON project.id = search.project_id
      LEFT JOIN conversations conversation
        ON search.chat_kind IN ('conversation', 'collaboration') AND conversation.id = search.chat_id
      LEFT JOIN agents chat_agent ON search.chat_kind = 'agent' AND chat_agent.id = search.chat_id
      LEFT JOIN agents author_agent ON author_agent.id = search.author_agent_id
      WHERE 1 = 1
        AND search.communication_intent IN ('broadcast', 'direct_to_user', 'user_dm')
        ${boundary ? "AND (feed.order_key < ? OR (feed.order_key = ? AND feed.row_key < ?))" : ""}
      ORDER BY feed.order_key DESC, feed.row_key DESC
      LIMIT ?
    `).all(...(boundary
      ? [boundary.orderKey, boundary.orderKey, boundary.rowKey, limit + 1]
      : [limit + 1])) as AllChatRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const activeAgentByProject = new Map([...new Set(selected.map((row) => row.projectId))].map((projectId) => [
      projectId,
      new Map(this.listAgents(projectId).filter((agent) => !agent.archived).map((agent) => [agent.id, agent] as const)),
    ]));
    const items = selected.flatMap((row): AllChatItemDto[] => {
      const surface: CommunicationProjection["surface"] = row.chatKind === "conversation"
        ? "conversation"
        : row.chatKind === "collaboration"
          ? "collaboration_view"
          : "direct_agent_audit";
      const projection = this.projectionIndex(row.projectId).byTuple.get(
        `${row.eventId}\u0000${surface}\u0000${row.chatId}`,
      );
      const message = projection
        ? this.materializeProjectedCommunicationMessages(row.projectId, [projection])[0]
        : undefined;
      const event = this.communicationIndex(row.projectId).byId.get(row.eventId);
      if (!message || !event) return [];
      const exactAudienceAgentId = event.schemaVersion === 2 && event.intent === "user_dm"
        ? event.audience.kind === "user_agent"
          ? event.audience.agentId
          : event.audience.agentIds.length === 1 ? event.audience.agentIds[0] : undefined
        : undefined;
      const targetAgentId = row.chatKind === "agent"
        ? row.chatId
        : row.authorAgentId ?? exactAudienceAgentId;
      const directMessageAgent = targetAgentId
        ? activeAgentByProject.get(row.projectId)?.get(targetAgentId)
        : undefined;
      const author: GlobalChatSearchAuthorDto = row.authorAgentId
        ? { kind: "agent", label: row.authorTitle ?? "Agent", agentId: row.authorAgentId }
        : row.role === "user"
          ? { kind: "user", label: "User" }
          : row.role === "system"
            ? { kind: "system", label: "System" }
            : { kind: "agent", label: "Agent" };
      const source: AllChatItemDto["source"] = row.chatKind === "conversation"
        ? { kind: "project", conversationId: row.chatId, title: row.chatTitle }
        : row.chatKind === "collaboration"
          ? { kind: "team", conversationId: row.chatId, title: row.chatTitle }
          : { kind: "agent", agentId: row.chatId, title: row.chatTitle };
      return [{
        communicationEventId: row.eventId,
        messageId: message.messageId,
        project: { id: row.projectId, label: row.projectLabel },
        source,
        author,
        text: message.text,
        createdAt: message.createdAt,
        ...(directMessageAgent ? {
          directMessageAgent: { id: directMessageAgent.id, title: directMessageAgent.title },
        } : {}),
      }];
    }).reverse();
    const oldest = selected.at(-1);
    return {
      items,
      history: {
        limit,
        hasMore,
        ...(hasMore && oldest ? {
          cursor: this.encodeHistoryCursor({
            stream: "all-chat", scope: "workspace", orderKey: oldest.orderKey, rowKey: oldest.rowKey,
          }),
        } : {}),
      },
    };
  }
}
