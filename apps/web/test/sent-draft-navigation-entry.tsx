import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/chat/Composer";
import { ApiRequestError } from "../src/api/types";
import { createPonderosaTheme } from "../src/theme";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "leave";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
client.getQueryCache().subscribe(() => {
  document.body.dataset.draftCache = JSON.stringify(client.getQueryCache().getAll()
    .flatMap(q => q.state.data && typeof q.state.data === "object" && "conversationId" in q.state.data && "revision" in q.state.data
      ? [q.state.data] : []));
});
function Fixture() {
  const [chat, setChat] = useState("a");
  const [state, setState] = useState("Ready");
  const finish = useRef<() => void>();
  const fail = useRef<() => void>();
  const operation = async (text: string) => {
    document.body.dataset.submission = JSON.stringify({ chat, text });
    setState("Pending");
    await new Promise<void>((resolve, reject) => {
      finish.current = resolve;
      fail.current = () => reject(new ApiRequestError(503, "Controlled send failure"));
    }).then(() => setState("Confirmed"), error => { setState("Failed"); throw error; });
  };
  return <>
    <button onClick={() => setChat("a")}>Chat A</button>
    <button onClick={() => setChat("b")}>Chat B</button>
    <button onClick={() => finish.current?.()}>Confirm send</button>
    <button onClick={() => fail.current?.()}>Fail send</button>
    <div id="operation">{state}</div>
    <Composer key={params.has("reuse") ? "shared" : chat}
      conversationDraftId={params.has("local") ? undefined : `${scenario}-${chat}`}
      draftStorageKey={`sent-draft-${scenario}-${chat}`}
      destinationMode="fixed" disabled={false} running={false} onSend={operation}
      commands={scenario.startsWith("command") ? [{ name: "status", description: "Status", source: "adapter-implemented",
        acceptsArguments: false, insertText: "/status", status: "available", invocation: "runtime" }] : undefined}
      onCommand={() => operation("/status")} />
  </>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><Fixture /></QueryClientProvider></ThemeProvider>);
