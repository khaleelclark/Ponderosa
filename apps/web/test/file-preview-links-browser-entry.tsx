import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material";
import { FilePreview } from "../src/components/filePreview/FilePreview";
import { ChatMessageBody } from "../src/components/chat/ChatMessages";

const markdown = [
  "[safe local](../overview/notes.md)",
  "[outside](../../outside.md)",
  "[malformed](bad%ZZ.md)",
  "[encoded slash](%2Fetc%2Fpasswd)",
  "[external](https://example.com)",
  "[section](#section)",
].join("\n\n");

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={createTheme()}>
    <FilePreview title="report.md" projectId="project-a" path="gen3-20260926/report.md"
      contentType="markdown" content={markdown} />
    <section id="agent-links"><ChatMessageBody projectId="project-a" text="[Download](dist/spec.md) and [Download artifact](/api/artifacts/file/download)" /></section>
  </ThemeProvider>,
);
