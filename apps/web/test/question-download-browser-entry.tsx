import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AttentionSurface } from "../src/components/AttentionSurface";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { createPonderosaTheme } from "../src/theme";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const initial: WorkspaceNotificationDto[] = ["d1", "d2"].map((id, index) => ({
  id,
  projectId: "project",
  conversationId: "chat",
  agentId: "agent",
  kind: "decision",
  status: "open",
  severity: "urgent",
  title: "Agent needs a decision",
  body: index ? "Which color should I use?" : "Should I continue with the current plan?",
  createdAt: `2026-09-28T12:00:0${index}.000Z`,
  decision: { id, mode: index ? "text" : "choice", options: index ? [] : [
    { id: "yes", label: "Continue" }, { id: "no", label: "Stop" },
  ], allowOther: true, status: "pending" },
}));

function Fixture(): JSX.Element {
  const [items, setItems] = useState(initial);
  const [answers, setAnswers] = useState<string[]>([]);
  api.respondDecision = async (id, answer) => {
    setAnswers((current) => [...current, `${id}:${answer.optionId ?? answer.text}`]);
    setItems((current) => current.map((item) => item.id === id
      ? { ...item, status: "resolved", decision: { ...item.decision!, status: "resolved" } }
      : item));
    return { id, status: "resolved" } as never;
  };
  return <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <QueryClientProvider client={client}>
      <MutationNotificationProvider>
        <AttentionSurface notifications={items} projectId="project" conversationId="chat" />
        <a href="/download.txt" download="download.txt">Download report</a>
        <output id="answers">{answers.join(",")}</output>
      </MutationNotificationProvider>
    </QueryClientProvider>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
