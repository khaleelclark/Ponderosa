import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { NewWorkspaceKind } from "../routing";
import { WorkspaceTabBar } from "./WorkspaceFrame";

const choices: Array<{ kind: NewWorkspaceKind; label: string; description: string; icon: JSX.Element }> = [
  { kind: "project", label: "Project", description: "A workspace, its runtime defaults, and its working folder.", icon: <FolderOutlinedIcon /> },
  { kind: "chat", label: "Chat", description: "A project conversation that people and Agents can work in together.", icon: <ChatBubbleOutlineIcon /> },
  { kind: "agent", label: "Agent", description: "A persistent teammate with its own model, role, and reporting line.", icon: <SmartToyOutlinedIcon /> },
  { kind: "trigger", label: "Trigger", description: "An unattended automation owned and run by an Agent.", icon: <BoltOutlinedIcon /> },
];

/** The creation workplace is intentionally a tab, not a top-bar popout. */
export function NewWorkspace({
  initialKind = "project",
  onKindChange,
  onCreate,
}: {
  initialKind?: NewWorkspaceKind;
  onKindChange(kind: NewWorkspaceKind): void;
  onCreate(kind: NewWorkspaceKind): void;
}): JSX.Element {
  const [kind, setKind] = useState<NewWorkspaceKind>(initialKind);
  useEffect(() => setKind(initialKind), [initialKind]);
  const choice = choices.find((item) => item.kind === kind)!;
  const select = (next: NewWorkspaceKind) => { setKind(next); onKindChange(next); };

  return <Box sx={{ minHeight: 0, overflow: "auto", p: { xs: 2, md: 4 } }}>
    <Stack spacing={3} sx={{ maxWidth: 880, mx: "auto" }}>
      <Box>
        <Typography variant="h4" fontWeight={800}>Create new</Typography>
        <Typography color="text.secondary">Choose the kind of workspace item you want to add. Its full configuration opens in the same flow.</Typography>
      </Box>
      <WorkspaceTabBar value={kind} onChange={select} label="Create new" items={choices} />
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
        <Stack spacing={2} alignItems="flex-start">
          <Stack direction="row" spacing={1} alignItems="center">
            {choice.icon}
            <Typography variant="h5" fontWeight={750}>New {choice.label}</Typography>
          </Stack>
          <Typography color="text.secondary">{choice.description}</Typography>
          <Typography variant="body2" color="text.secondary">All advanced configuration stays available, including provider settings, project relationships, ownership, and source-specific automation controls.</Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => onCreate(kind)}>Configure {choice.label}</Button>
        </Stack>
      </Paper>
    </Stack>
  </Box>;
}
