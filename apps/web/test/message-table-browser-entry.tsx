import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { ChatMessageBody } from "../src/components/chat/ChatMessages";

const url = "https://jobs.example.com/company/very-long-job-identifier-1234567890/details";
const text = `Before the table: this paragraph must stay inside the message.

| # | Company / role | Fit | Location / salary | Date | Specific fit | Main gaps / risks |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [Example — Software Engineer](${url}) | 94 — Strong fit | Remote US; $120K–$135K + equity | Not shown; live 9/14 | Explicit early-career level; APIs and automation closely match the work. | Experience with specific tools is preferred. |
| 2 | ${url} | 92 — Strong fit | Remote US | Not shown | Full-stack development and product ownership. | Some cloud experience preferred. |

After the table: this paragraph must not scroll sideways.`;
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createTheme()}><CssBaseline />
  <main style={{ width: "100%", maxWidth: 1000, padding: 16, margin: "0 auto" }}>
    <ChatMessageBody text={text} collapseLongMessage={false} />
  </main>
</ThemeProvider>);
