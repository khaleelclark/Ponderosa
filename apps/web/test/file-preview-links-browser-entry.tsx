import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material";
import { FilePreview } from "../src/components/filePreview/FilePreview";

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
  </ThemeProvider>,
);
