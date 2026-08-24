import type { ConversationDetailView } from "../routing";
import {
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { chatStateKey, readChatState, writeChatState } from "../chatState";

export type ConversationActiveView = ConversationDetailView;

export function useConversationActiveViewState(
  conversationId: string,
  initialView: ConversationDetailView | undefined,
): [
  ConversationActiveView,
  Dispatch<SetStateAction<ConversationActiveView>>,
] {
  const [activeView, setActiveView] = useState<ConversationActiveView>(() => {
    if (initialView) return initialView;
    const saved = readChatState(
      chatStateKey("view", `conversation.${conversationId}`),
    );
    return saved === "collaboration" ||
      saved === "files" ||
      saved === "agents" ||
      saved === "triggers"
      ? saved
      : "main";
  });
  return [activeView, setActiveView];
}

export function useConversationResetEffect({
  collaborationVisited,
  conversationId,
  focusedMessage,
  initialView,
  setActiveView,
  setOlderCollaboration,
  setOlderMain,
}: {
  collaborationVisited: MutableRefObject<boolean>;
  conversationId: string;
  focusedMessage: MutableRefObject<string | undefined>;
  initialView: ConversationDetailView | undefined;
  setActiveView: Dispatch<SetStateAction<ConversationActiveView>>;
  setOlderCollaboration(value: undefined): void;
  setOlderMain(value: undefined): void;
}): void {
  useEffect(() => {
    collaborationVisited.current = false;
    setOlderMain(undefined);
    setOlderCollaboration(undefined);
    focusedMessage.current = undefined;
  }, [conversationId]);

  useEffect(() => {
    const saved = readChatState(
      chatStateKey("view", `conversation.${conversationId}`),
    );
    setActiveView(
      initialView ??
        (saved === "collaboration" ||
        saved === "files" ||
        saved === "agents" ||
        saved === "triggers"
          ? saved
          : "main"),
    );
  }, [conversationId, initialView]);
}

export function useConversationActiveViewPersistence(
  activeView: ConversationActiveView,
  conversationId: string,
): void {
  useEffect(() => {
    writeChatState(
      chatStateKey("view", `conversation.${conversationId}`),
      activeView,
    );
  }, [activeView, conversationId]);
}
