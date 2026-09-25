import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <MessageDeliveryStatus
        receipts={[{ activationId: "activation-a", targetAgentId: "agent-a", state: "preparing" } as any]}
        recipientName={() => "Saratoga"}
        onOpenAgent={() => { (window as any).openedAgent = true; }}
      />
    </ThemeProvider>
  </QueryClientProvider>,
);
