import { Add, Search } from "@mui/icons-material";
import { Box, CssBaseline, IconButton, Stack, ThemeProvider, Typography } from "@mui/material";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectRail } from "../src/components/ProjectNavigation";
import { MobileNavigationButton, MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { createPonderosaTheme } from "../src/theme";
import type { ProjectSidebarSection } from "../src/routeRegistry";

const noop = () => undefined;

function Fixture(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const drawer = params.has("drawer");
  const [section, setSection] = useState<ProjectSidebarSection>("chats");
  const [collapsed, setCollapsed] = useState(false);
  const [action, setAction] = useState("none");
  const label = section === "chats" ? "Chat" : section === "agents" ? "Agent" : "Automation";
  return (
    <ThemeProvider theme={createPonderosaTheme("dark")}>
      <CssBaseline />
      <MobileNavigationProvider desktopVisible={!drawer && collapsed} onOpen={() => setCollapsed(false)}>
      <Box sx={{ width: "100vw", height: "100dvh", display: "flex", overflow: "hidden" }}>
      {!collapsed ? <Box component="aside" aria-label="Workspace navigation fixture" sx={{ width: drawer ? "min(92vw, 390px)" : 390, maxWidth: "100vw", height: "100dvh", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "auto auto minmax(0, 1fr) auto", bgcolor: "background.paper", overflow: "hidden" }}>
        <ProjectRail
          sections={{ active: section, agentsWorking: true, onSelect: setSection }}
          drawer={drawer}
          projects={[]}
          route={{ kind: "home" }}
          profile={{ displayName: "K&P", handle: "operator", avatarId: "default-user" }}
          allMessagesUnread={{ importantCount: 0, ordinaryCount: 0, totalCount: 0 }}
          attentionNotifications={2}
          unreadNotificationUpdates={0}
          projectUnread={new Map()}
          onFoldersChange={noop}
          onRenameProject={noop}
          onProjectSettings={noop}
          onDeleteProject={noop}
          onReorderProject={noop}
          onOpenHome={() => setAction("home")}
          onOpenAllMessages={() => setAction("all-messages")}
          onOpenProject={noop}
          onOpenCreate={noop}
          onOpenSearch={noop}
          onOpenNotifications={noop}
          onOpenUsage={noop}
          onOpenEngineStatus={noop}
          onOpenSettings={noop}
          onOpenProfile={noop}
          onCollapse={!drawer ? () => setCollapsed(true) : undefined}
          onClose={noop}
        />
        <Box sx={{ gridRow: 3, minWidth: 0, minHeight: 0, overflow: "hidden", px: 1.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", py: 1 }}>
            <Typography component="h1" sx={{ minWidth: 0, flex: 1, fontSize: 15, fontWeight: 700 }}>{label}s</Typography>
            <IconButton aria-label={`Create ${label}`} size="small"><Add fontSize="small" /></IconButton>
          </Stack>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, border: 1, borderColor: "divider", borderRadius: 1.5, px: 1.25, height: 38 }}>
            <Search fontSize="small" />
            <Typography color="text.secondary">Search {label.toLocaleLowerCase()}s</Typography>
          </Stack>
        </Box>
      </Box> : null}
      <Box component="main" sx={{ minWidth: 0, flex: 1 }}>
        <Stack component="header" direction="row" sx={{ minHeight: 48, alignItems: "center", px: 1 }}>
          <MobileNavigationButton />
          <Typography>Main content</Typography>
          <Typography id="action">{action}</Typography>
        </Stack>
      </Box>
      </Box>
      </MobileNavigationProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
