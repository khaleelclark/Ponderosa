import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { GlobalChatSearchResultDto, RecentGlobalChatDto, SearchHighlightRangeDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Route } from "../routing";

export type GlobalSearchSelection =
  | { projectId: string; chat: GlobalChatSearchResultDto["chat"]; messageId: string }
  | { projectId: string; chat: RecentGlobalChatDto["chat"] };

export function routeForGlobalSearchSelection(selection: GlobalSearchSelection): Route {
  const focusMessageId = "messageId" in selection ? selection.messageId : undefined;
  return selection.chat.kind === "conversation"
    ? { kind: "conversation", projectId: selection.projectId, conversationId: selection.chat.id, ...(focusMessageId ? { focusMessageId } : {}) }
    : { kind: "agent", projectId: selection.projectId, agentId: selection.chat.id, ...(focusMessageId ? { focusMessageId } : {}) };
}

export function isGlobalSearchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === "k";
}

export function highlightedSnippetSegments(snippet: string, ranges: SearchHighlightRangeDto[]): Array<{ text: string; highlighted: boolean }> {
  const ordered = [...ranges]
    .filter((range) => range.length > 0 && range.start >= 0 && range.start < snippet.length)
    .sort((a, b) => a.start - b.start);
  const segments: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  for (const range of ordered) {
    const start = Math.max(cursor, range.start);
    const end = Math.min(snippet.length, range.start + range.length);
    if (start > cursor) segments.push({ text: snippet.slice(cursor, start), highlighted: false });
    if (end > start) segments.push({ text: snippet.slice(start, end), highlighted: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), highlighted: false });
  return segments.length ? segments : [{ text: snippet, highlighted: false }];
}

function SearchSnippet({ snippet, ranges }: { snippet: string; ranges: SearchHighlightRangeDto[] }): JSX.Element {
  return <Typography component="span" variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
    {highlightedSnippetSegments(snippet, ranges).map((segment, index) => segment.highlighted
      ? <Box component="mark" key={index} sx={{ bgcolor: "warning.light", color: "text.primary", borderRadius: .5, px: .25 }}>{segment.text}</Box>
      : <Box component="span" key={index}>{segment.text}</Box>)}
  </Typography>;
}

export function GlobalSearchResultItem({ result, onSelect }: {
  result: GlobalChatSearchResultDto;
  onSelect(): void;
}): JSX.Element {
  return <ListItemButton onClick={onSelect} alignItems="flex-start" aria-label={`Open ${result.chat.title} at message by ${result.author.label}`} sx={{ borderRadius: 1.5, mb: .5 }}>
    <ListItemText
      primary={<Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
        <Typography fontWeight={700} noWrap sx={{ minWidth: 0 }}>{result.chat.title}</Typography>
        {result.unread ? <Box component="span" aria-label="Unread" sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }} /> : null}
        <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: "auto !important", flexShrink: 0 }}>{new Date(result.timestamp).toLocaleString()}</Typography>
      </Stack>}
      secondary={<Stack spacing={.25} component="span">
        <Typography component="span" variant="caption" color="text.secondary">{result.project.label} · {result.chat.kind === "agent" ? "Agent" : "Project chat"} · {result.author.label}</Typography>
        <SearchSnippet snippet={result.snippet} ranges={result.highlights} />
      </Stack>}
    />
  </ListItemButton>;
}

function RecentChatItem({ recent, onSelect }: { recent: RecentGlobalChatDto; onSelect(): void }): JSX.Element {
  return <ListItemButton onClick={onSelect} alignItems="flex-start" sx={{ borderRadius: 1.5, mb: .5 }}>
    <ListItemText
      primary={<Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography fontWeight={700} noWrap>{recent.chat.title}</Typography>
        {recent.unreadCount > 0 ? <Typography variant="caption" color="primary" sx={{ fontWeight: 800 }}>{recent.unreadCount} unread</Typography> : null}
      </Stack>}
      secondary={<Stack component="span" spacing={.25}>
        <Typography component="span" variant="caption" color="text.secondary">{recent.project.label} · {recent.chat.kind === "agent" ? "Agent" : "Project chat"}</Typography>
        {recent.snippet ? <Typography component="span" variant="body2" color="text.secondary" noWrap>{recent.snippet}</Typography> : null}
      </Stack>}
    />
  </ListItemButton>;
}

