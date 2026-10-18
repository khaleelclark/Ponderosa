import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { Composer } from "../src/components/chat/Composer";
import { OutgoingMessageProvider, OutgoingMessageRow } from "../src/components/chat/OutgoingMessage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Fixture() {
  const [sent, setSent] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const releaseSend = useRef<() => void>();
  return <OutgoingMessageProvider scope="conflict-chat">
    <OutgoingMessageRow />
    <Composer
      conversationDraftId="conflict-chat"
      draftStorageKey="draft-conflict-send"
      destinationMode="fixed"
      disabled={false}
      running={false}
      onSend={async text => {
        setSending(true);
        await new Promise<void>(resolve => { releaseSend.current = resolve; });
        setSent(current => [...current, text]);
        setSending(false);
      }}
    />
    <button disabled={!sending} onClick={() => releaseSend.current?.()}>Release send</button>
    <pre id="sent">{JSON.stringify(sent)}</pre>
  </OutgoingMessageProvider>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider theme={createTheme()}><CssBaseline /><Fixture /></ThemeProvider>
  </QueryClientProvider>,
);
