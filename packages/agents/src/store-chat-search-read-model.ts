import {activeChatProductSql,activeAgentProductSql,type ProductScope} from './product-scope-sql.js';
import type Database from "better-sqlite3";
import type {
  GlobalChatSearchAuthorDto,
  GlobalChatSearchResponseDto,
} from "@ponderosa/core";
import {
  highlightedSearchSnippet,
  searchProjectedChatMessages,
  type ProjectedChatSearchCandidate,
} from "./chat-search.js";

export interface GlobalChatSearchInput {
  productScope?:ProductScope;
  query?: string;
  limit?: number;
  chatKind?: "conversation" | "agent";
  distinctChats?: boolean;
  recentLimit?: number;
  maxScannedMessages?: number;
  notificationState?: (input: {
    communicationEventIds: readonly string[];
    conversationIds: readonly string[];
  }) => {
    unreadCommunicationEventIds: readonly string[];
    unreadConversationCounts: Readonly<Record<string, number>>;
  };
}

export class AgentChatSearchReadModel {
  constructor(private readonly client: Database.Database) {}

  /**
   * Bounded global search over rebuildable human-facing communication views.
   * Project chat is preferred when one canonical message is visible on both a
   * Project chat and an Agent audit timeline, avoiding duplicate search hits.
   */
  searchGlobalChats(
    input: GlobalChatSearchInput = {},
  ): GlobalChatSearchResponseDto {
    const query = (input.query ?? "").trim();
    const limit = Math.max(1, Math.min(50, input.limit ?? 30));
    const recentLimit = Math.max(1, Math.min(20, input.recentLimit ?? 10));
    const maxScannedMessages = Math.max(
      limit,
      Math.min(20_000, input.maxScannedMessages ?? 10_000),
    );
    type SearchProjectionRow = {
      projectId: string;
      projectLabel: string;
      chatKind: "conversation" | "agent";
      chatId: string;
      chatTitle: string;
      messageId: string;
      communicationEventId: string;
      role: "user" | "assistant" | "system";
      authorAgentId: string | null;
      authorTitle: string | null;
      timestamp: string;
      text: string;
    };
    // LIMIT is applied by SQLite while walking idx_chat_search_newest. The one
    // extra row is only a truncation sentinel; it never reaches result DTOs.
    const rows = this.client
      .prepare(`
        SELECT
          search.project_id AS projectId,
          project.label AS projectLabel,
          search.chat_kind AS chatKind,
          search.chat_id AS chatId,
          COALESCE(conversation.title, chat_agent.title) AS chatTitle,
          search.message_id AS messageId,
          search.communication_event_id AS communicationEventId,
          search.role AS role,
          search.author_agent_id AS authorAgentId,
          author_agent.title AS authorTitle,
          search.timestamp AS timestamp,
          search.text AS text
        FROM chat_search_messages search
        JOIN projects project ON project.id = search.project_id
        LEFT JOIN conversations conversation
          ON search.chat_kind = 'conversation' AND conversation.id = search.chat_id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = conversation.id)
        LEFT JOIN agents chat_agent
          ON search.chat_kind = 'agent' AND chat_agent.id = search.chat_id AND chat_agent.deleted_at IS NULL
        LEFT JOIN agents author_agent ON author_agent.id = search.author_agent_id
        WHERE (conversation.id IS NOT NULL OR chat_agent.id IS NOT NULL)
          ${input.productScope?`AND ((conversation.id IS NOT NULL AND ${activeChatProductSql('conversation',input.productScope)}) OR (chat_agent.id IS NOT NULL AND ${activeAgentProductSql('chat_agent',input.productScope)}))`:''}
          AND (? IS NULL OR search.chat_kind = ?)
          AND NOT (
            search.chat_kind = 'agent' AND EXISTS (
              SELECT 1
              FROM chat_search_messages preferred
              JOIN conversations preferred_conversation
                ON preferred_conversation.id = preferred.chat_id AND NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = preferred_conversation.id)
              WHERE preferred.project_id = search.project_id
                ${input.productScope?`AND ${activeChatProductSql('preferred_conversation',input.productScope)}`:''}
                AND preferred.communication_event_id = search.communication_event_id
                AND preferred.chat_kind = 'conversation'
            )
          )
        ORDER BY search.timestamp DESC, search.chat_kind DESC, search.row_key DESC
        LIMIT ?
      `)
      .all(
        input.chatKind ?? null,
        input.chatKind ?? null,
        maxScannedMessages + 1,
      ) as SearchProjectionRow[];
    const emptyConversationCandidates = !query && input.chatKind !== "agent"
      ? this.client
        .prepare(`
          SELECT
            conversation.id AS chatId,
            conversation.title AS chatTitle,
            conversation.project_id AS projectId,
            project.label AS projectLabel,
            conversation.updated_at AS updatedAt
          FROM conversations conversation
          JOIN projects project ON project.id = conversation.project_id
          WHERE NOT EXISTS (SELECT 1 FROM conversation_deletion_receipts deleting_chat WHERE deleting_chat.conversation_id = conversation.id)
            ${input.productScope?`AND ${activeChatProductSql('conversation',input.productScope)}`:''}
          ORDER BY conversation.updated_at DESC, conversation.id DESC
          LIMIT ?
        `)
        .all(recentLimit) as Array<{
          chatId: string;
          chatTitle: string;
          projectId: string;
          projectLabel: string;
          updatedAt: string;
        }>
      : [];
    const notificationState = input.notificationState?.({
      communicationEventIds: rows.map((row) => row.communicationEventId),
      conversationIds: [
        ...rows.flatMap((row) => row.chatKind === "conversation" ? [row.chatId] : []),
        ...emptyConversationCandidates.map((conversation) => conversation.chatId),
      ],
    }) ?? { unreadCommunicationEventIds: [], unreadConversationCounts: {} };
    const unreadEventIds = new Set(notificationState.unreadCommunicationEventIds);
    const unreadConversationCounts = new Map(Object.entries(notificationState.unreadConversationCounts));
    const candidates: ProjectedChatSearchCandidate[] = rows.map(row => {
      const author: GlobalChatSearchAuthorDto = row.authorAgentId
        ? {
            kind: "agent",
            label: row.authorTitle ?? "Agent",
            agentId: row.authorAgentId,
          }
        : row.role === "user"
          ? { kind: "user", label: "User" }
          : row.role === "system"
            ? { kind: "system", label: "System" }
            : { kind: "agent", label: "Agent" };
      return {
        project: { id: row.projectId, label: row.projectLabel },
        chat: { kind: row.chatKind, id: row.chatId, title: row.chatTitle },
        messageId: row.messageId,
        communicationEventId: row.communicationEventId,
        author,
        timestamp: row.timestamp,
        text: row.text,
        unread: unreadEventIds.has(row.communicationEventId),
      };
    });

    const searched = searchProjectedChatMessages(candidates, {
      query,
      limit,
      maxScannedMessages,
      distinctChats: input.distinctChats,
    });
    const recentChats: GlobalChatSearchResponseDto["recentChats"] = [];
    const recentKeys = new Set<string>();
    const unreadAgentCounts = new Map<string, number>();
    for (const candidate of candidates.slice(0, maxScannedMessages)) {
      if (candidate.chat.kind === "agent" && candidate.unread) {
        unreadAgentCounts.set(
          candidate.chat.id,
          (unreadAgentCounts.get(candidate.chat.id) ?? 0) + 1,
        );
      }
    }
    for (const candidate of candidates.slice(0, maxScannedMessages)) {
      const key = `${candidate.project.id}\u0000${candidate.chat.kind}\u0000${candidate.chat.id}`;
      if (recentKeys.has(key)) continue;
      recentKeys.add(key);
      recentChats.push({
        project: candidate.project,
        chat: candidate.chat,
        lastActivityAt: candidate.timestamp,
        ...(candidate.text
          ? {
              snippet: highlightedSearchSnippet(candidate.text, "").snippet,
            }
          : {}),
        unreadCount:
          candidate.chat.kind === "conversation"
            ? (unreadConversationCounts.get(candidate.chat.id) ?? 0)
            : (unreadAgentCounts.get(candidate.chat.id) ?? 0),
      });
      if (recentChats.length >= recentLimit) break;
    }
    if (!query) {
      for (const conversation of emptyConversationCandidates) {
        const key = `${conversation.projectId}\u0000conversation\u0000${conversation.chatId}`;
        if (recentKeys.has(key)) continue;
        recentKeys.add(key);
        recentChats.push({
          project: {
            id: conversation.projectId,
            label: conversation.projectLabel,
          },
          chat: {
            kind: "conversation",
            id: conversation.chatId,
            title: conversation.chatTitle,
          },
          lastActivityAt: conversation.updatedAt,
          unreadCount:
            unreadConversationCounts.get(conversation.chatId) ?? 0,
        });
      }
      recentChats.sort((a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt),
      );
      recentChats.splice(recentLimit);
    }
    return {
      ...searched,
      recentChats: query ? [] : recentChats,
    };
  }
}