export function GlobalChatSearch({ open, onClose, onSelect }: {
  open: boolean;
  onClose(): void;
  onSelect(selection: GlobalSearchSelection): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "projects" | "threads" | "agents" | "files">("all");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (open) setDebouncedQuery(query.trim());
  }, [open]);
  const search = useQuery({
    queryKey: ["global-search", debouncedQuery],
    queryFn: () => api.searchGlobalChats(debouncedQuery),
    enabled: open,
    staleTime: 5_000,
    refetchOnReconnect: true,
  });
  const unread = useMemo(() => search.data?.results.filter((result) => result.unread) ?? [], [search.data]);
  const visibleResults = useMemo(() => (search.data?.results ?? []).filter((result) => {
    if (scope === "all") return true;
    if (scope === "threads") return result.chat.kind === "conversation";
    if (scope === "agents") return result.chat.kind === "agent";
    return false;
  }), [scope, search.data]);
  const chooseResult = (result: GlobalChatSearchResultDto) => {
    onSelect({ projectId: result.project.id, chat: result.chat, messageId: result.messageId });
    onClose();
  };
  const chooseRecent = (recent: RecentGlobalChatDto) => {
    onSelect({ projectId: recent.project.id, chat: recent.chat });
    onClose();
  };

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="global-chat-search-title" PaperProps={{ sx: { border: 1, borderColor: "divider", borderRadius: { sm: 2 }, bgcolor: "background.paper", backgroundImage: "none" } }}>
    <DialogTitle id="global-chat-search-title" sx={{ p: 0, position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
      <TextField
          autoFocus
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Ponderosa"
          inputProps={{ maxLength: 200, "aria-label": "Search Ponderosa" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Stack direction="row" spacing={.5} sx={{ alignItems: "center" }}><Box component="kbd" sx={{ px: .8, py: .4, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 10 }}>ESC</Box><IconButton aria-label="Close search" onClick={onClose}><CloseIcon /></IconButton></Stack>, disableUnderline: true }}
          variant="standard"
          sx={{ px: 2, py: 1.25, "& input": { fontSize: 20, fontWeight: 750 } }}
        />
    </DialogTitle>
    <DialogContent sx={{ px: { xs: 1.5, sm: 2 }, pt: "16px !important", pb: 1.5, minHeight: { sm: 520 } }}>
      <Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
        {(["all", "projects", "threads", "agents", "files"] as const).map((value) => <Chip key={value} clickable label={value[0]!.toUpperCase() + value.slice(1)} color={scope === value ? "primary" : "default"} variant={scope === value ? "filled" : "outlined"} onClick={() => setScope(value)} />)}
      </Stack>
      {search.isFetching ? <LinearProgress aria-label="Searching chats" sx={{ mb: 1 }} /> : null}
      {search.isError ? <Alert severity="error" sx={{ mb: 1 }}>Search is unavailable. Check the server connection and try again.</Alert> : null}
      {debouncedQuery ? <>
        <Typography variant="overline" color="text.secondary">{scope === "all" ? "Results" : scope}</Typography>
        <List disablePadding aria-label="Global chat search results">
          {visibleResults.map((result) => <GlobalSearchResultItem key={`${result.chat.kind}:${result.chat.id}:${result.messageId}`} result={result} onSelect={() => chooseResult(result)} />)}
        </List>
        {!search.isFetching && visibleResults.length === 0 ? <Typography color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{scope === "projects" || scope === "files" ? `${scope === "projects" ? "Project" : "File"} discovery is not yet indexed; search matching messages instead.` : `No ${scope === "all" ? "messages" : scope} match “${debouncedQuery}”.`}</Typography> : null}
      </> : <Stack spacing={1.5}>
        <Box>
          <Typography variant="overline" color="text.secondary">Unread messages</Typography>
          <List disablePadding aria-label="Unread chat messages">
            {unread.map((result) => <GlobalSearchResultItem key={`${result.chat.kind}:${result.chat.id}:${result.messageId}`} result={result} onSelect={() => chooseResult(result)} />)}
          </List>
          {!search.isFetching && unread.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: .5 }}>You’re all caught up.</Typography> : null}
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">Recent chats</Typography>
          <List disablePadding aria-label="Recent chats">
            {(search.data?.recentChats ?? []).map((recent) => <RecentChatItem key={`${recent.chat.kind}:${recent.chat.id}`} recent={recent} onSelect={() => chooseRecent(recent)} />)}
          </List>
        </Box>
      </Stack>}
      {search.data?.truncated ? <Alert severity="info" sx={{ mt: 1 }}>Showing the newest matches from a bounded search. Add more terms to narrow the result.</Alert> : null}
      <Stack direction="row" spacing={2} sx={{ mt: 2, pt: 1.25, borderTop: 1, borderColor: "divider", color: "text.secondary" }}><Typography variant="caption">↑↓ Navigate</Typography><Typography variant="caption">↵ Open</Typography><Typography variant="caption">⌘↵ Open in new tab</Typography></Stack>
    </DialogContent>
  </Dialog>;
}
