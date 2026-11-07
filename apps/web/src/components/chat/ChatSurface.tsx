import { Alert, Box, Stack } from "@mui/material";
import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterPaintBackgroundTask } from "../../afterPaintBackgroundTask";
import { readScrollPosition } from "../../chatState";
import { ScrollToLatestButton } from "./scroll";
import { ChatPagination } from "./ChatPagination";
import type { ChatFollowLatest, ChatHistoryPage } from "./contracts";
import { useChatScroll } from "./useChatScroll";
import { OutgoingMessageRow, useOutgoingMessage } from "./OutgoingMessage";

export type ChatSurfaceLayout = "agent" | "project" | "workspace";

export function ChatSurface({
  layoutKey,
  follow,
  history,
  layout,
  label = "Conversation",
  empty,
  children,
  beforeMessages,
  showOutgoingMessage = false,
  canonicalCommunicationIds,
  initialTranscript,
}: {
  layoutKey: string;
  follow?: ChatFollowLatest;
  history?: ChatHistoryPage;
  layout: ChatSurfaceLayout;
  label?: string;
  empty?: ReactNode;
  children: ReactNode | ((firstMountedIndex: number) => ReactNode);
  beforeMessages?: ReactNode;
  showOutgoingMessage?: boolean;
  canonicalCommunicationIds?: readonly (string | undefined)[];
  /** Only the first cold transcript render is scheduled; fetched data is unchanged. */
  initialTranscript?: { rowIds: readonly string[]; reveal?: boolean };
}): JSX.Element {
  const outgoing = useOutgoingMessage();
  const pendingId = showOutgoingMessage ? outgoing?.message?.id : undefined;
  // This is a finite aria-busy loading phase: native menu Find may not see
  // pending rows yet. Every fetched row finishes automatically and stays mounted.
  // Snapshot restoration before this surface can save any of its own scroll events.
  const [savedPosition] = useState(() => follow?.storageKey ? readScrollPosition(follow.storageKey) : undefined);
  const [mountedRows, setMountedRows] = useState(initialTranscript ? 8 : Infinity);
  const initialRows = useRef<readonly string[]>();
  const rowIds = initialTranscript?.rowIds ?? [];
  // Empty/loading -> first response is initialization, not a history mutation.
  if (initialRows.current === undefined && rowIds.length) initialRows.current = [...rowIds];
  const sequenceChanged = initialRows.current !== undefined && initialRows.current.join("\0") !== rowIds.join("\0");
  const revealAll = !initialTranscript || initialTranscript.reveal || savedPosition !== undefined;
  let firstMountedIndex = revealAll ? 0 : Math.max(0, rowIds.length - mountedRows);
  if (!revealAll && sequenceChanged && mountedRows !== Infinity) {
    // Keep every surviving mounted row until the pre-paint full reveal can use
    // its real geometry. Directly adding an unseen prefix here would skip the
    // existing prepend snapshot when the reader is away from the bottom.
    const retained = new Set(initialRows.current!.slice(-mountedRows));
    const firstRetained = rowIds.findIndex(id => retained.has(id));
    firstMountedIndex = Math.max(0, firstRetained);
  }
  const transcriptLoading = firstMountedIndex > 0;
  const rowsRef = useRef<HTMLDivElement>(null);
  // Restore against actual first-response geometry, not an empty loading view
  // that would incorrectly classify a genuine saved zero as following latest.
  const activeFollow = initialTranscript && savedPosition !== undefined && !rowIds.length && follow
    ? { ...follow, storageKey: undefined } : follow;
  const scroll = useChatScroll(`${layoutKey}:${pendingId ?? ""}:${firstMountedIndex}`, activeFollow);
  const revealTranscript = () => {
    if (!transcriptLoading) return;
    scroll.preparePrepend();
    flushSync(() => setMountedRows(Infinity));
  };

  const revealMessageInteraction = (event: { target: EventTarget | null }) => {
    // Pagination/header controls keep their pointer target in place and reveal
    // through their existing click action instead.
    if (event.target instanceof Node && rowsRef.current?.contains(event.target)) revealTranscript();
  };

  useLayoutEffect(() => {
    if (revealAll) {
      if (mountedRows !== Infinity) setMountedRows(Infinity);
      return;
    }
    if (!transcriptLoading) return;
    if (sequenceChanged) {
      scroll.preparePrepend();
      setMountedRows(Infinity);
      return;
    }
    const container = scroll.scrollRef.current, rows = rowsRef.current;
    if (!container || !rows || !container.clientHeight) {
      setMountedRows(Infinity);
    } else if (rows.getBoundingClientRect().height < container.clientHeight) {
      // Fill the actual viewport before paint. No row-height estimates or spacers.
      scroll.preparePrepend();
      setMountedRows(count => count + 8);
    }
  }, [revealAll, sequenceChanged, transcriptLoading, firstMountedIndex, mountedRows, scroll.scrollRef]);

  useEffect(() => {
    if (!transcriptLoading) return;
    const cancelBatch = afterPaintBackgroundTask(() => {
      // Capture immediately before this bounded commit, not before a yield in
      // which the reader could move. The existing scroll hook restores geometry.
      scroll.preparePrepend();
      flushSync(() => setMountedRows(count => count + 8));
    });
    const findOrSelect = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase(), target = event.target;
      const editable = target instanceof HTMLElement &&
        (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
      if (key === "f" || key === "a" && !editable) revealTranscript();
    };
    const selected = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && scroll.scrollRef.current?.contains(selection.anchorNode)) revealTranscript();
    };
    document.addEventListener("keydown", findOrSelect, true);
    document.addEventListener("selectionchange", selected);
    window.addEventListener("beforeprint", revealTranscript);
    return () => {
      cancelBatch();
      document.removeEventListener("keydown", findOrSelect, true);
      document.removeEventListener("selectionchange", selected);
      window.removeEventListener("beforeprint", revealTranscript);
    };
  }, [transcriptLoading, firstMountedIndex]);

  const renderedChildren = typeof children === "function" ? children(firstMountedIndex) : children;
  const isEmpty = !pendingId && Children.count(renderedChildren) === 0;
  const contentWidth = layout === "workspace" ? 1280 : layout === "project" ? 1180 : 1120;
  const padding = layout === "agent"
    ? { xs: 1, sm: 2, md: 3, lg: 4 }
    : layout === "project"
      ? { xs: 1, sm: 2, md: 3, lg: 4 }
      : { xs: 1.5, md: 2.5 };

  return (
    <Box sx={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <Stack
        component="section"
        aria-label={label}
        aria-busy={transcriptLoading || undefined}
        onPointerDownCapture={revealMessageInteraction}
        onTouchStartCapture={revealMessageInteraction}
        onWheelCapture={revealTranscript}
        onFocusCapture={revealMessageInteraction}
        onKeyDownCapture={revealTranscript}
        className="chat-scroll-region ponderosa-scroll"
        ref={scroll.scrollRef}
        spacing={0}
        tabIndex={0}
        onScroll={scroll.onScroll}
        sx={{
          position: "relative",
          px: padding,
          py: { xs: 1, sm: 1.5 },
          pb: 3,
          height: "100%",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overflowAnchor: "none",
          overscrollBehavior: "contain",
        }}
      >
        <Stack
          ref={scroll.contentRef}
          spacing={0}
          sx={{
            width: `min(${contentWidth}px, 100%)`,
            minHeight: "100%",
            minWidth: 0,
            flexShrink: 0,
            alignSelf: "center",
            justifyContent: "flex-end",
          }}
        >
          {beforeMessages}
          <ChatPagination page={history ? {
            ...history,
            onLoadEarlier: () => {
              revealTranscript();
              scroll.preparePrepend();
              history.onLoadEarlier();
            },
          } : undefined} />
          {initialTranscript ? <div ref={rowsRef} style={{ minWidth: 0 }}>{renderedChildren}</div> : renderedChildren}
          {showOutgoingMessage ? <OutgoingMessageRow canonicalCommunicationIds={canonicalCommunicationIds} /> : null}
          {isEmpty && empty ? typeof empty === "string" ? <Alert severity="info">{empty}</Alert> : empty : null}
        </Stack>
      </Stack>
      {transcriptLoading ? <span role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>Loading Chat messages…</span> : null}
      <ScrollToLatestButton visible={scroll.showScrollToLatest} onClick={scroll.scrollToLatest} />
    </Box>
  );
}
