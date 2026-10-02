import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { api } from "../src/api";
import { AttentionSurface } from "../src/components/AttentionSurface";
import { NotificationPanel } from "../src/components/NotificationPanel";
import { notificationTechnicalFocusId } from "../src/technicalFocus";
import { queryKeys } from "../src/queryKeys";
import { createPonderosaTheme } from "../src/theme";
import "@fontsource-variable/inter";
import "../src/global.css";

const base = { projectId: "project", projectLabel: "Glance", conversationId: "chat", conversationTitle: "Watch support",
  agentId: "richmond", agentTitle: "Richmond", kind: "operational", category: "coordination", severity: "attention",
  status: "open", createdAt: "2026-10-01T12:00:00Z" } as const;
let items: WorkspaceNotificationDto[] = [
  { ...base, id: "unknown", title: "Richmond's assignment needs review",
    body: "The provider disconnected before it could confirm the final result.",
    workContext: { kind: "request", recordId: "watch-123456789012", state: "outcome_unknown",
      occurredAt: "2026-10-01T11:59:00Z", assignment: "Add a watch complication", traceId: "trace-1" },
    resolution: { kind: "coordination_request", requestId: "watch-123456789012", traceId: "trace-1",
      recipientAgentId: "richmond", recipientTitle: "Richmond", assignment: "Add a watch complication",
      outcome: "outcome_unknown", retryAvailable: true } },
  { ...base, id: "join", agentId: "manager", agentTitle: "Manager", title: "Manager could not collect the required results",
    body: "The required combination of assignment results could no longer be collected.",
    workContext: { kind: "join", recordId: "wait-987654321012", state: "impossible", occurredAt: "2026-10-01T11:58:00Z" } },
  { ...base, id: "historical-one", projectLabel: "Marketing", conversationTitle: "Website copy",
    agentId: undefined, agentTitle: undefined, title: "A coordinated assignment needs a decision",
    body: "The coordinated workflow could not finish automatically." },
  { ...base, id: "historical-two", projectLabel: "Marketing", conversationTitle: "Release review",
    agentId: undefined, agentTitle: undefined, title: "A coordinated assignment needs a decision",
    body: "The coordinated workflow could not finish automatically." },
];
if (new URLSearchParams(location.search).has("long")) {
  const assignment = "Review the mobile layout and preserve the existing receipt and retry authority. ".repeat(8).trim();
  items = items.map(item => item.id === "unknown" ? {
    ...item, workContext: { ...item.workContext!, assignment }, resolution: { ...item.resolution!, assignment },
  } : item);
}
const calls: Array<{ kind: string; id?: string; options?: unknown }> = [];
function record(kind: string, id?: string, options?: unknown) {
  calls.push({ kind, id, options }); document.body.dataset.calls = JSON.stringify(calls);
}
const page = () => ({ items: items.filter(i => i.status === "open"),
  openActionCount: items.filter(i => i.status === "open").length,
  unacknowledgedActionCount: items.filter(i => i.status === "open" && !i.acknowledgedAt).length, unreadUpdateCount: 0 });
api.listNotifications = async () => page() as never;
api.acknowledgeNotifications = async ids => {
  ids.forEach(id => record("review", id));
  items = items.map(i => ids.includes(i.id) ? { ...i, acknowledgedAt: new Date().toISOString() } : i);
  return { acknowledged: ids.length };
};
api.setNotificationStatus = async (id, status) => {
  record("status", id, status); items = items.map(i => i.id === id ? { ...i, status } : i); return items.find(i => i.id === id)!;
};
api.retryCoordinationRequest = async (id, options) => { record("retry", id, options); return {} as never; };
api.getConversation = async id => ({ conversation: { id, title: "Watch support", projectId: "project" } }) as never;
api.listConversations = async () => { record("unexpected-chat-directory"); throw new Error("Notification labels must use the bounded server projection"); };
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function Probe() {
  const query = useQuery({ queryKey: queryKeys.notifications.all, queryFn: () => api.listNotifications() });
  if (new URLSearchParams(location.search).has("panel")) return <NotificationPanel open
    projects={[{ id: "project", label: "Glance" } as never]} firstPage={query.data} firstPageRevision={1}
    getFirstPageRevision={() => 1} onClose={() => {}} onNavigate={route => record("navigate", undefined, route)} />;
  return <AttentionSurface notifications={query.data?.items ?? []} onOpen={item => record("open", item.id, notificationTechnicalFocusId(item))} />;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><Box sx={{ height: "100dvh", overflow: "hidden" }}><Probe /></Box></QueryClientProvider>
</ThemeProvider>);
