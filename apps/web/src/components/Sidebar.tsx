import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import GroupWorkIcon from "@mui/icons-material/GroupWork";
import {
  Badge,
  Box,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ConversationDto, AgentDto } from "@ponderosa/core";
import { agentBelongsToConversation, type AgentStatus } from "../agents";

export interface SidebarSelection {
  conversationId?: string;
  agentsActive: boolean;
}

/**
 * Project navigation: a "Project chats" section plus a single "Agents" item.
 * Project chats show a running dot when any of their agents is live; the Agents
 * item shows the total agent count and a running count.
 */
export function Sidebar({
  conversations,
  agents,
  statusByAgentId,
  selection,
  onSelectConversation,
  onSelectAgents,
  onCreateConversation,
}: {
  conversations: ConversationDto[];
  agents: AgentDto[];
  statusByAgentId: Map<string, AgentStatus>;
  selection: SidebarSelection;
  onSelectConversation(conversationId: string): void;
  onSelectAgents(): void;
  onCreateConversation(): void;
}): JSX.Element {
  const runningAgentIds = new Set(
    agents.filter((agent) => {
      const status = statusByAgentId.get(agent.id);
      return status === "running" || status === "compacting";
    }).map((agent) => agent.id),
  );
  const runningCount = runningAgentIds.size;

  const masterHasRunning = (conversationId: string): boolean =>
    agents.some((agent) => agentBelongsToConversation(agent, conversationId) && runningAgentIds.has(agent.id));

  return (
    <Box component="nav" aria-label="Project navigation" sx={{ minWidth: 0, py: 0.5, pb: "max(4px, env(safe-area-inset-bottom))" }}>
      <Stack direction="row" sx={{ alignItems: "center", px: 1, py: 0.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1, px: 1 }}>
          Project chats
        </Typography>
        <Tooltip title="New Project chat">
          <IconButton size="small" onClick={onCreateConversation} aria-label="New Project chat">
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <List dense disablePadding>
        {conversations.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 0.5 }}>
            No Project chats yet.
          </Typography>
        ) : null}
        {conversations.map((master) => {
          const count = agents.filter((agent) => agentBelongsToConversation(agent, master.id)).length;
          return (
            <ListItem key={master.id} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                selected={selection.conversationId === master.id}
                onClick={() => onSelectConversation(master.id)}
                sx={{ borderRadius: 1, mx: 1 }}
              >
                <ChatBubbleOutlineIcon
                  fontSize="small"
                  color={masterHasRunning(master.id) ? "info" : "action"}
                  sx={{ mr: 1 }}
                />
                <ListItemText
                  primary={master.title}
                  secondary={count > 0 ? `${count} agent${count === 1 ? "" : "s"}` : "No agents"}
                  primaryTypographyProps={{ fontWeight: 700, noWrap: true }}
                  secondaryTypographyProps={{ noWrap: true }}
                />
                {masterHasRunning(master.id) ? (
                  <Box
                    role="img"
                    aria-label="Has running agents"
                    sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "info.main", ml: 1 }}
                  />
                ) : null}
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      <List dense disablePadding sx={{ mt: 1 }}>
        <ListItem disablePadding>
          <ListItemButton
            selected={selection.agentsActive}
            onClick={onSelectAgents}
            sx={{ borderRadius: 1, mx: 1 }}
          >
            <GroupWorkIcon fontSize="small" sx={{ mr: 1 }} />
            <ListItemText
              primary="Agents"
              primaryTypographyProps={{ fontWeight: 700 }}
              secondary={runningCount > 0 ? `${runningCount} running` : undefined}
            />
            <Badge badgeContent={agents.length} color="default" showZero sx={{ mr: 1 }}>
              <Box sx={{ width: 8 }} />
            </Badge>
            {runningCount > 0 ? <Chip size="small" color="info" label={runningCount} /> : null}
          </ListItemButton>
        </ListItem>
      </List>
    </Box>
  );
}
