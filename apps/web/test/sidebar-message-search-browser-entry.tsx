import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationMessageDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { api } from "../src/api";
import { createPonderosaTheme } from "../src/theme";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import { GlobalChatSearch } from "../src/components/GlobalChatSearch";
import { useConversationMessageFocusCleanup, useConversationMessageFocusEffect, useConversationMessageFocusRefs } from "../src/components/useConversationMessageFocus";
import type { Route } from "../src/routing";

const fixture = await (await fetch("/api/fixture")).json();
const projects = fixture.projects as ProjectDto[];
const preferences = { revision: 1, profile: { displayName: "Tester", handle: "tester", avatarId: "default-user" },
  starredProjectIds: [], projectOrder: [], chatOrder: [], agentOrder: [], triggerOrder: [], starredResourceIds: [], chatFolders: [], projectFolders: [] } as unknown as WorkspacePreferencesDto;
api.getWorkspaceDirectory = (async (kind, options) => {
  const items = kind === "project" ? projects.map(project => ({ kind, project })) : kind === "conversation" ? fixture.chats.filter((chat: { title: string }) => !options.search || chat.title.toLowerCase().includes(options.search.toLowerCase())).map((conversation: { projectId: string }) => ({ kind, project: projects.find(project => project.id === conversation.projectId), conversation })) : [];
  return { kind, items: options.summary ? [] : items, starredItems: [], total: items.length, runningCount: 0, history: { hasMore: false } };
}) as typeof api.getWorkspaceDirectory;
api.getNotificationProjection = (async () => ({ workspace: {}, allMessages: { importantCount: 0, ordinaryCount: 0, totalCount: 0 }, projects: {}, conversations: {} })) as typeof api.getNotificationProjection;
api.markProjectUsed = (async () => ({})) as typeof api.markProjectUsed;
api.markWorkspaceResourceUsed = (async () => ({})) as typeof api.markWorkspaceResourceUsed;
api.searchGlobalFiles = async () => ({ results: [], truncated: false, unavailableRoots: 0 });

function FocusedChat({ route }: { route: Extract<Route, { kind: "conversation" }> }) {
  const [older, setOlder] = useState<{ messages: ConversationMessageDto[]; decisionEvents: []; hasMore: boolean }>();
  const [view, setView] = useState<"main" | "collaboration">("main");
  const refs = useConversationMessageFocusRefs();
  useConversationMessageFocusCleanup(refs.focusedMessageHighlightDisposer);
  useConversationMessageFocusEffect({ activeView: view, collaborationMessages: [], collaborationQuery: {}, conversationId: route.conversationId,
    detailQuery: { data: { messages: [] } }, ...refs, focusMessageId: route.focusMessageId, initialView: undefined,
    messages: older?.messages ?? [], setActiveView: setView, setOlderMain: setOlder as never, setOlderCollaboration: () => {} });
  return <div className="chat-scroll-region" style={{ maxHeight: 500, overflow: "auto" }}>{older?.messages.map(message => <div id={`master-message-${message.id}`} tabIndex={-1} key={message.id}>{message.text}</div>)}</div>;
}
function App() {
  const [route, setRoute] = useState<Route>({ kind: "home" });
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState<{ query: string; scope: "chats" }>();
  return <><div style={{ height: 750, width: 350 }}><WorkspaceSidebar projects={projects} preferences={preferences} route={route} notifications={[]}
    width={350} collapsed={collapsed} onNavigate={setRoute} onCreate={() => {}} onPreferences={() => {}} onRenameConversation={() => {}}
    onDeleteConversation={() => {}} onProjectDeleted={() => {}} onSearch={setSearch} onCollapsedChange={setCollapsed} /></div>
    <button onClick={() => setCollapsed(!collapsed)}>Toggle panel</button>
    <pre id="route">{JSON.stringify(route)}</pre>
    {route.kind === "conversation" ? <FocusedChat key={`${route.conversationId}:${route.focusMessageId}`} route={route} /> : null}
    <GlobalChatSearch open={Boolean(search)} initialSearch={search} onClose={() => setSearch(undefined)} onSelect={() => {}} />
  </>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline /><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider></ThemeProvider>);
