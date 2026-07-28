import type {
  ConversationDecisionEventDto,
  ConversationMessageDto,
  TeamOperationalEventDto,
} from "@ponderosa/core";
import { useMemo, useState } from "react";
import { api } from "../api";
import { compactDefined } from "../collections";
import {
  useCollaborationView,
  useConversation,
} from "../hooks/queries";
import { chatMessageLayoutKey } from "./chat/ChatMessages";
import {
  decisionChoice,
  mergeConversationMessages,
  mergeDecisionEvents,
  mergeOperationalEvents,
  type MainTimelineEntry,
} from "./ConversationView.helpers";
import type { ConversationActiveView } from "./useConversationActiveView";

interface OlderMainHistory {
  messages: ConversationMessageDto[];
  decisionEvents: ConversationDecisionEventDto[];
  cursor?: string;
  hasMore: boolean;
}

interface OlderCollaborationHistory {
  messages: ConversationMessageDto[];
  operations: TeamOperationalEventDto[];
  cursor?: string;
  operationCursor?: string;
  hasMore: boolean;
  operationHasMore: boolean;
}

export function useConversationHistory(
  conversationId: string,
  activeView: ConversationActiveView,
) {
  const detailQuery = useConversation(conversationId);
  // Team Chat is a comparatively expensive operational projection. Keep it
  // dormant while ordinary Chat is visible; React Query fetches the latest page
  // when the user actually switches views.
  const collaborationQuery = useCollaborationView(
    conversationId,
    100,
    activeView === "collaboration",
  );
  const [olderMain, setOlderMain] = useState<OlderMainHistory>();
  const [olderCollaboration, setOlderCollaboration] =
    useState<OlderCollaborationHistory>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const messages = useMemo(
    () =>
      mergeConversationMessages(
        olderMain?.messages ?? [],
        compactDefined(detailQuery.data?.messages ?? []),
      ),
    [detailQuery.data?.messages, olderMain?.messages],
  );
  const agents = useMemo(
    () => compactDefined(detailQuery.data?.agents ?? []),
    [detailQuery.data?.agents],
  );
  const decisionEvents = useMemo(
    () =>
      mergeDecisionEvents(
        olderMain?.decisionEvents ?? [],
        detailQuery.data?.decisionEvents ?? [],
      ),
    [detailQuery.data?.decisionEvents, olderMain?.decisionEvents],
  );
  const mainTimeline = useMemo<MainTimelineEntry[]>(() => {
    const entries: MainTimelineEntry[] = [
      ...messages.map(message => ({
        kind: "message" as const,
        id: `message:${message.id}`,
        at: message.createdAt,
        message,
      })),
      ...decisionEvents.flatMap((event): MainTimelineEntry[] => {
        if (event.kind === "decision") {
          return [
            {
              kind: "decision",
              id: event.id,
              at: event.createdAt,
              event,
            },
          ];
        }
        const choice = decisionChoice(event.decision);
        return choice
          ? [
              {
                kind: "decision-response",
                id: event.id,
                at: event.createdAt,
                event,
                choice,
              },
            ]
          : [];
      }),
    ];
    return entries.sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
  }, [decisionEvents, messages]);
  const collaborationMessages = useMemo(
    () =>
      mergeConversationMessages(
        olderCollaboration?.messages ?? [],
        compactDefined(collaborationQuery.data?.messages ?? []),
      ),
    [collaborationQuery.data?.messages, olderCollaboration?.messages],
  );
  const operationalEvents = useMemo(
    () =>
      mergeOperationalEvents(
        olderCollaboration?.operations ?? [],
        compactDefined(collaborationQuery.data?.operations ?? []),
      ),
    [collaborationQuery.data?.operations, olderCollaboration?.operations],
  );
  const messageLayoutKey = mainTimeline.map(entry => entry.id).join(":");
  const collaborationLayoutKey = chatMessageLayoutKey(collaborationMessages);
  const operationalLayoutKey = operationalEvents.length
    ? `${operationalEvents.length}:${operationalEvents.at(-1)?.id ?? ""}`
    : "0";
  const mainHistory = olderMain ?? {
    messages: [],
    decisionEvents: [],
    cursor: detailQuery.data?.history?.cursor,
    hasMore: detailQuery.data?.history?.hasMore ?? false,
  };
  const collaborationHistory = olderCollaboration ?? {
    messages: [],
    operations: [],
    cursor: collaborationQuery.data?.history?.cursor,
    operationCursor: collaborationQuery.data?.operationHistory?.cursor,
    hasMore: collaborationQuery.data?.history?.hasMore ?? false,
    operationHasMore:
      collaborationQuery.data?.operationHistory?.hasMore ?? false,
  };
  const loadOlderHistory = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      if (activeView === "main") {
        if (!mainHistory.hasMore || !mainHistory.cursor) return;
        const page = await api.getConversation(
          conversationId,
          100,
          mainHistory.cursor,
        );
        setOlderMain(current => ({
          messages: mergeConversationMessages(
            page.messages,
            current?.messages ?? [],
            detailQuery.data?.messages ?? [],
          ),
          decisionEvents: mergeDecisionEvents(
            page.decisionEvents ?? [],
            current?.decisionEvents ?? [],
            detailQuery.data?.decisionEvents ?? [],
          ),
          cursor: page.history?.cursor,
          hasMore: page.history?.hasMore ?? false,
        }));
      } else {
        const loadMessages =
          collaborationHistory.hasMore && Boolean(collaborationHistory.cursor);
        const loadOperations =
          collaborationHistory.operationHasMore &&
          Boolean(collaborationHistory.operationCursor);
        if (!loadMessages && !loadOperations) return;
        const page = await api.getCollaborationView(
          conversationId,
          100,
          loadMessages ? collaborationHistory.cursor : undefined,
          undefined,
          loadOperations ? collaborationHistory.operationCursor : undefined,
        );
        setOlderCollaboration(current => ({
          messages: loadMessages
            ? mergeConversationMessages(
                page.messages,
                current?.messages ?? [],
                collaborationQuery.data?.messages ?? [],
              )
            : (current?.messages ?? []),
          operations: loadOperations
            ? mergeOperationalEvents(
                page.operations ?? [],
                current?.operations ?? [],
                collaborationQuery.data?.operations ?? [],
              )
            : (current?.operations ?? []),
          cursor: loadMessages ? page.history?.cursor : current?.cursor,
          operationCursor: loadOperations
            ? page.operationHistory?.cursor
            : current?.operationCursor,
          hasMore: loadMessages ? (page.history?.hasMore ?? false) : false,
          operationHasMore: loadOperations
            ? (page.operationHistory?.hasMore ?? false)
            : false,
        }));
      }
    } finally {
      setLoadingOlder(false);
    }
  };

  return {
    agents,
    collaborationHistory,
    collaborationLayoutKey,
    collaborationMessages,
    collaborationQuery,
    detailQuery,
    loadOlderHistory,
    loadingOlder,
    mainHistory,
    mainTimeline,
    messageLayoutKey,
    messages,
    operationalEvents,
    operationalLayoutKey,
    setOlderCollaboration,
    setOlderMain,
  };
}
