import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { NotificationPanel } from "../src/components/NotificationPanel";
import { createPonderosaTheme } from "../src/theme";

api.listConversations = async () => [];

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const items: WorkspaceNotificationDto[] = [
  {
    id: "update", projectId: "project", conversationId: "chat", kind: "direct_responses",
    title: "Saratoga", body: "A message update", createdAt: "2026-09-24T12:00:00.000Z",
    action: { kind: "open_conversation", targetId: "chat" },
  },
  {
    id: "action", projectId: "project", kind: "operational", status: "open",
    title: "Needs review", body: "A current issue", createdAt: "2026-09-24T12:01:00.000Z",
    acknowledgedAt: "2026-09-24T12:02:00.000Z",
  },
];

function Fixture(): JSX.Element {
  const [actions, setActions] = useState<string[]>([]);
  api.setNotificationStatus = async (id, status) => {
    setActions((current) => [...current, `${id}:${status}`]);
    return { ...items.find((item) => item.id === id)!, status };
  };
  return <ThemeProvider theme={createPonderosaTheme("dark")}>
    <CssBaseline />
    <QueryClientProvider client={queryClient}>
      <NotificationPanel
        open
        projects={[{ id: "project", label: "Fixture Project" } as never]}
        firstPage={{
          items,
          openActionCount: 1,
          unacknowledgedActionCount: 0,
          unreadUpdateCount: 1,
        }}
        firstPageRevision={1}
        getFirstPageRevision={() => 1}
        onClose={() => setActions((current) => [...current, "closed"])}
        onNavigate={() => setActions((current) => [...current, "navigated"])}
      />
      <output id="actions">{actions.join(",")}</output>
    </QueryClientProvider>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
