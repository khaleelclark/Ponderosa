import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { ImportAgentForm } from "../src/components/ImportAgentDialog";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import type { ConversationDto } from "@ponderosa/core";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <MutationNotificationProvider>
        <ImportAgentForm
          projectId="paste-fixture"
          engines={[]}
          conversations={[{ id: "chat-a", projectId: "paste-fixture", title: "Destination chat" } as ConversationDto]}
          onCancel={() => {}}
        />
      </MutationNotificationProvider>
    </ThemeProvider>
  </QueryClientProvider>,
);
