import {
  Alert, Autocomplete, Box, FormControl, InputLabel, LinearProgress,
  MenuItem, Paper, Select, Stack, TextField, Typography,
} from "@mui/material";
import type {
  EngineDto, ProjectDto,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceConversationDirectoryItemDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { uniqueManagedRows } from "../hooks/useManagedWorkspaceCollection";
import { queryKeys } from "../queryKeys";
import {
  useWorkspaceDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import {
  reorderStableIds, starredWorkspaceResources,
  toggleWorkspaceResourceStar, workspaceResourceSort, workspaceResourceSortPatch,
} from "../resourcePreferences";
import type { Route } from "../routing";
import { TokenUsageDetails } from "./TokenUsageButton";
import { AgentsTab } from "./AgentsTab";
import { mergeAgentStatuses } from "../agents";
import {
  CollectionDirectoryControls,
  CollectionStateFeedback,
} from "./CollectionPrimitives";
import { globalAgentCreateContext } from "./agentCreateOwnership";

export function AllAgentsWorkspace({ projects, engines, filterProjectId, preferences, onPreferences, onNavigate, onCreate, onAgentsDeleted, managementMode = false }: {
  projects: ProjectDto[]; engines: EngineDto[]; filterProjectId?: string; preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onNavigate(route: Route): void;
  onCreate(projectId?: string, managerAgentId?: string, conversationId?: string): void;
  onAgentsDeleted(projectId: string, agentIds: string[]): void;
  managementMode?: boolean;
}): JSX.Element {
  const [projectId, setProjectId] = useState(filterProjectId ?? "");
  const [conversationId, setConversationId] = useState("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    setProjectId(filterProjectId ?? "");
    setConversationId("all");
  }, [filterProjectId]);
  const sort = workspaceResourceSort(preferences, "agent");
  const conversationDirectoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", {
      projectId: projectId || undefined,
      retainPreviousData: false,
    });
  const conversationDirectory = workspaceDirectoryItems(
    conversationDirectoryQuery.data?.pages,
    preferences,
  );
  const conversationRows = [
    ...conversationDirectory.starredItems,
    ...conversationDirectory.items,
  ];
  const agentDirectoryQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
      search,
      projectId: projectId || undefined,
      conversationId: conversationId === "all" ? undefined : conversationId,
      retainPreviousData: false,
    });
  const agentDirectory = workspaceDirectoryItems(agentDirectoryQuery.data?.pages, preferences);
  const rows = [...agentDirectory.starredItems, ...agentDirectory.items];
  useEffect(() => {
    if (
      managementMode &&
      agentDirectoryQuery.requestState.hasNextPage &&
      !agentDirectoryQuery.requestState.isFetchingNextPage &&
      !agentDirectoryQuery.requestState.isPaginationError
    ) void agentDirectoryQuery.fetchNextPage();
  }, [
    agentDirectoryQuery.fetchNextPage,
    agentDirectoryQuery.requestState.hasNextPage,
    agentDirectoryQuery.requestState.isFetchingNextPage,
    agentDirectoryQuery.requestState.isPaginationError,
    managementMode,
  ]);
  const agents = rows.map(row => row.agent);
  const conversations = conversationRows.map(row => row.conversation);
  const healthByAgentId = new Map(
    rows.map(row => [row.agent.id, row.health] as const),
  );
  const statusByAgentId = mergeAgentStatuses(
    agents,
    [...healthByAgentId.values()],
    new Map(),
  );
  const projectByAgentId = new Map(
    rows.map(row => [row.agent.id, { id: row.project.id, label: row.project.label }] as const),
  );
  const ownerConversationByAgentId = new Map<string, string>(
    rows.flatMap(row => row.ownerConversation
      ? [[row.agent.id, row.ownerConversation.title] as const]
      : []),
  );
  const starredIds = starredWorkspaceResources(preferences);
  const scopedProject = projectId
    ? projects.find(project => project.id === projectId)
    : undefined;
  const organizationDataComplete =
    agentDirectoryQuery.requestState.hasResolved &&
    !agentDirectoryQuery.requestState.hasNextPage &&
    !agentDirectoryQuery.requestState.isPaginationError &&
    !search.trim() &&
    conversationId === "all";
  const loadCompleteAgentCollection = async (): Promise<void> => {
    if (search.trim() || conversationId !== "all")
      throw new Error(
        "Clear the Agent search and Chat filter before loading the complete organization.",
      );
    let hasNextPage = agentDirectoryQuery.requestState.hasNextPage;
    while (hasNextPage) {
      const result = await agentDirectoryQuery.fetchNextPage();
      if (result.isError)
        throw result.error ?? new Error("Could not load the complete Agent hierarchy.");
      hasNextPage = Boolean(result.hasNextPage);
    }
  };
  return <Box sx={{ height: "100%", minHeight: 0, overflow: "hidden" }}>
    <AgentsTab
      collection={{
        title: managementMode ? "Manage Agents" : "All Agents",
        detail: agentDirectoryQuery.requestState.hasResolved
          ? scopedProject
            ? String(agentDirectory.total) + " " + (agentDirectory.total === 1 ? "Agent" : "Agents") + " in " + scopedProject.label
            : String(agentDirectory.total) + " " + (agentDirectory.total === 1 ? "Agent" : "Agents") + " across Ponderosa"
          : undefined,
        totalCount: agentDirectoryQuery.requestState.hasResolved ? agentDirectory.total : undefined,
      }}
      searchValue={search}
      onSearchValueChange={setSearch}
      collectionRequest={agentDirectoryQuery.requestState}
      organizationDataComplete={organizationDataComplete}
      onLoadOrganizationData={loadCompleteAgentCollection}
      collectionFooter={(filteredCount) => <CollectionStateFeedback
        request={agentDirectoryQuery.requestState}
        itemCount={filteredCount}
        filtersActive={Boolean(search.trim() || projectId || conversationId !== "all")}
        resourceLabel="Agents"
        emptyTitle="No Agents Yet"
        emptyDetail="Create an Agent to get started."
        noMatchTitle="No Agents match these filters"
        noMatchDetail="Try a different search, status, or Chat filter."
        onClearFilters={() => {
          setSearch("");
          setConversationId("all");
          if (!filterProjectId) setProjectId("");
        }}
      />}
      toolbarControls={<>
        <CollectionDirectoryControls
          sort={sort}
          onSort={value => onPreferences(workspaceResourceSortPatch("agent", value))}
          compact
        />
      </>}
      agents={agents}
      projectId={projectId || undefined}
      engines={engines}
      conversations={conversations}
      conversationFilterValue={conversationId}
      onConversationFilterValueChange={setConversationId}
      conversationFilterRequest={conversationDirectoryQuery.requestState}
      statusByAgentId={statusByAgentId}
      healthByAgentId={healthByAgentId}
      projectByAgentId={projectByAgentId}
      ownerConversationByAgentId={ownerConversationByAgentId}
      displayOrder={rows.map(row => row.agent.id)}
      selectionAllowed
      persistentSelectionMode={managementMode}
      selectionReady={!managementMode || (
        agentDirectoryQuery.requestState.hasResolved &&
        !agentDirectoryQuery.requestState.hasNextPage &&
        !agentDirectoryQuery.requestState.isFetchingNextPage &&
        !agentDirectoryQuery.requestState.isPaginationError
      )}
      onReorder={(sourceId, targetId, position) => onPreferences({
        agentSort: "custom",
        agentOrder: reorderStableIds(
          preferences.agentOrder,
          rows.map(row => row.agent.id),
          sourceId,
          targetId,
          position,
        ),
      })}
      starredAgentIds={starredIds}
      onToggleStar={(agentId) => onPreferences(
        toggleWorkspaceResourceStar(preferences, "agent", agentId),
      )}
      onOpenAgent={(agentId) => {
        const project = projectByAgentId.get(agentId)!;
        onNavigate({ kind: "agent", projectId: project.id, agentId });
      }}
      onOpenAgentSettings={(agentId) => {
        const project = projectByAgentId.get(agentId)!;
        onNavigate({ kind: "agent", projectId: project.id, agentId, view: "settings" });
      }}
      onNewAgent={(managerAgentId) => {
        const context = globalAgentCreateContext(
          rows,
          projectId || undefined,
          managerAgentId,
        );
        if (context) {
          onCreate(
            context.projectId,
            context.managerAgentId,
            context.conversationId,
          );
        }
      }}
      onAgentsDeleted={onAgentsDeleted}
      projects={projects}
    />
  </Box>;
}

