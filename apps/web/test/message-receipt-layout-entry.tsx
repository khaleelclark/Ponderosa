import { Box, CssBaseline, ThemeProvider, Typography } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { createRoot } from "react-dom/client";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { ChatSurface } from "../src/components/chat/ChatSurface";
import { CopyMessageButton } from "../src/components/CopyMessageButton";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const params = new URLSearchParams(location.search);
const mode = params.get("case") ?? "stopped";
const name = params.has("long-name") ? "Harpers Ferry " + "long Agent name ".repeat(10) : "Harpers Ferry";
const text = "my issue with the site is that It restates the same info a bunch of times, and it really doesnt tell you what ponderosa is or does - people with zero knowledge about this should be able to understand";
const receipt = { activationId: "activation", targetAgentId: "agent", state: mode === "unconfirmed" ? "run_unconfirmed" : "cancelled",
  providerAcknowledged: true, runStopState: mode === "unknown" ? "unconfirmed" : mode,
  canRetry: mode === "unconfirmed", retryMayDuplicate: true } as MessageDeliveryReceiptDto;
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={new QueryClient()}>
    <Box sx={{ height: "100dvh", display: "grid", gridTemplateRows: "minmax(0, 1fr) 116px", minWidth: 0 }}>
      <ChatSurface layout="agent" layoutKey="receipt">
        <ChatMessageFrame message={{ id: "message", author: { kind: "operator" }, createdAt: "2026-09-30T20:29:00Z",
          body: <Typography variant="body2">{text}</Typography>, actions: <CopyMessageButton text={text} />,
          status: mode === "plain" ? undefined : <MessageDeliveryStatus projectId="project" receipts={[receipt]}
            recipientName={() => name} onOpenAgent={params.has("no-open") ? undefined : id => { document.body.dataset.openedAgent = id; }} /> }} />
      </ChatSurface>
      <Box component="footer" sx={{ m: 2, p: 2, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>Reply to Lake-Clark</Box>
    </Box>
  </QueryClientProvider>
</ThemeProvider>);
