import { Link, Menu, MenuItem, Stack, Typography } from "@mui/material";
import { useState } from "react";

export interface AgentHeaderChat {
  id: string;
  title: string;
}

export function orderedAgentHeaderChats(
  conversationIds: readonly string[],
  conversations: readonly AgentHeaderChat[],
  primaryConversationId?: string,
): AgentHeaderChat[] {
  const assigned = new Set(conversationIds);
  const orderedIds = [
    ...(primaryConversationId && assigned.has(primaryConversationId) ? [primaryConversationId] : []),
    ...conversationIds,
  ];
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return [...new Set(orderedIds)].flatMap((id) => {
    const conversation = byId.get(id);
    return conversation ? [conversation] : [];
  });
}

export function ProjectRelationshipLink({
  projectLabel,
  onOpenProject,
  compact = false,
}: {
  projectLabel?: string;
  onOpenProject(): void;
  compact?: boolean;
}): JSX.Element {
  const label = projectLabel ?? "Project";
  return <Link
    component="button"
    variant="caption"
    color="text.secondary"
    aria-label={`Open project ${projectLabel ?? "overview"}`}
    onClick={onOpenProject}
    noWrap
  >
    {compact ? "Project" : label}
  </Link>;
}

export function AgentHeaderRelationships({
  projectLabel,
  chats,
  onOpenProject,
  onOpenChat,
}: {
  projectLabel?: string;
  chats: readonly AgentHeaderChat[];
  onOpenProject(): void;
  onOpenChat(chatId: string): void;
}): JSX.Element {
  const [chatMenu, setChatMenu] = useState<{ anchor: HTMLElement; chats: readonly AgentHeaderChat[] }>();
  const primaryChat = chats[0];
  const additionalChats = chats.slice(1);
  const menuOpen = Boolean(chatMenu);
  const openChat = (chat: AgentHeaderChat) => {
    setChatMenu(undefined);
    onOpenChat(chat.id);
  };

  return <>
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{ display: { xs: "none", sm: "flex" }, alignItems: "center", minWidth: 0, overflow: "hidden" }}
    >
      <ProjectRelationshipLink projectLabel={projectLabel} onOpenProject={onOpenProject} />
      {primaryChat ? <>
        <Typography variant="caption" color="text.secondary" aria-hidden="true">·</Typography>
        <Link component="button" variant="caption" aria-label={`Open Project Chat ${primaryChat.title}`} onClick={() => onOpenChat(primaryChat.id)} noWrap>
          {primaryChat.title}
        </Link>
      </> : null}
      {additionalChats.length > 0 ? <>
        <Typography variant="caption" color="text.secondary" aria-hidden="true">·</Typography>
        <Link
          component="button"
          variant="caption"
          aria-label={`Show ${additionalChats.length} more Project ${additionalChats.length === 1 ? "Chat" : "Chats"}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen || undefined}
          aria-controls={menuOpen ? "agent-header-chat-menu" : undefined}
          onClick={(event) => setChatMenu({ anchor: event.currentTarget, chats: additionalChats })}
          noWrap
        >
          +{additionalChats.length} {additionalChats.length === 1 ? "Chat" : "Chats"}
        </Link>
      </> : null}
    </Stack>

    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{ display: { xs: "flex", sm: "none" }, alignItems: "center", minWidth: 0, overflow: "hidden" }}
    >
      <ProjectRelationshipLink compact projectLabel={projectLabel} onOpenProject={onOpenProject} />
      {primaryChat ? <>
        <Typography variant="caption" color="text.secondary" aria-hidden="true">·</Typography>
        {chats.length === 1 ? <Link
          component="button"
          variant="caption"
          aria-label={`Open Project Chat ${primaryChat.title}`}
          onClick={() => onOpenChat(primaryChat.id)}
          noWrap
        >
          1 Chat
        </Link> : <Link
          component="button"
          variant="caption"
          aria-label={`Show ${chats.length} Project Chats`}
          aria-haspopup="menu"
          aria-expanded={menuOpen || undefined}
          aria-controls={menuOpen ? "agent-header-chat-menu" : undefined}
          onClick={(event) => setChatMenu({ anchor: event.currentTarget, chats })}
          noWrap
        >
          {chats.length} Chats
        </Link>}
      </> : null}
    </Stack>

    {chatMenu ? <Menu
      anchorEl={chatMenu.anchor}
      open
      onClose={() => setChatMenu(undefined)}
      MenuListProps={{ id: "agent-header-chat-menu", dense: true, "aria-label": "Project Chats" }}
    >
      {chatMenu.chats.map((chat) => <MenuItem
        key={chat.id}
        aria-label={`Open Project Chat ${chat.title}`}
        onClick={() => openChat(chat)}
      >
        {chat.title}
      </MenuItem>)}
    </Menu> : null}
  </>;
}
