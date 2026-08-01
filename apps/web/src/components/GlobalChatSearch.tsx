import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
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
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { GlobalChatSearchResultDto, RecentGlobalChatDto, SearchHighlightRangeDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import { useNotifications } from "../hooks/queries";
import { isOpenAttention } from "../attention";

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

function globalSearchKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  activeIndex: number,
  resultCount: number,
): { activeIndex: number; openInNewTab?: boolean } | undefined {
  if (resultCount <= 0) return undefined;
  if (event.key === "ArrowDown") return { activeIndex: (activeIndex + 1 + resultCount) % resultCount };
  if (event.key === "ArrowUp") return { activeIndex: activeIndex <= 0 ? resultCount - 1 : activeIndex - 1 };
  if (event.key === "Enter" && activeIndex >= 0 && activeIndex < resultCount) {
    return { activeIndex, openInNewTab: event.metaKey || event.ctrlKey };
  }
  return undefined;
}

function highlightedSnippetSegments(snippet: string, ranges: SearchHighlightRangeDto[]): Array<{ text: string; highlighted: boolean }> {
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

function SearchResultRow({
  id,
  active,
  onActive,
  onSelect,
  ariaLabel,
  primary,
  secondary,
}: {
  id?: string;
  active: boolean;
  onActive?(): void;
  onSelect(openInNewTab?: boolean): void;
  ariaLabel: string;
  primary: React.ReactNode;
  secondary: React.ReactNode;
}): JSX.Element {
  return <ListItemButton
    id={id}
    role="option"
    selected={active}
    aria-selected={active}
    tabIndex={-1}
    onMouseMove={onActive}
    onMouseDown={(event) => event.preventDefault()}
    onClick={(event) => onSelect(event.metaKey || event.ctrlKey)}
    alignItems="flex-start"
    aria-label={ariaLabel}
    sx={{ borderRadius: 1.5, mb: .5 }}
  >
    <ListItemText primary={primary} secondary={secondary} />
  </ListItemButton>;
}

function GlobalSearchResultItem({ result, onSelect, active = false, id, onActive }: {
  result: GlobalChatSearchResultDto;
  onSelect(openInNewTab?: boolean): void;
  active?: boolean;
  id?: string;
  onActive?(): void;
}): JSX.Element {
  return <SearchResultRow
    id={id}
    active={active}
    onActive={onActive}
    onSelect={onSelect}
    ariaLabel={`Open ${result.chat.title} at message by ${result.author.label}`}
    primary={<Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
        <Typography fontWeight={700} noWrap sx={{ minWidth: 0 }}>{result.chat.title}</Typography>
        {result.unread ? <Box component="span" aria-label="Unread" sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }} /> : null}
        <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: "auto !important", flexShrink: 0 }}>{new Date(result.timestamp).toLocaleString()}</Typography>
      </Stack>}
    secondary={<Stack spacing={.25} component="span">
        <Typography component="span" variant="caption" color="text.secondary">{result.project.label} · {result.chat.kind === "agent" ? "Agent" : "Project chat"} · {result.author.label}</Typography>
        <SearchSnippet snippet={result.snippet} ranges={result.highlights} />
      </Stack>}
  />;
}

function RecentChatItem({ recent, onSelect, active = false, id, onActive }: {
  recent: RecentGlobalChatDto;
  onSelect(openInNewTab?: boolean): void;
  active?: boolean;
  id?: string;
  onActive?(): void;
}): JSX.Element {
  return <SearchResultRow
    id={id}
    active={active}
    onActive={onActive}
    onSelect={onSelect}
    ariaLabel={`Open recent chat ${recent.chat.title}`}
    primary={<Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography fontWeight={700} noWrap>{recent.chat.title}</Typography>
        {recent.unreadCount > 0 ? <Typography variant="caption" color="primary" sx={{ fontWeight: 800 }}>{recent.unreadCount} unread</Typography> : null}
      </Stack>}
    secondary={<Stack component="span" spacing={.25}>
        <Typography component="span" variant="caption" color="text.secondary">{recent.project.label} · {recent.chat.kind === "agent" ? "Agent" : "Project chat"}</Typography>
        {recent.snippet ? <Typography component="span" variant="body2" color="text.secondary" noWrap>{recent.snippet}</Typography> : null}
      </Stack>}
  />;
}

export function UnavailableGlobalSearchScopeChip({ scope }: { scope: "Projects" | "Files" }): JSX.Element {
  const reason = `${scope} search is coming later because ${scope.toLocaleLowerCase()} discovery is not indexed yet`;
  return <Tooltip title={reason}>
    <Chip
      label={`${scope} · Coming later`}
      variant="outlined"
      role="button"
      aria-disabled="true"
      aria-label={reason}
      tabIndex={0}
      sx={{ opacity: 0.62, cursor: "not-allowed" }}
    />
  </Tooltip>;
}

