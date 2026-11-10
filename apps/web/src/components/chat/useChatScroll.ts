import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { readScrollPosition, writeChatState } from "../../chatState";
import { CHAT_MESSAGE_NAVIGATION_EVENT } from "../../messageFocus";
import { isChatNearBottom, revealChatScrollbar, scrollChatToBottom } from "./scroll";
import type { ChatFollowLatest } from "./contracts";

export interface ChatScrollController {
  scrollRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  showScrollToLatest: boolean;
  onScroll(): void;
  scrollToLatest(): void;
  preparePrepend(): void;
}

export function useChatScroll(
  layoutKey: string,
  follow: ChatFollowLatest = { kind: "latest" },
): ChatScrollController {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const messageNavigationAway = useRef(false);
  const firstLayout = useRef(true);
  const restoredStorageKey = useRef<string>();
  const restoreDistance = useRef<number>();
  const readingAnchor=useRef<{node:HTMLElement;offset:number}>();
  const adjustedTop=useRef<number>();
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const captureAnchor=useCallback(()=>{
    const region=scrollRef.current;
    if(!region||followLatest.current){readingAnchor.current=undefined;return;}
    const top=region.getBoundingClientRect().top;
    const node=[...region.querySelectorAll<HTMLElement>('.chat-message-body')].find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>top&&rect.top<region.getBoundingClientRect().bottom;});
    readingAnchor.current=node?{node,offset:node.getBoundingClientRect().top-top}:undefined;
  },[]);
  const preserveAnchor=useCallback(()=>{
    const region=scrollRef.current,anchor=readingAnchor.current;
    if(!region||followLatest.current)return;
    if(anchor?.node.isConnected&&region.contains(anchor.node)){
      const delta=anchor.node.getBoundingClientRect().top-region.getBoundingClientRect().top-anchor.offset;
      if(Math.abs(delta)>.5){adjustedTop.current=Math.max(0,region.scrollTop+delta);region.scrollTop=adjustedTop.current;adjustedTop.current=region.scrollTop;}
    }
    captureAnchor();
  },[captureAnchor]);

  // Keep the reader's mounted message in place when progress above it disappears
  // or an earlier streaming body grows. Following latest uses the existing path.
  useLayoutEffect(()=>{preserveAnchor();});

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (follow.storageKey && restoredStorageKey.current !== follow.storageKey) {
      restoredStorageKey.current = follow.storageKey;
      const saved = readScrollPosition(follow.storageKey);
      if (saved !== undefined) {
        element.scrollTop = saved;
        followLatest.current = isChatNearBottom(
          element,
          follow.bottomThreshold,
        );
        setShowScrollToLatest(!followLatest.current);
        follow.onPositionChange?.(element, followLatest.current);
        firstLayout.current = false;
        captureAnchor();
        return;
      }
    }
    if (restoreDistance.current !== undefined) {
      element.scrollTop = element.scrollHeight - restoreDistance.current;
      restoreDistance.current = undefined;
      captureAnchor();
      return;
    }
    if (firstLayout.current || followLatest.current) {
      scrollChatToBottom(element);
      firstLayout.current = false;
      setShowScrollToLatest(false);
      follow.onPositionChange?.(element, true);
    }
  }, [
    follow.bottomThreshold,
    follow.storageKey,
    layoutKey,
  ]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (
      !element ||
      !content ||
      follow.followResizes === false ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) scrollChatToBottom(element);
      else preserveAnchor();
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [follow.followResizes,preserveAnchor]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const navigateToMessage = (event: Event) => {
      const requested = (event as CustomEvent<number>).detail;
      const top = Math.max(0, Math.min(requested, Math.max(0, element.scrollHeight - element.clientHeight)));
      const atLatest = isChatNearBottom({ scrollTop: top, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }, follow.bottomThreshold);
      messageNavigationAway.current = !atLatest;
      followLatest.current = atLatest;
      setShowScrollToLatest(!atLatest);
    };
    const userScrollIntent = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        const target = event.target;
        if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) ||
          target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("input, textarea, select")))) return;
      }
      messageNavigationAway.current = false;
      adjustedTop.current=undefined;
      followLatest.current = isChatNearBottom(element, follow.bottomThreshold);
      setShowScrollToLatest(!followLatest.current);
    };
    element.addEventListener(CHAT_MESSAGE_NAVIGATION_EVENT, navigateToMessage);
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) element.addEventListener(name, userScrollIntent, { passive: true });
    return () => {
      element.removeEventListener(CHAT_MESSAGE_NAVIGATION_EVENT, navigateToMessage);
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) element.removeEventListener(name, userScrollIntent);
    };
  }, [follow.bottomThreshold]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    revealChatScrollbar(element);
    const atLatest = isChatNearBottom(element, follow.bottomThreshold);
    // A queued event can still report the old bottom before smooth navigation
    // has moved. Do not let it reclaim following and cancel that navigation.
    const adjusted=adjustedTop.current!==undefined&&Math.abs(element.scrollTop-adjustedTop.current)<1;
    adjustedTop.current=undefined;
    if (!adjusted&&(!messageNavigationAway.current || !atLatest)) {
      messageNavigationAway.current = false;
      followLatest.current = atLatest;
    }
    setShowScrollToLatest(!followLatest.current);
    captureAnchor();
    follow.onPositionChange?.(element, followLatest.current);
    if (follow.storageKey) writeChatState(follow.storageKey, String(element.scrollTop));
  }, [
    follow.bottomThreshold,
    follow.storageKey,
    follow.onPositionChange,
    captureAnchor,
  ]);

  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    messageNavigationAway.current = false;
    followLatest.current = true;
    readingAnchor.current=undefined;
    scrollChatToBottom(element);
    setShowScrollToLatest(false);
    follow.onPositionChange?.(element, true);
  }, [follow.onPositionChange]);

  const preparePrepend = useCallback(() => {
    const element = scrollRef.current;
    if (element) restoreDistance.current = element.scrollHeight - element.scrollTop;
  }, []);

  return {
    scrollRef,
    contentRef,
    showScrollToLatest,
    onScroll,
    scrollToLatest,
    preparePrepend,
  };
}
