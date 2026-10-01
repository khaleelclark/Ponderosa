import { Box, CssBaseline, ThemeProvider, Typography } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetailDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { createRoot } from "react-dom/client";
import { AgentDetailPanels } from "../src/components/AgentDetail.panels";
import { createPonderosaTheme } from "../src/theme";

const query = new URLSearchParams(location.search);
const count = Number(query.get("questions") ?? 1);
const question = "After installing Glance 0.16.0 and enabling Status chip Live Update, what does Glance Settings show under Live Update status?";
const notifications: WorkspaceNotificationDto[] = Array.from({ length: count }, (_, index) => ({
  id: `question-${index}`, projectId: "project", agentId: "agent", conversationId: "chat",
  kind: "decision", status: "open", severity: "attention", title: "Richmond needs a decision",
  body: question, createdAt: `2026-10-01T12:00:0${index}.000Z`,
  decision: { id: `question-${index}`, mode: "text", options: [], allowOther: true, status: "pending" },
}));
if (query.has("warning")) notifications.push({
  id: "warning", projectId: "project", agentId: "agent", kind: "operational", status: "open",
  severity: "urgent", title: "Richmond's result needs review", body: "The provider disconnected before its final result could be confirmed.",
  createdAt: "2026-10-01T11:59:00.000Z",
});
const createdAt = "2026-09-30T21:16:00.000Z";
const messages = [{ id: "reply", agentId: "agent", role: "assistant", authorAgentId: "agent", createdAt,
  text: "I've kept this release focused on your notification.\n\n" + Array.from({ length: 18 }, (_, index) =>
    `Paragraph ${index + 1}: Live Updates and the signed APK remain available. Install it over your existing personal build and provide the status shown in Settings.`).join("\n\n"),
}] as AgentDetailDto["messages"];
const detail = { agent: { id: "agent", projectId: "project", conversationId: "chat", title: "Richmond", handle: "Richmond" },
  messages, activity: [], runOutput: [], runs: [], artifacts: [] } as unknown as AgentDetailDto;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const noop = () => {};

createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}>
    <Box sx={{ height: "100dvh", display: "grid", gridTemplateRows: "56px minmax(0, 1fr) 96px", minWidth: 0, overflow: "hidden" }}>
      <Typography component="header" sx={{ p: 2 }}>Richmond</Typography>
      <AgentDetailPanels tab="chat" detail={detail} chatMessages={messages} agentId="agent" agents={[]}
        conversations={[]} engines={[]} statusByAgentId={new Map()} healthByAgentId={new Map()} notifications={notifications}
        agentNameForId={() => "Richmond"} agentIdForHandle={() => "agent"} chatPreviewScope={{ projectId: "project", agentId: "agent" }}
        loadingOlder={false} hasOlderTelemetry={false} delegatedAgentCount={0} settingsPane={<></>}
        onOpenAgent={noop} onOpenAgentSettings={noop} onOpenMessageSource={noop} onLoadOlderChat={noop}
        onLoadOlderTelemetry={noop} onOpenFile={noop} onNewSubagent={noop} onAgentsDeleted={noop}
        onCreateTrigger={noop} onOpenTechnical={noop} onOpenArtifact={noop} onCloseTriggerSettings={noop} />
      <Box component="footer" sx={{ p: 2 }}>Message Richmond directly</Box>
    </Box>
  </QueryClientProvider>
</ThemeProvider>);
