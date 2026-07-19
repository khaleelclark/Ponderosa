import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SendIcon from "@mui/icons-material/Send";
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, Paper, Stack, TextField, Typography,
} from "@mui/material";
import type { AllChatItemDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { useAllChat } from "../hooks/queries";
import type { Route } from "../routing";

export function allChatSourceRoute(item: AllChatItemDto): Route {
  if (item.source.kind === "agent") {
    return {
      kind: "agent", projectId: item.project.id, agentId: item.source.agentId,
      focusMessageId: item.communicationEventId,
    };
  }
  return {
    kind: "conversation", projectId: item.project.id, conversationId: item.source.conversationId,
    focusMessageId: item.communicationEventId,
    ...(item.source.kind === "team" ? { channel: "collaboration" as const } : {}),
  };
}

export function mergeAllChatItems(...groups: AllChatItemDto[][]): AllChatItemDto[] {
  const byId = new Map<string, AllChatItemDto>();
  for (const item of groups.flat()) byId.set(item.communicationEventId, item);
  return [...byId.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.communicationEventId.localeCompare(b.communicationEventId));
}

function sourceLabel(item: AllChatItemDto): string {
  if (item.source.kind === "project") return `${item.project.label} · Project Chat · ${item.source.title}`;
  if (item.source.kind === "team") return `${item.project.label} · Team Chat · ${item.source.title}`;
  return `${item.project.label} · Agent Chat · ${item.source.title}`;
}

export function AllChatView({ onNavigate }: { onNavigate(route: Route): void }): JSX.Element {
  const queryClient = useQueryClient();
  const query = useAllChat();
  const [older, setOlder] = useState<{ items: AllChatItemDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string>();
  const items = useMemo(
    () => mergeAllChatItems(older?.items ?? [], query.data?.items ?? []),
    [older?.items, query.data?.items],
  );
  const selected = items.find((item) => item.communicationEventId === selectedId);
  const history = older ?? {
    items: [], cursor: query.data?.history.cursor, hasMore: query.data?.history.hasMore ?? false,
  };
  const send = useMutation({
    mutationFn: async () => {
      if (!selected?.directMessageAgent) throw new Error("Select a message tied to one exact Agent");
      const body = text.trim();
      if (!body) throw new Error("Message text is required");
      return api.sendMessage(selected.directMessageAgent.id, {
        text: body,
        replyToMessageId: selected.messageId,
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        activeRunDelivery: "steer",
      });
    },
    onSuccess: (_response, _variables) => {
      setNotice(`Direct message sent to ${selected?.directMessageAgent?.title ?? "Agent"}.`);
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["all-chat"] });
      if (selected?.directMessageAgent) {
        void queryClient.invalidateQueries({ queryKey: ["agent", selected.directMessageAgent.id] });
      }
    },
  });
  const loadOlder = async () => {
    if (loadingOlder || !history.hasMore || !history.cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api.getAllChat(50, history.cursor);
      setOlder((current) => ({
        items: mergeAllChatItems(page.items, current?.items ?? [], query.data?.items ?? []),
        cursor: page.history.cursor,
        hasMore: page.history.hasMore,
      }));
    } finally {
      setLoadingOlder(false);
    }
  };

  return <Box sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", bgcolor: "background.default" }}>
    <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, md: 3 }, py: 2, alignItems: "center", borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h5" component="h1" fontWeight={800}>All Chat</Typography>
        <Typography variant="body2" color="text.secondary">Canonical messages across Project, Team, and Agent chats.</Typography>
      </Box>
      <Chip size="small" variant="outlined" label="View oriented" />
    </Stack>

    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", p: { xs: 1.5, md: 2.5 } }}>
      {query.isLoading ? <Stack sx={{ alignItems: "center", py: 6 }}><CircularProgress size={28} /></Stack> : null}
      {query.isError ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void query.refetch()}>Retry</Button>}>All Chat could not be loaded.</Alert> : null}
      {history.hasMore ? <Stack sx={{ alignItems: "center", mb: 2 }}><Button size="small" variant="outlined" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load older messages"}</Button></Stack> : null}
      <Stack spacing={1.25} sx={{ maxWidth: 920, mx: "auto" }}>
        {items.map((item) => {
          const selectedItem = selectedId === item.communicationEventId;
          return <Paper
            key={item.communicationEventId}
            component="article"
            variant="outlined"
            tabIndex={0}
            aria-selected={selectedItem}
            onClick={() => { setSelectedId(item.communicationEventId); setNotice(undefined); send.reset(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault(); setSelectedId(item.communicationEventId); setNotice(undefined); send.reset();
              }
            }}
            sx={{ p: 1.75, cursor: "pointer", borderColor: selectedItem ? "primary.main" : "divider", bgcolor: selectedItem ? "action.selected" : "background.paper" }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2">{item.author.label}</Typography>
                <Typography variant="caption" color="text.secondary">{sourceLabel(item)} · {new Date(item.createdAt).toLocaleString()}</Typography>
              </Box>
              <Button
                size="small"
                color="inherit"
                endIcon={<OpenInNewIcon fontSize="small" />}
                onClick={(event) => { event.stopPropagation(); onNavigate(allChatSourceRoute(item)); }}
              >Open source</Button>
            </Stack>
            <Divider sx={{ my: 1.25 }} />
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</Typography>
            {item.directMessageAgent ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.25 }}>Select to message {item.directMessageAgent.title} directly.</Typography> : null}
          </Paper>;
        })}
        {!query.isLoading && !query.isError && items.length === 0 ? <Alert severity="info">No authored chat messages yet.</Alert> : null}
      </Stack>
    </Box>

    <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper", p: { xs: 1.5, md: 2 } }}>
      <Box sx={{ maxWidth: 920, mx: "auto" }}>
        {!selected ? <Alert severity="info">Select a source message to inspect its fixed direct-message target.</Alert>
          : !selected.directMessageAgent ? <Alert severity="info">This source does not identify one exact active Agent. All Chat cannot compose broadcasts or choose a different recipient.</Alert>
            : <Stack spacing={1}>
              <Typography variant="subtitle2">Direct message to {selected.directMessageAgent.title}</Typography>
              <Typography variant="caption" color="text.secondary">Recipient is fixed by the selected source. This message is private and cannot be shared with the project from All Chat.</Typography>
              {notice ? <Alert severity="success">{notice}</Alert> : null}
              {send.isError ? <Alert severity="error">{send.error instanceof Error ? send.error.message : "Direct message could not be sent."}</Alert> : null}
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-end" } }}>
                <TextField
                  fullWidth multiline maxRows={6} minRows={2}
                  label={`Message ${selected.directMessageAgent.title}`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && text.trim() && !send.isPending) {
                      event.preventDefault(); send.mutate();
                    }
                  }}
                  inputProps={{ "aria-label": `Direct message to ${selected.directMessageAgent.title}` }}
                />
                <Button variant="contained" endIcon={<SendIcon />} disabled={!text.trim() || send.isPending} onClick={() => send.mutate()} sx={{ minWidth: 116 }}>{send.isPending ? "Sending…" : "Send DM"}</Button>
              </Stack>
            </Stack>}
      </Box>
    </Box>
  </Box>;
}
