import type Database from "better-sqlite3";
import type {
  AgentRunDto,
  CommunicationProjection,
  CommunicationAttachmentDto,
  ConversationChannel,
  ConversationDto,
  ConversationMessageDto,
  ProjectedCommunicationMessage,
  ResponseFileActivityDto,
} from "@ponderosa/core";
import type {
  ContextReadBoundary,
  ContextSourcePage,
  ConversationDeliveryIntent,
  MessageDispatchRecord,
} from "./store-types.js";

type ProjectedPage = {
  messages: ProjectedCommunicationMessage[];
  hasMore: boolean;
  cursor?: string;
};

export class AgentConversationProjectionReadModel {
  constructor(
    private readonly client: Database.Database,
    private readonly getConversation: (
      conversationId: string,
    ) => ConversationDto | undefined,
    private readonly messageDispatches: (
      projectId: string,
    ) => MessageDispatchRecord[],
    private readonly readProjectedMessages: (
      projectId: string,
      surface: CommunicationProjection["surface"],
      projectionKey: string,
      limit?: number,
    ) => ProjectedCommunicationMessage[],
    private readonly readProjectedMessagePage: (
      projectId: string,
      surface: CommunicationProjection["surface"],
      projectionKey: string,
      input: { limit: number; cursor?: string; focusId?: string },
    ) => ProjectedPage,
    private readonly findProjection: (
      projectId: string,
      eventId: string,
      surface: CommunicationProjection["surface"],
      projectionKey: string,
    ) => CommunicationProjection | undefined,
    private readonly materializeProjectedMessages: (
      projectId: string,
      projections: CommunicationProjection[],
    ) => ProjectedCommunicationMessage[],
    private readonly agentExists: (agentId: string) => boolean,
    private readonly getRuns: (agentId: string) => AgentRunDto[],
    private readonly fileActivityByExecution: (
      agentId: string,
      status: ResponseFileActivityDto["status"],
      executionIds: ReadonlySet<string>,
    ) => Map<string, ResponseFileActivityDto[]>,
    private readonly presentAttachment: (projectId: string, conversationId: string, attachment: CommunicationAttachmentDto) => CommunicationAttachmentDto,
  ) {}

  getDeliveryIntents(
    conversationId: string,
    createdAtOrAfter?: string,
  ): Array<{
    message: ConversationMessageDto;
    intent: ConversationDeliveryIntent;
    messageReceiptKey?: string;
    deliveryOrderKey: string;
  }> {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    return this.messageDispatches(conversation.projectId)
      .filter((dispatch) =>
        dispatch.conversationId === conversationId
        && (!createdAtOrAfter || dispatch.createdAt >= createdAtOrAfter))
      .flatMap((dispatch) =>
        (dispatch.deliveryIntents ?? []).map((intent) => ({
          // Dispatch records contain the complete immutable message snapshot.
          message: {
            id: dispatch.messageId,
            communicationEventId: dispatch.eventId,
            conversationId: dispatch.conversationId,
            role: dispatch.role,
            text: dispatch.renderedText,
            createdAt: dispatch.createdAt,
            authorAgentId: dispatch.authorAgentId,
            attachments: dispatch.attachments,
          },
          intent,
          messageReceiptKey: dispatch.messageReceiptKey,
          deliveryOrderKey: dispatch.orderKey,
        })));
  }

