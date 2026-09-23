import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Composer } from "../src/components/chat/Composer";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Fixture() {
  const [sent, setSent] = useState<string[]>([]);
  return <>
    <Composer
      conversationDraftId="conflict-chat"
      draftStorageKey="draft-conflict-send"
      destinationMode="fixed"
      disabled={false}
      running={false}
      onSend={async text => setSent(current => [...current, text])}
    />
    <pre id="sent">{JSON.stringify(sent)}</pre>
  </>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider theme={createTheme()}><CssBaseline /><Fixture /></ThemeProvider>
  </QueryClientProvider>,
);
