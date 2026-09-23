import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import type { ConversationDto } from "@ponderosa/core";
import { ChatDeletionDialog } from "../src/components/ChatDeletionDialog";

const conversation = { id: "chat-a", projectId: "project-a", title: "Example Chat" } as ConversationDto;
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <ChatDeletionDialog
        open
        conversation={conversation}
        pending={false}
        onClose={() => {}}
        onDelete={ids => { (window as unknown as { confirmedAgentIds: string[] }).confirmedAgentIds = ids; }}
      />
    </ThemeProvider>
  </QueryClientProvider>,
);
