import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CollaborationTimeline } from "../src/components/ConversationView.parts";
import { ChatPane } from "../src/components/chat/ChatPane";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { createPonderosaTheme } from "../src/theme";
import { AllChatView } from "../src/components/AllChatView";
import { api } from "../src/api";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import "../src/global.css";

const fixture = await fetch("/fixture.json").then(response => response.json());
api.getAllChat = async () => fixture.allPage;
api.listProjects = async () => [{ id: fixture.projectId, label: "Disposable", hostPath: "/disposable", defaultEngine: "codex" }] as never;
api.listEngines = async () => [];
api.getWorkspacePreferences = async () => ({ profile: { displayName: "Operator", handle: "operator" } }) as never;
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.getWorkspaceDirectory = async () => ({ items: [], starredItems: [], total: 0, history: { limit: 100, hasMore: false } }) as never;
const params = new URLSearchParams(location.search);
const onOpenAgent = (id: string) => { document.body.dataset.openAgent = id; };
const title = (id: string | undefined) => fixture.agents.find((agent: { id: string }) => agent.id === id)?.title ?? "Unavailable Agent";
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme(params.get("theme") === "light" ? "light" : "dark")}><CssBaseline />
  <QueryClientProvider client={new QueryClient()}><MutationNotificationProvider><Box sx={{ p: 1, height: "100dvh", display: "flex", flexDirection: "column", minWidth: 0 }}>
    {params.get("surface") === "all" ? <AllChatView onNavigate={route => { if (route.kind === "agent") onOpenAgent(route.agentId); }} />
      : params.get("surface") === "agent" ? <ChatPane messages={fixture.messages.map((message: object, seq: number) => ({ ...message, seq, agentId: fixture.agents[0].id }))}
      projectId={fixture.projectId} agentName="Cedar" onOpenAgent={onOpenAgent} /> : <CollaborationTimeline collaborationMessages={fixture.messages}
        operationalEvents={[]} projectId={fixture.projectId} healthByAgentId={new Map()} agentTitle={title}
        agentIdForHandle={(handle) => fixture.agents.find((agent: { handle: string }) => agent.handle === handle)?.id}
        onOpenAgent={onOpenAgent} />}
  </Box></MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
