import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { AddAgentsFlow } from "../src/components/AddAgentsFlow";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";

const chat = { id: "chat-a", projectId: "flow-fixture", title: "Destination chat" } as ConversationDto;
const global = new URLSearchParams(window.location.search).has("global");

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <MutationNotificationProvider>
        <AddAgentsFlow
          open
          projects={global ? [
            { id: "flow-fixture", label: "Flow project" } as ProjectDto,
            { id: "other-project", label: "Other project" } as ProjectDto,
          ] : undefined}
          fixedProjectId={global ? undefined : "flow-fixture"}
          initialConversation={global ? undefined : chat}
          conversations={global ? [] : [chat]}
          engines={[]}
          onCreate={() => {}}
          onClose={() => {}}
        />
      </MutationNotificationProvider>
    </ThemeProvider>
  </QueryClientProvider>,
);
