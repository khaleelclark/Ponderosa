import { Alert, Box, Stack } from "@mui/material";
import { Children, type ReactNode } from "react";
import { ScrollToLatestButton } from "./scroll";
import { ChatPagination } from "./ChatPagination";
import type { ChatFollowLatest, ChatHistoryPage } from "./contracts";
import { useChatScroll } from "./useChatScroll";

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
}: {
  layoutKey: string;
  follow?: ChatFollowLatest;
  history?: ChatHistoryPage;
  layout: ChatSurfaceLayout;
  label?: string;
  empty?: ReactNode;
  children: ReactNode;
  beforeMessages?: ReactNode;
}): JSX.Element {
  const scroll = useChatScroll(layoutKey, follow);
  const isEmpty = Children.count(children) === 0;
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
        className="chat-scroll-region ponderosa-scroll"
        ref={scroll.scrollRef}
        spacing={0}
        tabIndex={0}
        onScroll={scroll.onScroll}
        sx={{
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
              scroll.preparePrepend();
              history.onLoadEarlier();
            },
          } : undefined} />
          {children}
          {isEmpty && empty ? typeof empty === "string" ? <Alert severity="info">{empty}</Alert> : empty : null}
        </Stack>
      </Stack>
      <ScrollToLatestButton visible={scroll.showScrollToLatest} onClick={scroll.scrollToLatest} />
    </Box>
  );
}
