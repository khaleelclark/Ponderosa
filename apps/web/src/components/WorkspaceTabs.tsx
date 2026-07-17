import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { Box, ButtonBase, IconButton, Stack, Typography } from "@mui/material";
import type { AgentDto, ConversationDto } from "@ponderosa/core";
import { useState } from "react";
import { conversationDisplayTitle } from "../conversationLabels";
import type { Route } from "../routing";
import { TokenUsageButton } from "./TokenUsageButton";

type WorkspaceTab = {
  key: string;
  label: string;
  kind: "home" | "conversation" | "agent";
  selected: boolean;
  onOpen(): void;
};

export function WorkspaceTabs({ projectId, route, conversations, agents, navigate }: {
  projectId: string;
  route: Route;
  conversations: ConversationDto[];
  agents: AgentDto[];
  navigate(route: Route): void;
}): JSX.Element {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const activeConversations = conversations.filter((item) => !item.archived);
  const selectedConversation = route.kind === "conversation" ? activeConversations.find((item) => item.id === route.conversationId) : undefined;
  const selectedAgent = route.kind === "agent" ? agents.find((item) => item.id === route.agentId) : undefined;
  const tabs: WorkspaceTab[] = [
    { key: "home", label: "Home", kind: "home", selected: false, onOpen: () => navigate({ kind: "home" }) },
  ];
  if (selectedConversation) tabs.push({
    key: `conversation:${selectedConversation.id}`,
    label: conversationDisplayTitle(selectedConversation, activeConversations),
    kind: "conversation",
    selected: true,
    onOpen: () => navigate({ kind: "conversation", projectId, conversationId: selectedConversation.id }),
  });
  if (selectedAgent) tabs.push({
    key: `agent:${selectedAgent.id}`,
    label: selectedAgent.title,
    kind: "agent",
    selected: true,
    onOpen: () => navigate({ kind: "agent", projectId, agentId: selectedAgent.id }),
  });
  const neighbor = activeConversations.find((item) => item.id !== selectedConversation?.id);
  if (neighbor && tabs.length < 4) tabs.push({
    key: `conversation:${neighbor.id}`,
    label: conversationDisplayTitle(neighbor, activeConversations),
    kind: "conversation",
    selected: false,
    onOpen: () => navigate({ kind: "conversation", projectId, conversationId: neighbor.id }),
  });

  const visibleTabs = tabs.filter((tab) => tab.selected || !dismissed.has(tab.key));

  return <Stack component="nav" aria-label="Open workspace views" direction="row" sx={{ display: { xs: "none", md: "flex" }, minWidth: 0, minHeight: { md: 56 }, borderBottom: { md: 1 }, borderColor: "divider", bgcolor: "background.default", alignItems: "stretch" }}>
    <Stack direction="row" className="ponderosa-scroll" sx={{ minWidth: 0, flex: 1, overflowX: "auto", alignItems: "stretch" }}>
      {visibleTabs.map((tab) => <Box key={tab.key} sx={{ position: "relative", minWidth: 128, maxWidth: 220, display: "flex", alignItems: "stretch", borderRight: 1, borderColor: "divider", color: tab.selected ? "text.primary" : "text.secondary", "&::after": tab.selected ? { content: '""', position: "absolute", left: 12, right: 12, bottom: 0, height: 2, bgcolor: "primary.light" } : undefined }}>
        <ButtonBase onClick={tab.onOpen} aria-current={tab.selected ? "page" : undefined} sx={{ minWidth: 0, flex: 1, px: 1.5, gap: 1, justifyContent: "flex-start" }}>
          {tab.kind === "home" ? <HomeOutlinedIcon fontSize="small" /> : tab.kind === "agent" ? <SmartToyOutlinedIcon fontSize="small" /> : <ChatBubbleOutlineIcon fontSize="small" />}
          <Typography variant="body2" fontWeight={tab.selected ? 750 : 500} noWrap sx={{ flex: 1, textAlign: "left" }}>{tab.label}</Typography>
        </ButtonBase>
        {tab.kind !== "home" ? <IconButton size="small" aria-label={`Close ${tab.label}`} onClick={() => {
          setDismissed((current) => new Set(current).add(tab.key));
          if (tab.selected) navigate({ kind: "home" });
        }} sx={{ width: 32, borderRadius: 0, opacity: .55 }}><CloseIcon sx={{ fontSize: 13 }} /></IconButton> : null}
      </Box>)}
    </Stack>
    <Box sx={{ px: 1.25, display: "flex", alignItems: "center", borderLeft: 1, borderColor: "divider" }}><TokenUsageButton scope="project" scopeId={projectId} label="Project" /></Box>
  </Stack>;
}
