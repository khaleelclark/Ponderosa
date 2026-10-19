import { routeToPath } from "../routeRegistry";
import { isUnmodifiedPrimaryClick } from "../nativeNavigation";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
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
import type {
  GlobalChatSearchResultDto,
  RecentGlobalChatDto,
  SearchHighlightRangeDto,
  WorkspaceAgentDirectoryItemDto,
} from "@ponderosa/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { normalizeResetPages, uniqueBy } from "../collections";
import type { Route } from "../routing";
import { useNotifications } from "../hooks/queries";
import { useWorkspaceFileSearch } from "../hooks/useWorkspaceFileSearch";
import { linkPresentation } from "./chat/ChatMessages";

export type GlobalSearchSelection =
  | { projectId: string; file: { path: string; conversationId: string } }
  | { projectId: string; chat: GlobalChatSearchResultDto["chat"]; messageId: string }
  | { projectId: string; chat: RecentGlobalChatDto["chat"] };

export function routeForGlobalSearchSelection(selection: GlobalSearchSelection): Route {
  if ("file" in selection) return { kind: "workspaceFile", projectId: selection.projectId, path: selection.file.path, conversationId: selection.file.conversationId };
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
): { activeIndex: number; select?: boolean } | undefined {
  if (resultCount <= 0) return undefined;
  if (event.key === "ArrowDown") return { activeIndex: (activeIndex + 1 + resultCount) % resultCount };
  if (event.key === "ArrowUp") return { activeIndex: activeIndex <= 0 ? resultCount - 1 : activeIndex - 1 };
  if (event.key === "Enter" && activeIndex >= 0 && activeIndex < resultCount) {
    return { activeIndex, select: true };
  }
  return undefined;
}

const MARKDOWN_LINK = /\[([^\]\r\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const INTERNAL_URL_PLACEHOLDER = /\binvalid-browser-url\b/gu;

function plainGlobalSearchSnippet(snippet: string): string {
  return snippet
    .replace(MARKDOWN_LINK, (_match, label: string, href: string) => {
      if (!linkPresentation(href)) return label;
      return label.trim() === href ? href : label + " (" + href + ")";
    })
    .replace(INTERNAL_URL_PLACEHOLDER, "Link unavailable");
}

function queryHighlightRanges(snippet: string, query: string): SearchHighlightRangeDto[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const source = snippet.toLocaleLowerCase();
  const ranges: SearchHighlightRangeDto[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(needle, cursor);
    if (start < 0) break;
    ranges.push({ start, length: needle.length });
    cursor = start + needle.length;
  }
  return ranges;
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

export function SearchSnippet({ snippet, ranges, query }: { snippet: string; ranges: SearchHighlightRangeDto[]; query: string }): JSX.Element {
  const visibleSnippet = plainGlobalSearchSnippet(snippet);
  const visibleRanges = visibleSnippet === snippet ? ranges : queryHighlightRanges(visibleSnippet, query);
  return <Typography component="span" variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
    {highlightedSnippetSegments(visibleSnippet, visibleRanges).map((segment, index) => segment.highlighted
      ? <Box component="mark" key={index} sx={{ bgcolor: "warning.light", color: "text.primary", borderRadius: .5, px: .25 }}>{segment.text}</Box>
      : <Box component="span" key={index}>{segment.text}</Box>)}
  </Typography>;
}

function SearchResultRow({
  id,
  href,
  active,
  onActive,
  onSelect,
  ariaLabel,
  primary,
  secondary,
}: {
  id?: string;
  href: string;
  active: boolean;
  onActive?(): void;
  onSelect(): void;
  ariaLabel: string;
  primary: React.ReactNode;
  secondary: React.ReactNode;
}): JSX.Element {
  return <ListItemButton
    component="a" href={href}
    id={id}
    role="option"
    selected={active}
    aria-selected={active}
    tabIndex={-1}
    onMouseMove={onActive}
    onMouseDown={event => { if (isUnmodifiedPrimaryClick(event)) event.preventDefault(); }}
    onClick={event => { if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); onSelect(); } }}
    alignItems="flex-start"
    aria-label={ariaLabel}
    sx={{ borderRadius: 1.5, mb: .5 }}
  >
    <ListItemText primary={primary} secondary={secondary} />
  </ListItemButton>;
}

function GlobalSearchResultItem({ result, query, onSelect, active = false, id, onActive }: {
  result: GlobalChatSearchResultDto;
  query: string;
  onSelect(): void;
  active?: boolean;
  id?: string;
  onActive?(): void;
}): JSX.Element {
  return <SearchResultRow
    href={routeToPath(routeForGlobalSearchSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId }))}
    id={id}
    active={active}
    onActive={onActive}
    onSelect={onSelect}
    ariaLabel={result.messageId
      ? `Open ${result.chat.title} at message by ${result.author.label}`
      : `Open Agent ${result.chat.title}, ${result.snippet}`}
    primary={<Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
        <Typography fontWeight={700} noWrap sx={{ minWidth: 0 }}>{result.chat.title}</Typography>
        {result.unread ? <Box component="span" aria-label="Unread" sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }} /> : null}
        <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: "auto !important", flexShrink: 0 }}>{new Date(result.timestamp).toLocaleString()}</Typography>
      </Stack>}
    secondary={<Stack spacing={.25} component="span">
        <Typography component="span" variant="caption" color="text.secondary">{result.chat.kind === "agent" ? "Agent" : "Chat"} · {result.author.label}</Typography>
        <SearchSnippet snippet={result.snippet} ranges={result.highlights} query={query} />
      </Stack>}
  />;
}

