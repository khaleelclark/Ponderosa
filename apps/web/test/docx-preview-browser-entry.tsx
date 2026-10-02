import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { createPonderosaTheme } from "../src/theme";
import { ChatAttachments } from "../src/components/chat/ChatAttachments";
import { FilePreview } from "../src/components/filePreview/FilePreview";

const params = new URLSearchParams(location.search);
const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const good = { id: "good", agentId: "owner", name: "Report.docx", mediaType: mime, size: 1000, downloadUrl: params.get("download")! };
const content = params.get("case") === "chat"
  ? <ChatAttachments attachments={[good,
    { ...good, id: "bad", name: "Damaged.docx", downloadUrl: "/api/qualification-docx/bad" },
    { ...good, id: "slow", name: "Slow.docx", downloadUrl: "/api/qualification-docx/slow" }]} />
  : <FilePreview title="Report.docx" path="Report.docx" mediaType="application/octet-stream" downloadUrl={params.get("download")!} />;
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline/><main style={{ padding: 12 }}>{content}</main></ThemeProvider>);