export function GlobalChatSearch({ open, onClose, onSelect, onOpenInNewTab }: {
  open: boolean;
  onClose(): void;
  onSelect(selection: GlobalSearchSelection): void;
  onOpenInNewTab?(selection: GlobalSearchSelection): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const notifications = useNotifications();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "chats" | "agents">("all");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resultLimit, setResultLimit] = useState(25);
  const resultKind = scope === "chats"
    ? "conversation" as const
    : scope === "agents"
      ? "agent" as const
      : undefined;
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => globalThis.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (open) setDebouncedQuery(query.trim());
  }, [open]);
  const search = useQuery({
    queryKey: queryKeys.globalSearch.results(debouncedQuery, resultLimit, resultKind),
    queryFn: () => api.searchGlobalChats(debouncedQuery, resultLimit, resultKind),
    enabled: open,
    staleTime: 5_000,
    refetchOnReconnect: true,
  });
  const unread = useMemo(() => search.data?.results.filter((result) => result.unread) ?? [], [search.data]);
  const openAttentionCount = (notifications.data ?? []).filter(isOpenAttention).length;
  const visibleResults = useMemo(() => (search.data?.results ?? []).filter((result) => {
    if (scope === "all") return true;
    if (scope === "chats") return result.chat.kind === "conversation";
    if (scope === "agents") return result.chat.kind === "agent";
    return false;
  }), [scope, search.data]);
  const entries = useMemo(() => debouncedQuery
    ? visibleResults.map((result) => ({
      key: `result:${result.chat.kind}:${result.chat.id}:${result.messageId}`,
      selection: { projectId: result.project.id, chat: result.chat, messageId: result.messageId } satisfies GlobalSearchSelection,
    }))
    : [
      ...unread.map((result) => ({
        key: `unread:${result.chat.kind}:${result.chat.id}:${result.messageId}`,
        selection: { projectId: result.project.id, chat: result.chat, messageId: result.messageId } satisfies GlobalSearchSelection,
      })),
      ...(search.data?.recentChats ?? []).map((recent) => ({
        key: `recent:${recent.chat.kind}:${recent.chat.id}`,
        selection: { projectId: recent.project.id, chat: recent.chat } satisfies GlobalSearchSelection,
      })),
    ], [debouncedQuery, search.data?.recentChats, unread, visibleResults]);
  const entryIdentity = entries.map((entry) => entry.key).join("\u0000");
  useEffect(() => { setActiveIndex(-1); }, [open, query, scope]);
  useEffect(() => {
    setResultLimit(25);
  }, [query, scope]);
  useEffect(() => { setActiveIndex(-1); }, [entryIdentity]);
  const chooseSelection = (selection: GlobalSearchSelection, openInNewTab = false) => {
    if (openInNewTab) (onOpenInNewTab ?? onSelect)(selection);
    else onSelect(selection);
    onClose();
  };
  const chooseResult = (result: GlobalChatSearchResultDto, openInNewTab = false) => {
    chooseSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId }, openInNewTab);
  };
  const chooseRecent = (recent: RecentGlobalChatDto, openInNewTab = false) => {
    chooseSelection({ projectId: recent.project.id, chat: recent.chat }, openInNewTab);
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = globalSearchKeyboardAction(event, activeIndex, entries.length);
    if (!action) return;
    event.preventDefault();
    setActiveIndex(action.activeIndex);
    if (action.openInNewTab !== undefined) {
      const entry = entries[action.activeIndex];
      if (entry) chooseSelection(entry.selection, action.openInNewTab);
    }
  };

  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="global-chat-search-title" PaperProps={{ sx: { border: 1, borderColor: "divider", borderRadius: { sm: 2 }, bgcolor: "background.paper", backgroundImage: "none" } }}>
    <DialogTitle id="global-chat-search-title" sx={{ p: 0, position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
      <TextField
          autoFocus
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search Ponderosa"
          inputProps={{
            maxLength: 200,
            "aria-label": "Search Ponderosa",
            role: "combobox",
            "aria-expanded": open,
            "aria-controls": "global-search-results",
            "aria-activedescendant": activeIndex >= 0 ? `global-search-option-${activeIndex}` : undefined,
          }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, endAdornment: <Stack direction="row" spacing={.5} sx={{ alignItems: "center" }}><Box aria-label="Escape" sx={{ display: { xs: "none", md: "inline-flex" }, px: .8, py: .4, borderRadius: .75, bgcolor: "action.hover", color: "text.secondary", fontSize: 11, fontFamily: "inherit" }}>ESC</Box><IconButton aria-label="Close search" onClick={onClose}><CloseIcon /></IconButton></Stack>, disableUnderline: true }}
          variant="standard"
          sx={{ px: 2, py: 1.25, "& input": { fontSize: 20, fontWeight: 750 } }}
        />
    </DialogTitle>
    <DialogContent sx={{ px: { xs: 1.5, sm: 2 }, pt: "16px !important", pb: 1.5, minHeight: { sm: 520 } }}>
      <Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
        {(["all", "chats", "agents"] as const).map((value) => <Chip key={value} clickable label={value[0]!.toUpperCase() + value.slice(1)} color={scope === value ? "primary" : "default"} variant={scope === value ? "filled" : "outlined"} onClick={() => setScope(value)} />)}
        <UnavailableGlobalSearchScopeChip scope="Projects" />
        <UnavailableGlobalSearchScopeChip scope="Files" />
      </Stack>
      {search.isFetching ? <LinearProgress aria-label="Searching chats" sx={{ mb: 1 }} /> : null}
      {search.isError ? <Alert severity="error" sx={{ mb: 1 }}>Search is unavailable. Check the server connection and try again.</Alert> : null}
      <Box id="global-search-results" role="listbox" aria-label="Global search suggestions">
      {debouncedQuery ? visibleResults.length > 0 ?
        <Box role="group" aria-label={scope === "all" ? "Results" : scope}>
        <Typography aria-hidden="true" variant="overline" color="text.secondary">{scope === "all" ? "Results" : scope}</Typography>
        <List component="div" disablePadding role="presentation">
          {visibleResults.map((result, index) => <GlobalSearchResultItem
            key={`${result.chat.kind}:${result.chat.id}:${result.messageId}`}
            id={`global-search-option-${index}`}
            active={activeIndex === index}
            onActive={() => setActiveIndex(index)}
            result={result}
            onSelect={(openInNewTab) => chooseResult(result, openInNewTab)}
          />)}
        </List>
        </Box> : null : <>
        {unread.length > 0 ? <Box role="group" aria-label="Unread messages" sx={{ mb: 1.5 }}>
          <Typography aria-hidden="true" variant="overline" color="text.secondary">Unread messages</Typography>
          <List component="div" disablePadding role="presentation">
            {unread.map((result, index) => <GlobalSearchResultItem
              key={`${result.chat.kind}:${result.chat.id}:${result.messageId}`}
              id={`global-search-option-${index}`}
              active={activeIndex === index}
              onActive={() => setActiveIndex(index)}
              result={result}
              onSelect={(openInNewTab) => chooseResult(result, openInNewTab)}
            />)}
          </List>
        </Box> : null}
        {(search.data?.recentChats.length ?? 0) > 0 ? <Box role="group" aria-label="Recent chats">
          <Typography aria-hidden="true" variant="overline" color="text.secondary">Recent chats</Typography>
          <List component="div" disablePadding role="presentation">
            {(search.data?.recentChats ?? []).map((recent, recentIndex) => {
              const index = unread.length + recentIndex;
              return <RecentChatItem
                key={`${recent.chat.kind}:${recent.chat.id}`}
                id={`global-search-option-${index}`}
                active={activeIndex === index}
                onActive={() => setActiveIndex(index)}
                recent={recent}
                onSelect={(openInNewTab) => chooseRecent(recent, openInNewTab)}
              />;
            })}
          </List>
        </Box> : null}
      </>}
      </Box>
      {debouncedQuery && !search.isFetching && visibleResults.length === 0 ? <Typography color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{`No ${scope === "all" ? "messages" : scope} match “${debouncedQuery}”.`}</Typography> : null}
      {!debouncedQuery && !search.isFetching && unread.length === 0 && (search.data?.recentChats.length ?? 0) === 0 ? <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: .5 }}>{openAttentionCount ? `${openAttentionCount} item${openAttentionCount === 1 ? "" : "s"} needs attention.` : "You’re all caught up."}</Typography> : null}
      {search.data?.truncated ? <Stack spacing={1} sx={{ mt: 1 }}>
        <Alert severity="info">Showing the newest matches from a bounded search. Add more terms to narrow the result.</Alert>
        {resultLimit < 50 ? <Button
          color="inherit"
          onClick={() => setResultLimit(50)}
        >Show more results</Button> : null}
      </Stack> : null}
    </DialogContent>
  </Dialog>;
}
