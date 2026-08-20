import { Button, Stack } from "@mui/material";
import type { ChatHistoryPage } from "./contracts";
import { useInfiniteScrollSentinel } from "../../hooks/useInfiniteScrollSentinel";
import { LoadingState } from "../LoadingState";

export function ChatPagination({ page }: { page?: ChatHistoryPage }): JSX.Element | null {
  const sentinelRef = useInfiniteScrollSentinel({
    enabled: Boolean(page?.hasEarlier),
    loading: Boolean(page?.loading),
    onLoadMore: () => page?.onLoadEarlier(),
    rootMargin: "320px 0px 0px",
  });
  if (!page?.hasEarlier) return null;
  return (
    <Stack ref={sentinelRef} sx={{ alignItems: "center", mb: 1.5, minHeight: 32 }}>
      {page.loading ? <LoadingState resource="older history" variant="inline" /> : (
        <Button size="small" color="inherit" onClick={page.onLoadEarlier}>
          {page.label ?? "Load Older History"}
        </Button>
      )}
    </Stack>
  );
}
