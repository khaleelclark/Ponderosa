import type {
  ConversationChannel,
  ConversationDecisionEventDto,
  ConversationMessageDto,
  TeamOperationalEventDto,
} from "@ponderosa/core";
import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { api } from "../api";
import {
  highlightFocusedMessage,
  projectedMessageIdForFocus,
  scrollFocusedMessageIntoView,
} from "../messageFocus";
import {
  mergeConversationMessages,
  mergeDecisionEvents,
} from "./ConversationView.helpers";
import type { ConversationActiveView } from "./useConversationActiveView";

type OlderMain = {
  messages: ConversationMessageDto[];
  decisionEvents: ConversationDecisionEventDto[];
  cursor?: string;
  hasMore: boolean;
};

type OlderCollaboration = {
  messages: ConversationMessageDto[];
  operations: TeamOperationalEventDto[];
  cursor?: string;
  operationCursor?: string;
  hasMore: boolean;
  operationHasMore: boolean;
};

export function useConversationMessageFocusRefs(): {
  focusedMessage: MutableRefObject<string | undefined>;
  focusedMessageHighlightDisposer: MutableRefObject<(() => void) | undefined>;
} {
  const focusedMessage = useRef<string>();
  const focusedMessageHighlightDisposer = useRef<() => void>();
  return { focusedMessage, focusedMessageHighlightDisposer };
}

export function useConversationMessageFocusCleanup(
  focusedMessageHighlightDisposer: MutableRefObject<
    (() => void) | undefined
  >,
): void {
  useEffect(() => () => {
    focusedMessageHighlightDisposer.current?.();
    focusedMessageHighlightDisposer.current = undefined;
  }, []);
}

export function useConversationMessageFocusEffect({
  activeView,
  collaborationMessages,
  collaborationQuery,
  conversationId,
  detailQuery,
  focusedMessage,
  focusedMessageHighlightDisposer,
  focusMessageId,
  initialView,
  messages,
  setActiveView,
  setOlderCollaboration,
  setOlderMain,
}: {
  activeView: ConversationActiveView;
  collaborationMessages: ConversationMessageDto[];
  collaborationQuery: {
    data?: { messages?: ConversationMessageDto[] };
  };
  conversationId: string;
  detailQuery: {
    data?: {
      messages?: ConversationMessageDto[];
      decisionEvents?: ConversationDecisionEventDto[];
    };
  };
  focusedMessage: MutableRefObject<string | undefined>;
  focusedMessageHighlightDisposer: MutableRefObject<
    (() => void) | undefined
  >;
  focusMessageId: string | undefined;
  initialView: ConversationChannel | undefined;
  messages: ConversationMessageDto[];
  setActiveView: Dispatch<SetStateAction<ConversationActiveView>>;
  setOlderCollaboration: Dispatch<
    SetStateAction<OlderCollaboration | undefined>
  >;
  setOlderMain: Dispatch<SetStateAction<OlderMain | undefined>>;
}): void {
  useEffect(() => {
    if (
      !focusMessageId ||
      focusedMessage.current === focusMessageId ||
      focusedMessage.current === `missing:${focusMessageId}`
    )
      return;
    const focusView = initialView ?? "main";
    if (activeView !== focusView) {
      setActiveView(focusView);
      return;
    }
    const focusedMessages =
      focusView === "collaboration" ? collaborationMessages : messages;
    const projectedId = projectedMessageIdForFocus(
      focusedMessages,
      focusMessageId,
    );
    if (!projectedId) {
      if (focusedMessage.current !== `loading:${focusMessageId}`) {
        focusedMessage.current = `loading:${focusMessageId}`;
        if (focusView === "collaboration") {
          void api
            .getCollaborationView(
              conversationId,
              100,
              undefined,
              focusMessageId,
            )
            .then(page => {
              setOlderCollaboration(current => ({
                messages: mergeConversationMessages(
                  page.messages,
                  current?.messages ?? [],
                  collaborationQuery.data?.messages ?? [],
                ),
                operations: current?.operations ?? [],
                cursor: page.history?.cursor,
                operationCursor: current?.operationCursor,
                hasMore: page.history?.hasMore ?? false,
                operationHasMore: current?.operationHasMore ?? false,
              }));
              focusedMessage.current = page.messages.length
                ? undefined
                : `missing:${focusMessageId}`;
            })
            .catch(() => {
              focusedMessage.current = undefined;
            });
        } else {
          void api
            .getConversation(conversationId, 100, undefined, focusMessageId)
            .then(page => {
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
              focusedMessage.current = page.messages.length
                ? undefined
                : `missing:${focusMessageId}`;
            })
            .catch(() => {
              focusedMessage.current = undefined;
            });
        }
      }
      return;
    }
    const target = document.getElementById(`master-message-${projectedId}`);
    if (!target) return;
    scrollFocusedMessageIntoView(target);
    target.focus({ preventScroll: true });
    focusedMessageHighlightDisposer.current?.();
    focusedMessageHighlightDisposer.current = highlightFocusedMessage(target);
    focusedMessage.current = focusMessageId;
  }, [
    activeView,
    collaborationMessages,
    collaborationQuery.data?.messages,
    conversationId,
    detailQuery.data?.messages,
    focusMessageId,
    initialView,
    messages,
  ]);
}
