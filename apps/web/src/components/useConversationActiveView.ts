import type { ConversationDetailView } from "../routing";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { chatStateKey, readChatState, writeChatState } from "../chatState";

export type ConversationActiveView = ConversationDetailView;

interface ConversationActiveViewState {
  activeView: ConversationActiveView;
  conversationId: string;
  initialView: ConversationDetailView | undefined;
}

function readConversationActiveView(
  conversationId: string,
): ConversationActiveView {
  const saved = readChatState(
    chatStateKey("view", `conversation.${conversationId}`),
  );
  return saved === "collaboration" ||
    saved === "files" ||
    saved === "agents" ||
    saved === "triggers"
    ? saved
    : "main";
}

export function useConversationActiveViewState(
  conversationId: string,
  initialView: ConversationDetailView | undefined,
): [
  ConversationActiveView,
  Dispatch<SetStateAction<ConversationActiveView>>,
] {
  const [state, setState] = useState<ConversationActiveViewState>(() => {
    return {
      activeView: initialView ?? readConversationActiveView(conversationId),
      conversationId,
      initialView,
    };
  });

  let resolvedState = state;
  // Saved views apply only when entering another conversation. Within the same
  // conversation, a changed route is authoritative; removing its subview means
  // the canonical main Chat rather than the previously persisted view.
  if (state.conversationId !== conversationId) {
    resolvedState = {
      activeView: initialView ?? readConversationActiveView(conversationId),
      conversationId,
      initialView,
    };
    setState(resolvedState);
  } else if (state.initialView !== initialView) {
    resolvedState = {
      activeView: initialView ?? "main",
      conversationId,
      initialView,
    };
    setState(resolvedState);
  }

  const setActiveView: Dispatch<SetStateAction<ConversationActiveView>> =
    useCallback(nextView => {
      setState(current => ({
        ...current,
        activeView:
          typeof nextView === "function"
            ? nextView(current.activeView)
            : nextView,
      }));
    }, []);
  return [resolvedState.activeView, setActiveView];
}

export function useConversationResetEffect({
  collaborationVisited,
  conversationId,
  focusedMessage,
  setOlderCollaboration,
  setOlderMain,
}: {
  collaborationVisited: MutableRefObject<boolean>;
  conversationId: string;
  focusedMessage: MutableRefObject<string | undefined>;
  setOlderCollaboration(value: undefined): void;
  setOlderMain(value: undefined): void;
}): void {
  useEffect(() => {
    collaborationVisited.current = false;
    setOlderMain(undefined);
    setOlderCollaboration(undefined);
    focusedMessage.current = undefined;
  }, [conversationId]);
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
