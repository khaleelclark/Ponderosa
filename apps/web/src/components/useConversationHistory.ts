import { mergeMainHistoryPage, type MainHistoryState } from "./ConversationView.helpers";
import type {
  ConversationMessageDto,
  TeamOperationalEventDto,
} from "@ponderosa/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api } from "../api";
import { conversationScrollKey, readChatScrollPosition } from "../chatState";
import { compactDefined } from "../collections";
import { loadRetainedData } from "../retainedData";
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
import { useMessageDeliveryReceipts } from "./useMessageDeliveryReceipts";
import type { ConversationActiveView } from "./useConversationActiveView";

type OlderMainHistory = MainHistoryState;

interface OlderCollaborationHistory {
  messages: ConversationMessageDto[];
  operations: TeamOperationalEventDto[];
  cursor?: string;
  operationCursor?: string;
  hasMore: boolean;
  operationHasMore: boolean;
}

export interface ConversationHistorySnapshot {
  conversationId: string;
  activeView: ConversationActiveView;
  olderMain?: OlderMainHistory;
  olderCollaboration?: OlderCollaborationHistory;
}

export function useConversationHistory(
  conversationId: string,
  activeView: ConversationActiveView,
  detailQuery: ReturnType<typeof useConversation>,
  historySnapshot: MutableRefObject<ConversationHistorySnapshot | undefined>,
  focusMessageId?: string,
) {
  // Team Chat is a comparatively expensive operational projection. Keep it
  // dormant while ordinary Chat is visible; React Query fetches the latest page
  // when the user actually switches views.
  const collaborationQuery = useCollaborationView(
    conversationId,
    100,
    activeView === "collaboration",
  );
  const saved = historySnapshot.current?.conversationId === conversationId ? historySnapshot.current : undefined;
  const [olderMain, setOlderMain] = useState(saved?.olderMain);
  const [olderCollaboration, setOlderCollaboration] = useState(saved?.olderCollaboration);
  useLayoutEffect(() => {
    historySnapshot.current = { conversationId, activeView, olderMain, olderCollaboration };
  }, [conversationId, activeView, olderMain, olderCollaboration, historySnapshot]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  useEffect(() => setOlderError(undefined), [activeView, conversationId]);

  // Live query updates can briefly leave sparse entries in cached collections.
  // Compact at the page boundary so historical chats remain renderable.
  const retainedMessages = useMemo(
    () =>
      mergeConversationMessages(
        olderMain?.messages ?? [],
        olderMain?.historical ? [] : compactDefined(detailQuery.data?.messages ?? []),
      ),
    [detailQuery.data?.messages, olderMain?.messages, olderMain?.historical],
  );
  const messages = useMessageDeliveryReceipts(retainedMessages, conversationId, activeView === "main");
  const agents = useMemo(
    () => compactDefined(detailQuery.data?.agents ?? []),
    [detailQuery.data?.agents],
  );
  const decisionEvents = useMemo(
    () =>
      mergeDecisionEvents(
        olderMain?.decisionEvents ?? [],
        olderMain?.historical ? [] : detailQuery.data?.decisionEvents ?? [],
      ),
    [detailQuery.data?.decisionEvents, olderMain?.decisionEvents, olderMain?.historical],
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
        left.at.localeCompare(right.at),
    );
  }, [decisionEvents, messages]);
  const retainedCollaborationMessages = useMemo(
    () =>
      mergeConversationMessages(
        olderCollaboration?.messages ?? [],
        compactDefined(collaborationQuery.data?.messages ?? []),
      ),
    [collaborationQuery.data?.messages, olderCollaboration?.messages],
  );
  const collaborationMessages = useMessageDeliveryReceipts(retainedCollaborationMessages, conversationId, activeView === "collaboration");
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
      await loadRetainedData(async () => {
        if (activeView === "main") {
          if (!mainHistory.hasMore || !mainHistory.cursor) return;
          const page = await api.getConversation(
            conversationId,
            100,
            mainHistory.cursor,
          );
          setOlderMain(current => {
            if (mainHistory.historical && current?.cursor !== mainHistory.cursor) return current;
            return mergeMainHistoryPage(page, current, detailQuery.data);
          });
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
      }, setOlderError, "Older Chat history could not be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const [readingAnchors] = useState(() => ({
    main: readChatScrollPosition(conversationScrollKey(conversationId, "main")).anchor,
    collaboration: readChatScrollPosition(conversationScrollKey(conversationId, "collaboration")).anchor,
  }));
  const restoredViews = useRef(new Set<ConversationActiveView>());
  const anchor = activeView === "main" || activeView === "collaboration" ? readingAnchors[activeView] : undefined;
  const restoringTeam = activeView === "collaboration";
  const activeQuery = restoringTeam ? collaborationQuery : detailQuery;
  const activeMessages = restoringTeam ? collaborationMessages : messages;
  const activeHistory = restoringTeam ? collaborationHistory : mainHistory;
  const canRestore = anchor && !focusMessageId && !restoredViews.current.has(activeView);
  const canLoadEarlier = activeHistory.hasMore && Boolean(activeHistory.cursor);
  const restoringReadingPosition = Boolean(canRestore && (!activeQuery.data || (canLoadEarlier &&
    !activeMessages.some(message => `master-message-${message.id}` === anchor.messageId ||
      (message.canonicalOrderKey && message.canonicalOrderKey < anchor.orderKey)))));

  useEffect(() => {
    if (!anchor) return;
    if (!restoringReadingPosition) {
      restoredViews.current.add(activeView);
    } else if (activeQuery.data && !loadingOlder && !olderError) {
      // Rehydrate contiguous pages through the saved row, just as scrolling up would.
      void loadOlderHistory();
    }
  });

  return {
    readingAnchors,
    restoringReadingPosition,
    agents,
    collaborationHistory,
    collaborationLayoutKey,
    collaborationMessages,
    collaborationQuery,
    loadOlderHistory,
    loadingOlder,
    olderError,
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
