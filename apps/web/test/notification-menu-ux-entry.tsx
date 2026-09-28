import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { ChatOverflowMenu } from "../src/components/ChatOverflowMenu";
import { NotificationAcknowledgementBoundary } from "../src/components/NotificationAcknowledgementBoundary";
import { ComposerCapabilityPicker } from "../src/components/chat/Composer.controls";

function Fixture(): JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false);
  const [capabilityAnchor, setCapabilityAnchor] = useState<HTMLElement | null>(null);
  const [filter, setFilter] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const capabilities = [
    { id: "skill:google-drive:google-docs", kind: "skill" as const, label: "google-drive:google-docs", description: "Create documents", status: "available" as const, insertText: "$google-drive:google-docs " },
    { id: "connector:github", kind: "connector" as const, label: "GitHub", description: "Connected source code", status: "available" as const },
    { id: "connector:old-service", kind: "connector" as const, label: "old-service", description: "No access", status: "unavailable" as const, unavailableReason: "Sign in to use this service" },
  ];
  (window as any).reviewed = acknowledged;
  return <ThemeProvider theme={createTheme()}><CssBaseline />
    <ChatOverflowMenu label="Chat settings and actions" actions={[
      { label: "Chat settings", onSelect: () => {} },
      { label: "Delete Chat", onSelect: () => {}, destructive: true },
    ]} transcriptMarkdown="" transcriptFileName="chat.md" />
    <NotificationAcknowledgementBoundary notificationId="notice" acknowledged={acknowledged}
      onAcknowledge={() => setAcknowledged(true)}>
      <button type="button">Open the notice</button>
    </NotificationAcknowledgementBoundary>
    <button type="button" onClick={event => setCapabilityAnchor(event.currentTarget)}>Open capability picker</button>
    <ComposerCapabilityPicker fileInput={fileInput} disabled={false} menuAnchor={capabilityAnchor}
      listId="test-capabilities" filter={filter} attachmentsEnabled fileCount={0}
      capabilities={capabilities} visibleCapabilities={capabilities.filter(item => item.label.includes(filter))}
      onFiles={() => {}} onOpen={setCapabilityAnchor} onClose={() => setCapabilityAnchor(null)}
      onFilterChange={setFilter} onApplyCapability={() => {}} />
  </ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