  getMessageByReceiptKey(
    conversationId: string,
    receiptKey: string,
  ): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const dispatch = this.messageDispatches(conversation.projectId)
      .find((candidate) =>
        candidate.conversationId === conversationId
        && candidate.messageReceiptKey === receiptKey);
    return dispatch
      ? this.getMessageById(conversationId, dispatch.channel, dispatch.messageId)
      : undefined;
  }

  getMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    return this.getProjectedMessages(conversationId, channel);
  }

  getProjectedMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
    limit?: number,
  ): ConversationMessageDto[] {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    const surface = channel === "collaboration"
      ? "collaboration_view"
      : "conversation";
    const projected = this.readProjectedMessages(
      conversation.projectId,
      surface,
      conversationId,
      limit,
    );
    return this.messageDtos(
      conversationId,
      projected,
      channel !== "collaboration",
    );
  }

  getCanonicalContextMessages(
    conversationId: string,
    channel: ConversationChannel = "main",
  ): ConversationMessageDto[] {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return [];
    const surface = channel === "collaboration"
      ? "collaboration_view"
      : "conversation";
    const projected = this.readProjectedMessages(
      conversation.projectId,
      surface,
      conversationId,
    );
    return this.messageDtos(conversationId, projected, false);
  }

  getOrganizationalContextSourcePage(
    conversationId: string,
    input: {
      limit: number;
      before?: ContextReadBoundary;
      excludeCommunicationEventId?: string;
    },
  ): ContextSourcePage<ConversationMessageDto> {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return { items: [], hasMore: false };
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = this.client.prepare(`
      SELECT communication_event_id AS eventId, timestamp AS createdAt, message_id AS messageId
      FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
        ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
        ${input.before ? "AND (timestamp < ? OR (timestamp = ? AND message_id < ?))" : ""}
      ORDER BY timestamp DESC, message_id DESC LIMIT ?
    `).all(...[
      conversation.projectId,
      conversationId,
      ...(input.excludeCommunicationEventId
        ? [input.excludeCommunicationEventId]
        : []),
      ...(input.before
        ? [input.before.createdAt, input.before.createdAt, input.before.id]
        : []),
      limit + 1,
    ]) as Array<{ eventId: string; createdAt: string; messageId: string }>;
    const projected = rows.slice(0, limit).flatMap((row) => {
      const projection = this.findProjection(
        conversation.projectId,
        row.eventId,
        "conversation",
        conversationId,
      );
      return projection ? [projection] : [];
    });
    return {
      hasMore: rows.length > limit,
      items: this.messageDtos(
        conversationId,
        this.materializeProjectedMessages(conversation.projectId, projected),
        false,
      ).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id)),
    };
  }

  getOrganizationalDeltaPage(
    conversationId: string,
    input: {
      limit: number;
      afterMessageId?: string;
      excludeCommunicationEventId?: string;
    },
  ): ContextSourcePage<ConversationMessageDto> & {
    cursorFound: boolean;
    latestMessageId?: string;
  } {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return { items: [], hasMore: false, cursorFound: false };
    }
    const limit = Math.max(1, Math.min(input.limit, 100));
    const cursor = input.afterMessageId
      ? this.client.prepare(`
        SELECT order_key AS orderKey, row_key AS rowKey FROM chat_search_messages
        WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
          AND context_policy = 'organizational' AND message_id = ?
        LIMIT 1
      `).get(
        conversation.projectId,
        conversationId,
        input.afterMessageId,
      ) as { orderKey: string; rowKey: string } | undefined
      : undefined;
    if (input.afterMessageId && !cursor) {
      return { items: [], hasMore: false, cursorFound: false };
    }
    const latest = this.client.prepare(`
      SELECT message_id AS messageId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(conversation.projectId, conversationId) as {
      messageId: string;
    } | undefined;
    const rows = this.client.prepare(`
      SELECT communication_event_id AS eventId
      FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = 'conversation' AND chat_id = ?
        AND context_policy = 'organizational'
        ${input.excludeCommunicationEventId ? "AND communication_event_id <> ?" : ""}
        ${cursor ? "AND (order_key > ? OR (order_key = ? AND row_key > ?))" : ""}
      ORDER BY order_key, row_key LIMIT ?
    `).all(...[
      conversation.projectId,
      conversationId,
      ...(input.excludeCommunicationEventId
        ? [input.excludeCommunicationEventId]
        : []),
      ...(cursor ? [cursor.orderKey, cursor.orderKey, cursor.rowKey] : []),
      limit + 1,
    ]) as Array<{ eventId: string }>;
    const projected = rows.slice(0, limit).flatMap((row) => {
      const projection = this.findProjection(
        conversation.projectId,
        row.eventId,
        "conversation",
        conversationId,
      );
      return projection ? [projection] : [];
    });
    return {
      cursorFound: true,
      hasMore: rows.length > limit,
      ...(latest ? { latestMessageId: latest.messageId } : {}),
      items: this.messageDtos(
        conversationId,
        this.materializeProjectedMessages(conversation.projectId, projected),
        false,
      ),
    };
  }

  getMessagePage(
    conversationId: string,
    channel: ConversationChannel,
    input: { limit: number; cursor?: string; focusId?: string },
  ): { messages: ConversationMessageDto[]; hasMore: boolean; cursor?: string } {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return { messages: [], hasMore: false };
    const surface = channel === "collaboration"
      ? "collaboration_view"
      : "conversation";
    const page = this.readProjectedMessagePage(
      conversation.projectId,
      surface,
      conversationId,
      input,
    );
    return {
      ...page,
      messages: this.messageDtos(
        conversationId,
        page.messages,
        channel !== "collaboration",
      ),
    };
  }

  getMessageById(
    conversationId: string,
    channel: ConversationChannel,
    id: string,
  ): ConversationMessageDto | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const chatKind = channel === "collaboration"
      ? "collaboration"
      : "conversation";
    const surface = channel === "collaboration"
      ? "collaboration_view"
      : "conversation";
    const row = this.client.prepare(`
      SELECT communication_event_id AS eventId FROM chat_search_messages
      WHERE project_id = ? AND chat_kind = ? AND chat_id = ?
        AND (message_id = ? OR communication_event_id = ?)
      ORDER BY order_key DESC, row_key DESC LIMIT 1
    `).get(
      conversation.projectId,
      chatKind,
      conversationId,
      id,
      id,
    ) as { eventId: string } | undefined;
    if (!row) return undefined;
    const projection = this.findProjection(
      conversation.projectId,
      row.eventId,
      surface,
      conversationId,
    );
    if (!projection) return undefined;
    return this.messageDtos(
      conversationId,
      this.materializeProjectedMessages(
        conversation.projectId,
        [projection],
      ),
    )[0];
  }

  private messageDtos(
    conversationId: string,
    projected: ProjectedCommunicationMessage[],
    includeFileActivity = true,
  ): ConversationMessageDto[] {
    const runsByAgent = new Map<string, AgentRunDto[]>();
    const statusByAgentExecution = new Map<
      string,
      ResponseFileActivityDto["status"]
    >();
    const executionScopes = new Map<string, {
      agentId: string;
      status: ResponseFileActivityDto["status"];
      executionIds: Set<string>;
    }>();
    if (includeFileActivity) {
      for (const message of projected) {
        if (
          !message.authorAgentId
          || !message.executionId
          || !this.agentExists(message.authorAgentId)
        ) continue;
        const runs = runsByAgent.get(message.authorAgentId)
          ?? this.getRuns(message.authorAgentId);
        runsByAgent.set(message.authorAgentId, runs);
        const status: ResponseFileActivityDto["status"] = runs.some((run) =>
          run.id === message.executionId
          && (run.status === "running" || run.status === "compacting"))
          ? "in_progress"
          : "completed";
        statusByAgentExecution.set(
          `${message.authorAgentId}\0${message.executionId}`,
          status,
        );
        const scopeKey = `${message.authorAgentId}:${status}`;
        const scope = executionScopes.get(scopeKey) ?? {
          agentId: message.authorAgentId,
          status,
          executionIds: new Set<string>(),
        };
        scope.executionIds.add(message.executionId);
        executionScopes.set(scopeKey, scope);
      }
    }
    const activityByScope = new Map(
      [...executionScopes].map(([scopeKey, scope]) => [
        scopeKey,
        this.fileActivityByExecution(
          scope.agentId,
          scope.status,
          scope.executionIds,
        ),
      ] as const),
    );
    return projected.map((message) => {
      let fileActivity: ResponseFileActivityDto[] | undefined;
      if (includeFileActivity && message.authorAgentId && message.executionId) {
        const status = statusByAgentExecution.get(
          `${message.authorAgentId}\0${message.executionId}`,
        );
        if (status) {
          fileActivity = activityByScope
            .get(`${message.authorAgentId}:${status}`)
            ?.get(message.executionId);
        }
      }
      return {
        id: message.messageId,
        communicationEventId: message.eventId,
        conversationId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        canonicalOrderKey: message.orderKey ?? message.createdAt,
        ...(message.authorAgentId
          ? { authorAgentId: message.authorAgentId }
          : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments.map(attachment => this.presentAttachment(
              this.getConversation(conversationId)!.projectId, conversationId, attachment)) }
          : {}),
        ...(message.artifactIds?.length ? { artifactIds: message.artifactIds } : {}),
        ...(message.document ? { document: message.document } : {}),
        ...(message.citations?.length ? { citations: message.citations } : {}),
        ...(message.executionId ? { executionId: message.executionId } : {}),
        ...(fileActivity?.length ? { fileActivity } : {}),
        ...(message.editedAt
          ? { editedAt: message.editedAt, editRevision: message.editRevision }
          : {}),
      };
    });
  }
}
