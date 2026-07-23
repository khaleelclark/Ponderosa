import { Button, Stack } from "@mui/material";
import type { ChatHistoryPage } from "./contracts";

export function ChatPagination({ page }: { page?: ChatHistoryPage }): JSX.Element | null {
  if (!page?.hasEarlier) return null;
  return (
    <Stack sx={{ alignItems: "center", mb: 1.5 }}>
      <Button size="small" color="inherit" disabled={page.loading} onClick={page.onLoadEarlier}>
        {page.loading ? "Loading…" : page.label ?? "Load Older History"}
      </Button>
    </Stack>
  );
}
