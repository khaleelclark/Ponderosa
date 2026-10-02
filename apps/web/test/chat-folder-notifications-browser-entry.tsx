import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { api } from "../src/api";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import { createPonderosaTheme } from "../src/theme";
import { queryKeys } from "../src/queryKeys";

const fixture = await (await fetch("/api/fixture")).json();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
api.getWorkspaceDirectory = (async (kind, options) => {
  const rows = kind === "project" ? fixture.projects.map((project: object) => ({ kind, project })) :
    kind === "conversation" ? fixture.chats.filter((conversation: { title: string }) => !options.search || conversation.title.toLowerCase().includes(options.search.toLowerCase()))
      .map((conversation: object) => ({ kind, project: fixture.projects[0], conversation, runningAgentCount: 0 })) : [];
  const start = Number(options.cursor ?? 0), limit = options.limit ?? 25;
  return { kind, items: options.summary ? [] : rows.slice(start, start + limit), starredItems: [], total: rows.length, runningCount: 0,
    history: { hasMore: start + limit < rows.length, cursor: start + limit < rows.length ? String(start + limit) : undefined } };
}) as typeof api.getWorkspaceDirectory;
api.searchGlobalChats = async () => ({ results: [], truncated: false });

function Fixture() {
  const capacity = new URLSearchParams(location.search).has("capacity");
  const [preferences, setPreferences] = useState<WorkspacePreferencesDto>({ ...fixture.preferences,
    ...(capacity ? { chatFolders: Array.from({ length: 401 }, (_, i) => ({ id: `capacity-${i}`, name: `Capacity ${i}`, expanded: false,
      conversationIds: [i === 400 ? fixture.chats[0].id : `unloaded-${i}`] })) } : {}) });
  const action = async (name: string) => {
    await fetch(`/api/fixture-action/${name}`, { method: "POST" });
    await client.invalidateQueries({ queryKey: queryKeys.notifications.all });
  };
  return <><div style={{ height: 720, width: "min(350px, 100vw)" }}>
    <WorkspaceSidebar projects={fixture.projects} preferences={preferences} route={{ kind: "home" }} notifications={[]}
      width={350} collapsed={false} onNavigate={() => {}} onCreate={() => {}}
      onPreferences={patch => setPreferences(previous => ({ ...previous, ...patch }))}
      onRenameConversation={() => {}} onDeleteConversation={() => {}} onProjectDeleted={() => {}} onCollapsedChange={() => {}} />
    </div><button onClick={() => void action("read")}>Read Newleaf</button>
    <button onClick={() => void action("dismiss")}>Dismiss action</button>
    <button onClick={() => void action("new")}>New notification</button>
    <button onClick={() => setPreferences(previous => ({ ...previous, chatFolders: previous.chatFolders?.map(folder => ({ ...folder,
      conversationIds: folder.id === "apps" ? folder.conversationIds.filter(id => id !== fixture.chats[0].id) :
        folder.id === "later" ? [...folder.conversationIds, fixture.chats[0].id] : folder.conversationIds })) }))}>Move Newleaf</button>
  </>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><Fixture /></QueryClientProvider></ThemeProvider>);
