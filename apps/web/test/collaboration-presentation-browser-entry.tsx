import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CollaborationTimeline } from "../src/components/ConversationView.parts";
import { ChatPane } from "../src/components/chat/ChatPane";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const fixture = await fetch("/fixture.json").then(response => response.json());
const params = new URLSearchParams(location.search);
const onOpenAgent = (id: string) => { document.body.dataset.openAgent = id; };
const title = (id: string | undefined) => fixture.agents.find((agent: { id: string }) => agent.id === id)?.title ?? "Unavailable Agent";
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme(params.get("theme") === "light" ? "light" : "dark")}><CssBaseline />
  <QueryClientProvider client={new QueryClient()}><MutationNotificationProvider><Box sx={{ p: 1, height: "100dvh", display: "flex", flexDirection: "column", minWidth: 0 }}>
    {params.get("surface") === "agent" ? <ChatPane messages={fixture.messages.map((message: object, seq: number) => ({ ...message, seq, agentId: fixture.agents[0].id }))}
      agentName="Cedar" onOpenAgent={onOpenAgent} /> : <CollaborationTimeline collaborationMessages={fixture.messages}
        operationalEvents={[]} projectId={fixture.projectId} healthByAgentId={new Map()} agentTitle={title}
        agentIdForHandle={(handle) => fixture.agents.find((agent: { handle: string }) => agent.handle === handle)?.id}
        onOpenAgent={onOpenAgent} />}
  </Box></MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
