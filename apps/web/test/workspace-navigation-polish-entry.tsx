import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { Box, CssBaseline, ThemeProvider, Typography, createTheme } from "@mui/material";
import type { ChatFolderDto, ProjectSort, WorkspaceConversationDirectoryItemDto } from "@ponderosa/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { sortWorkspaceResources } from "../src/resourcePreferences";
import { ChatFolders } from "../src/components/ChatFolders";
import { SidebarResourceRow } from "../src/components/SidebarResourceRow";
import { SharedSidebarPanel } from "../src/components/WorkspaceSidebar.parts";

function Fixture(): JSX.Element {
  const [sort, setSort] = useState<"last_used" | "alphabetical" | "custom">("last_used");
  return (
  <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
    <CssBaseline />
    <Box sx={{ width: "min(100vw, 360px)", height: "100dvh", display: "flex" }}>
      <SharedSidebarPanel
        icon={<SmartToyOutlinedIcon />}
        title="Agents"
        header={<Typography component="h1" sx={{ p: 2 }}>Agents</Typography>}
        searchLabel="Search agents"
        searchValue=""
        onSearchValueChange={() => {}}
        starredRows={null}
        allRows={<>
          {Array.from({ length: 40 }, (_, index) => <SidebarResourceRow
            key={index}
            id={`fixture-agent-${index}`}
            label={`Open agent Assistant ${index} in Chat Owner ${index}`}
            title={`Assistant ${index}`}
            subtitle={`Chat: Owner ${index}`}
            detail={`Owner ${index}`}
            icon={<SmartToyOutlinedIcon fontSize="small" />}
            selected={index === 39}
            starred={false}
            onOpen={() => {}}
            onStar={() => {}}
          />)}
        </>}
        sort={sort}
        onSort={setSort}
        drawer={false}
      />
    </Box>
  </ThemeProvider>
  );
}

const chatItems: WorkspaceConversationDirectoryItemDto[] = [
  { kind: "conversation", project: { id: "project", label: "Project", hostPath: "/fixture" }, conversation: { id: "a", projectId: "project", title: "Zulu chat", createdAt: "2026-09-01", updatedAt: "2026-09-18", archived: false } },
  { kind: "conversation", project: { id: "project", label: "Project", hostPath: "/fixture" }, conversation: { id: "b", projectId: "project", title: "Alpha chat", createdAt: "2026-09-01", updatedAt: "2026-09-16", archived: false } },
  { kind: "conversation", project: { id: "project", label: "Project", hostPath: "/fixture" }, conversation: { id: "c", projectId: "project", title: "Other chat", createdAt: "2026-09-01", updatedAt: "2026-09-17", archived: false } },
];

function ChatFolderFixture(): JSX.Element {
  const [sort, setSort] = useState<ProjectSort>("last_used");
  const [folders, setFolders] = useState<ChatFolderDto[]>([
    { id: "z", name: "Zulu folder", conversationIds: ["b", "a"], expanded: true },
    { id: "a", name: "Alpha folder", conversationIds: ["c"], expanded: true },
  ]);
  const items = sortWorkspaceResources(chatItems, sort, undefined, item => item.conversation.id, item => item.conversation.title, item => item.conversation.updatedAt);
  return <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
    <CssBaseline />
    <Box sx={{ width: "min(100vw, 360px)", height: "100dvh", display: "flex" }}>
      <ChatFolders items={items} folders={folders} sort={sort} starredIds={new Set()} filtering={false}
        renderRow={item => <Box data-chat-row={item.conversation.id}>{item.conversation.title}</Box>}
        onChange={(next, custom) => { setFolders(next); if (custom) setSort("custom"); }}
        onRename={() => {}} onDelete={() => {}} onReorder={() => {}}>
        {({ starredRows, allRows }) => <SharedSidebarPanel icon={<ChatBubbleOutlineIcon />} title="Chats"
          searchLabel="Search chats" searchValue="" onSearchValueChange={() => {}}
          starredRows={starredRows} allRows={allRows} sort={sort} onSort={setSort} drawer={false} />}
      </ChatFolders>
    </Box>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(location.search.includes("folders") ? <ChatFolderFixture /> : <Fixture />);
