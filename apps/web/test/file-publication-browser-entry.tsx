import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionCard } from "../src/components/decisions/DecisionCard";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { api } from "../src/api";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const decision = {
  id: crypto.randomUUID(), mode: "approval" as const, status: "pending" as const,
  question: "Publish synthetic-deliverable-with-a-long-readable-name.bin from Publisher in Disposable Chat?",
  context: `Source: ${JSON.stringify(`/disposable/${crypto.randomUUID()}/${crypto.randomUUID()}/synthetic-deliverable-with-a-long-readable-name.bin`)}\nDownload filename: synthetic-deliverable-with-a-long-readable-name.bin\nSize: 48 bytes\nSHA-256: ${"a".repeat(64)}\nApproval copies only these exact bytes into managed downloadable storage. It does not authorize other files, a directory, or general filesystem access. This request expires in one hour.`,
  options: [{ id: "approve", label: "Publish this file" }, { id: "do_not_approve", label: "Not now" }], allowOther: false,
};
document.body.dataset.decisionId = decision.id;
api.respondDecision = async (decisionId, response) => {
  document.body.dataset.response = JSON.stringify({ decisionId, ...response });
  return { ...decision, status: "resolved", response: { ...response, respondedAt: new Date().toISOString() } } as never;
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <QueryClientProvider client={client}><MutationNotificationProvider>
      <Box sx={{ p: 1 }}><DecisionCard decision={decision} /></Box>
    </MutationNotificationProvider></QueryClientProvider>
  </ThemeProvider>,
);
