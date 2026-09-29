import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <MessageDeliveryStatus
        projectId="project-a"
        receipts={[
          { activationId: "activation-a", targetAgentId: "agent-a", state: "preparing" },
          { activationId: "activation-b", targetAgentId: "agent-a", state: "run_unconfirmed",
            providerAcknowledged: true, retryMayDuplicate: true, canRetry: true,
            attemptCount: 1, updatedAt: "2026-09-29T12:00:00.000Z" },
        ] as any}
        recipientName={() => "Saratoga"}
        onOpenAgent={() => { (window as any).openedAgent = true; }}
      />
    </ThemeProvider>
  </QueryClientProvider>,
);