export function ProviderActivitySettingsSection({ projects, projectId }: { projects: ProjectDto[]; projectId?: string }): JSX.Element {
  const [scopeSearch, setScopeSearch] = useState("");
  const chatQuery = useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>("conversation", { search: scopeSearch, retainPreviousData: false, maxPages: 1 });
  const agentQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", { search: scopeSearch, retainPreviousData: false, maxPages: 1 });
  const chats = uniqueManagedRows(chatQuery.data?.pages, row => row.conversation.id);
  const agents = uniqueManagedRows(agentQuery.data?.pages, row => row.agent.id);
  const initialProject = projects.find(project => project.id === projectId);
  const [selectedScope, setSelectedScope] = useState({ key: initialProject ? `project:${initialProject.id}` : "overall", label: initialProject?.label ?? "All Ponderosa", group: initialProject ? "Working folders" : "Everything" });
  const scopeKey = selectedScope.key;
  const [rangeKey, setRangeKey] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const from = rangeKey === "all" ? undefined : new Date(Date.now() - ({ "24h": 1, "7d": 7, "30d": 30 }[rangeKey] * 86_400_000)).toISOString();
  const [scope, scopeId] = scopeKey === "overall" ? ["overall", undefined] as const : scopeKey.split(":", 2) as ["project" | "agent" | "conversation", string];
  const usage = useQuery({ queryKey: queryKeys.tokenUsage.detail(scope, scopeId, rangeKey), queryFn: () => api.getTokenUsage(scope, scopeId, from ? { from } : {}), refetchInterval: 30_000 });
  const scopes = [
    { key: "overall", label: "All Ponderosa", group: "Everything" },
    ...projects.filter(project => project.label.toLowerCase().includes(scopeSearch.trim().toLowerCase())).map(project => ({ key: `project:${project.id}`, label: project.label, group: "Working folders" })),
    ...chats.map(({ project, conversation }) => ({ key: `conversation:${conversation.id}`, label: `${conversation.title} · ${project.label}`, group: "Chats" })),
    ...agents.map(({ project, agent, ownerConversation }) => ({ key: `agent:${agent.id}`, label: `${agent.title} · #${agent.handle} · ${ownerConversation?.title ?? project.label}`, group: "Agents" })),
  ].filter(item => item.key !== selectedScope.key);
  // Keep the selected identity even when it is outside the current search/page.
  scopes.unshift(selectedScope);
  const groupOrder = ["Everything", "Working folders", "Chats", "Agents"];
  scopes.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
  return <Paper variant="outlined" sx={{ p: 2.5 }}>
    <Typography variant="h6" fontWeight={800}>Provider Activity</Typography>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Provider-reported Run telemetry for experiments and diagnostics.</Typography>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ pb: 2 }}>
      <Autocomplete options={scopes} value={selectedScope} disableClearable
        filterOptions={items => items.filter(item => item.label.toLowerCase().includes(scopeSearch.trim().toLowerCase()))}
        size="small" sx={{ minWidth: 0, width: { xs: "100%", sm: 360 } }} groupBy={item => item.group}
        getOptionLabel={item => item.label} isOptionEqualToValue={(a, b) => a.key === b.key}
        onInputChange={(_event, value, reason) => { if (reason === "input" || reason === "clear") setScopeSearch(value); }}
        onChange={(_event, item) => { setSelectedScope(item); setScopeSearch(""); }}
        renderInput={params => <TextField {...params} label="Scope" placeholder="Search Chats, Agents, and folders" />} />
      <FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={event => setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl>
    </Stack>
    <Box aria-label="Activity scope results">
      <CollectionStateFeedback request={chatQuery.requestState} itemCount={chats.length} filtersActive={Boolean(scopeSearch.trim())} resourceLabel="Chat scopes" emptyTitle="No Chat scopes" compact autoLoadMore={false} />
      <CollectionStateFeedback request={agentQuery.requestState} itemCount={agents.length} filtersActive={Boolean(scopeSearch.trim())} resourceLabel="Agent scopes" emptyTitle="No Agent scopes" compact autoLoadMore={false} />
    </Box>
    <Alert severity="info" sx={{ mb: 2 }}>Input includes instructions, tools, conversation context, and cached reuse. These are provider-reported tokens, not subscription quota, remaining context, or a cost estimate.</Alert>
    <Box>{usage.isError ? <Alert severity="error">Provider activity could not be loaded.</Alert> : !usage.data ? <LinearProgress /> : <TokenUsageDetails data={usage.data} />}</Box>
  </Paper>;
}
