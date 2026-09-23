import { Box, CssBaseline, Paper, ThemeProvider, createTheme } from "@mui/material";
import type { QueuedConversationMessageDto } from "@ponderosa/core";
import { createRoot } from "react-dom/client";
import { ChatComposerDock } from "../src/components/chat/ChatComposerDock";
import { composerSurfaceSx } from "../src/components/chat/Composer.styles";
import { QueuedMessageTray } from "../src/components/chat/QueuedMessageTray";

const message = {
  deliveryId: "queued-width-fixture",
  position: 1,
  targetAgentId: "agent-fixture",
  text: "A queued message with enough text to test that the row remains inside the composer width.",
} as QueuedConversationMessageDto;

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={createTheme()}>
    <CssBaseline />
    <Box sx={{ width: "100%", height: "100dvh", display: "grid", gridTemplateRows: "1fr auto" }}>
      <Box />
      <ChatComposerDock>
        <QueuedMessageTray messages={[message]} onSteer={() => {}} onEdit={() => {}} onDelete={() => {}} />
        <Paper className="ponderosa-composer" sx={composerSurfaceSx}>
          <Box sx={{ height: 80 }}>Composer</Box>
        </Paper>
      </ChatComposerDock>
    </Box>
  </ThemeProvider>,
);