function RecentChatItem({ recent, onSelect, active = false, id, onActive }: {
  recent: RecentGlobalChatDto;
  onSelect(): void;
  active?: boolean;
  id?: string;
  onActive?(): void;
}): JSX.Element {
  return <SearchResultRow
    href={routeToPath(routeForGlobalSearchSelection({ projectId: recent.project.id, chat: recent.chat }))}
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
        <Typography component="span" variant="caption" color="text.secondary">{recent.chat.kind === "agent" ? "Agent" : "Chat"}</Typography>
        {recent.snippet ? <Typography component="span" variant="body2" color="text.secondary" noWrap>{plainGlobalSearchSnippet(recent.snippet)}</Typography> : null}
      </Stack>}
  />;
}

export function GlobalChatSearch({ open, onClose, onExited, onSelect, initialSearch }: {
  open: boolean;
  onClose(): void;
  onExited?(): void;
  onSelect(selection: GlobalSearchSelection): void;
  initialSearch?: { query: string; scope: "chats" };
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const notifications = useNotifications();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "chats" | "agents" | "files">("all");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resultLimit, setResultLimit] = useState(25);
  useEffect(() => {
    if (!open || !initialSearch) return;
    setQuery(initialSearch.query);
    setScope(initialSearch.scope);
    setDebouncedQuery(initialSearch.query.trim());
  }, [open, initialSearch]);
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
    enabled: open && scope !== "files",
    staleTime: 5_000,
    refetchOnReconnect: true,
  });
  const filesEnabled = open && (scope === "all" || scope === "files");
  const files = useWorkspaceFileSearch(debouncedQuery, filesEnabled, `global:${scope}`);
  const fileResults = filesEnabled ? files.results : [];
  const agentTitleSearchEnabled = open && Boolean(debouncedQuery) && (scope === "all" || scope === "agents");
  const matchingAgents = useInfiniteQuery({
    queryKey: queryKeys.workspaceDirectory.list("agent", debouncedQuery, undefined, undefined, undefined, undefined, undefined, undefined),
    queryFn: ({ pageParam }) => api.getWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>(
      "agent", { search: debouncedQuery, limit: 25, cursor: pageParam },
    ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.history.cursor,
    select: normalizeResetPages,
    enabled: agentTitleSearchEnabled,
    staleTime: 5_000,
    refetchOnReconnect: true,
  });
  const titleMatches = useMemo<GlobalChatSearchResultDto[]>(() => {
    const seen = new Set(
      (search.data?.results ?? [])
        .filter(result => result.chat.kind === "agent")
        .map(result => result.chat.id),
    );
    return uniqueBy((matchingAgents.data?.pages ?? []).flatMap(page => [...page.starredItems, ...page.items]), item => item.agent.id).filter(item => !seen.has(item.agent.id)).map(item => ({
      project: { id: item.project.id, label: item.project.label },
      chat: { kind: "agent" as const, id: item.agent.id, title: item.agent.title },
      messageId: "",
      author: { kind: "agent" as const, label: item.agent.title, agentId: item.agent.id },
      timestamp: item.agent.updatedAt,
      snippet: `${item.ownerConversation?.title ?? item.project.label} · #${item.agent.handle}`,
      highlights: [],
      unread: false,
    }));
  }, [matchingAgents.data, search.data?.results]);
  const isSearching = (scope !== "files" && search.isFetching) || (filesEnabled && files.isFetching) ||
    (agentTitleSearchEnabled && matchingAgents.isFetching);
  const searchFailed = (scope !== "files" && search.isError) || (filesEnabled && files.isError) || (agentTitleSearchEnabled && matchingAgents.isError);
  const unread = useMemo(() => scope === "files" ? [] : search.data?.results.filter((result) => result.unread) ?? [], [search.data, scope]);
  const openAttentionCount = notifications.data?.openActionCount ?? 0;
  const visibleResults = useMemo(() => [...(search.data?.results ?? []), ...titleMatches].filter((result) => {
    if (scope === "all") return true;
    if (scope === "chats") return result.chat.kind === "conversation";
    if (scope === "agents") return result.chat.kind === "agent";
    return false;
  }), [scope, search.data, titleMatches]);
  const chatEntries = useMemo(() => debouncedQuery
    ? visibleResults.map((result) => ({
      key: `result:${result.chat.kind}:${result.chat.id}:${result.messageId}`,
      selection: { projectId: result.project.id, chat: result.chat, messageId: result.messageId } satisfies GlobalSearchSelection,
    }))
    : [
      ...unread.map((result) => ({
        key: `unread:${result.chat.kind}:${result.chat.id}:${result.messageId}`,
        selection: { projectId: result.project.id, chat: result.chat, messageId: result.messageId } satisfies GlobalSearchSelection,
      })),
      ...(scope === "files" ? [] : search.data?.recentChats ?? []).map((recent) => ({
        key: `recent:${recent.chat.kind}:${recent.chat.id}`,
        selection: { projectId: recent.project.id, chat: recent.chat } satisfies GlobalSearchSelection,
      })),
    ], [debouncedQuery, scope, search.data?.recentChats, unread, visibleResults]);
  const entries = [...chatEntries, ...fileResults.map(file => ({
    key: `file:${file.project.id}:${file.conversationId}:${file.path}`,
    selection: { projectId: file.project.id, file: { path: file.path, conversationId: file.conversationId } } satisfies GlobalSearchSelection,
  }))];
  const entryIdentity = entries.map((entry) => entry.key).join("\u0000");
  useEffect(() => { setActiveIndex(-1); }, [open, query, scope]);
  useEffect(() => {
    setResultLimit(25);
  }, [query, scope]);
  useEffect(() => { setActiveIndex(-1); }, [entryIdentity]);
  const chooseSelection = (selection: GlobalSearchSelection) => {
    onSelect(selection);
    onClose();
  };
  const chooseResult = (result: GlobalChatSearchResultDto) => {
    chooseSelection({ projectId: result.project.id, chat: result.chat, messageId: result.messageId });
  };
  const chooseRecent = (recent: RecentGlobalChatDto) => {
    chooseSelection({ projectId: recent.project.id, chat: recent.chat });
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = globalSearchKeyboardAction(event, activeIndex, entries.length);
    if (!action) return;
    event.preventDefault();
    setActiveIndex(action.activeIndex);
    if (action.select) {
      const entry = entries[action.activeIndex];
      if (entry) chooseSelection(entry.selection);
    }
  };

  return <Dialog open={open} onClose={onClose} onTransitionExited={onExited} disableRestoreFocus fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="global-chat-search-title" PaperProps={{ sx: { border: 1, borderColor: "divider", borderRadius: { sm: 2 }, bgcolor: "background.paper", backgroundImage: "none" } }}>
    <Box component="header" sx={{ p: 0, position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}>
      <Typography
        id="global-chat-search-title"
        component="h2"
        sx={{ position: "absolute", width: "1px", height: "1px", p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}
      >
        Search Ponderosa
      </Typography>
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
    </Box>
    <DialogContent sx={{ px: { xs: 1.5, sm: 2 }, pt: "16px !important", pb: 1.5, minHeight: { sm: 520 } }}>
      <Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
        {(["all", "chats", "agents", "files"] as const).map((value) => <Chip key={value} clickable aria-pressed={scope === value} label={value[0]!.toUpperCase() + value.slice(1)} color={scope === value ? "primary" : "default"} variant={scope === value ? "filled" : "outlined"} onClick={() => setScope(value)} />)}
      </Stack>
      {isSearching ? <LinearProgress aria-label="Searching Ponderosa" sx={{ mb: 1 }} /> : null}
      {searchFailed ? <Alert severity="error" sx={{ mb: 1 }}>Some search results could not load. Any available results remain below. Check the connection and try again.</Alert> : null}
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
            query={debouncedQuery}
            onSelect={() => chooseResult(result)}
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
              query=""
              onSelect={() => chooseResult(result)}
            />)}
          </List>
        </Box> : null}
        {scope !== "files" && (search.data?.recentChats.length ?? 0) > 0 ? <Box role="group" aria-label="Recent chats">
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
                onSelect={() => chooseRecent(recent)}
              />;
            })}
          </List>
        </Box> : null}
      </>}
      {fileResults.length > 0 ? <Box role="group" aria-label={debouncedQuery ? "Files" : "Recent files"}>
        <Typography variant="overline" color="text.secondary">{debouncedQuery ? "Files" : "Recent files"}</Typography>
        {!debouncedQuery ? <Typography variant="caption" color="text.secondary" component="p">Recently modified workspace files</Typography> : null}
        <List component="div" disablePadding role="presentation">
          {fileResults.map((file, fileIndex) => {
            const index = chatEntries.length + fileIndex;
            return <SearchResultRow key={`file:${file.project.id}:${file.conversationId}:${file.path}`} id={`global-search-option-${index}`}
              href={routeToPath(routeForGlobalSearchSelection({ projectId: file.project.id, file: { path: file.path, conversationId: file.conversationId } }))}
              active={activeIndex === index} onActive={() => setActiveIndex(index)}
              ariaLabel={`Open file ${file.name}`}
              onSelect={() => chooseSelection({ projectId: file.project.id, file: { path: file.path, conversationId: file.conversationId } })}
              primary={<Typography fontWeight={700} sx={{ overflowWrap: "anywhere" }}>{file.name}</Typography>}
              secondary={<Typography component="span" variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{file.project.label} · {file.path}</Typography>} />;
          })}
        </List>
      </Box> : null}
      </Box>
      {filesEnabled && (files.truncated || files.unavailableRoots) ? <Typography variant="caption" color="text.secondary" component="p">File search covered a limited set of accessible folders. Some files may not be listed. Narrow the search to find more files.</Typography> : null}
      {agentTitleSearchEnabled && matchingAgents.hasNextPage ? <Button color="inherit" disabled={matchingAgents.isFetching} onClick={() => void matchingAgents.fetchNextPage()}>{matchingAgents.isFetchingNextPage ? "Loading…" : "Load more Agents"}</Button> : null}
      {filesEnabled && files.hasNextPage ? <Button color="inherit" disabled={files.isFetching} onClick={() => void files.fetchNextPage()}>{files.isFetchingNextPage ? "Loading…" : "Load more files"}</Button> : null}
      {scope === "files" && !searchFailed && !debouncedQuery && !isSearching && fileResults.length === 0 ? <Typography color="text.secondary" sx={{ p: 1 }}>No recent files are available. Search files by name or path.</Typography> : null}
      {debouncedQuery && !searchFailed && !isSearching && visibleResults.length === 0 && fileResults.length === 0 ? <Typography color="text.secondary" sx={{ p: 2, textAlign: "center" }}>{`No ${scope === "all" ? "messages, Agents or files" : scope} match “${debouncedQuery}”.`}</Typography> : null}
      {scope !== "files" && !searchFailed && !debouncedQuery && !isSearching && unread.length === 0 && (search.data?.recentChats.length ?? 0) === 0 ? <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: .5 }}>{openAttentionCount ? `${openAttentionCount} item${openAttentionCount === 1 ? "" : "s"} needs attention.` : "You’re all caught up."}</Typography> : null}
      {scope !== "files" && search.data?.truncated ? <Stack spacing={1} sx={{ mt: 1 }}>
        <Alert severity="info">Showing the newest matches from a bounded search. Add more terms to narrow the result.</Alert>
        {resultLimit < 50 ? <Button
          color="inherit"
          onClick={() => setResultLimit(50)}
        >Show more results</Button> : null}
      </Stack> : null}
    </DialogContent>
  </Dialog>;
}
