import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputAdornment,
  InputLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type {
  AgentDto,
  AgentHealthDto,
  ArtifactDto,
  ConversationDto,
  EngineDto,
  ProjectDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import type { ProjectDetailView, Route } from "../routing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AgentStatus } from "../agents";
import { uniqueBy } from "../collections";
import { queryKeys } from "../queryKeys";
import { AgentsTab } from "./AgentsTab";
import { COLLECTION_PROGRESSIVE_BATCH_SIZE } from "./CollectionPrimitives";
import { artifactDisplayLabel, artifactSearchText } from "./filePreview/artifactPresentation";
import {
  ProjectOverview,
  projectHealthDetail,
  projectHealthPresentation,
} from "./ProjectOverview";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";
import { ProjectArtifactPreview } from "./filePreview/ArtifactPreview";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import {
  PROJECT_FILE_CATEGORIES,
  matchesProjectFileCategories,
  projectArtifactGroup,
  projectArtifactDisplayPath,
  projectFileCategory,
  projectOutputKinds,
  type ProjectFileCategory,
} from "./ProjectArtifactsView.helpers";
import { AllTriggersWorkspace } from "./WorkspaceResourceViews";

export function ProjectArtifactsView({
  projectId,
  project,
  agents,
  health,
  healthByAgentId,
  engines,
  notifications,
  preferences,
  onPreferences,
  onCreateConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
  statusByAgentId,
  onOpenAgent,
  onOpenAgentSettings,
  onAgentsDeleted,
  onNewAgent,
  onNavigateTrigger,
  onCreateTrigger,
  onProjectDeleted,
  onOpenEngineStatus,
  onOpenArtifact,
  conversations,
  initialView,
  onViewChange,
}: {
  projectId: string;
  project: ProjectDto;
  agents: AgentDto[];
  health: AgentHealthDto[] | undefined;
  healthByAgentId: Map<string, AgentHealthDto>;
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onCreateConversation(): void;
  onOpenConversation(conversationId: string): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  statusByAgentId: ReadonlyMap<string, AgentStatus>;
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onAgentsDeleted(agentIds: string[]): void;
  onNewAgent(managerAgentId?: string): void;
  onNavigateTrigger(route: Route): void;
  onCreateTrigger(): void;
  onProjectDeleted(projectId: string): void;
  onOpenEngineStatus(): void;
  onOpenArtifact(agentId: string, artifactId: string): void;
  conversations: ConversationDto[];
  initialView?: ProjectDetailView;
  onViewChange(view: ProjectDetailView): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const phonePreview = useMediaQuery(theme.breakpoints.down("sm"));
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<ProjectDetailView>(initialView ?? "overview");
  const [fileCategories, setFileCategories] = useState<
    Array<Exclude<ProjectFileCategory, "all">>
  >([]);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactDto>();
  const [olderArtifacts, setOlderArtifacts] = useState<{
    items: ArtifactDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [projectDeleteOpen, setProjectDeleteOpen] = useState(false);
  useEffect(() => {
    setTab(initialView ?? "overview");
    setOlderArtifacts(undefined);
    setPreviewArtifact(undefined);
    setFileCategories([]);
  }, [projectId, initialView]);
  const changeTab = (next: ProjectDetailView) => {
    setTab(next);
    onViewChange(next);
  };
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const projectArtifacts = useQuery({
    queryKey: queryKeys.projectArtifacts.project(projectId),
    queryFn: () => api.listProjectArtifacts(projectId),
  });
  const updateArtifact = useMutation({
    mutationFn: ({
      artifactId,
      pinned,
      visibility,
    }: {
      artifactId: string;
      pinned?: boolean;
      visibility?: "project" | "published";
    }) =>
      api.updateProjectArtifact(projectId, artifactId, {
        ...(pinned !== undefined ? { pinned } : {}),
        ...(visibility ? { visibility } : {}),
      }),
    onSuccess: artifact => {
      setPreviewArtifact(artifact);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectArtifacts.project(projectId),
      });
    },
  });
  const records = useMemo(() => {
    const agentById = new Map(agents.map(agent => [agent.id, agent] as const));
    const canonical = uniqueBy(
      [
        ...(olderArtifacts?.items ?? []),
        ...(projectArtifacts.data?.items ?? []),
      ],
      artifact => artifact.id,
    ).filter(artifact => projectOutputKinds.has(artifact.kind));
    return canonical
      .map(artifact => ({
        agent: agentById.get(artifact.originAgentId ?? artifact.agentId),
        artifact,
      }))
      .sort((left, right) =>
        right.artifact.createdAt.localeCompare(left.artifact.createdAt),
      );
  }, [agents, olderArtifacts?.items, projectArtifacts.data?.items]);
  const filtered = useMemo(
    () =>
      records.filter(({ agent, artifact }) => {
        if (
          projectArtifactGroup(artifact.kind) === "Modified & Created Files" &&
          !matchesProjectFileCategories(artifact, fileCategories)
        )
          return false;
        return (
          !normalizedFilter ||
          [
            agent?.title,
            artifactSearchText(artifact, project.hostPath),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedFilter)
        );
      }),
    [fileCategories, records, normalizedFilter, project.hostPath],
  );
  const fileCategoryOptions = useMemo(() => {
    const counts = new Map<ProjectFileCategory, number>(
      PROJECT_FILE_CATEGORIES.map(({ value }) => [value, 0]),
    );
    const files = records.filter(
      ({ artifact }) =>
        projectArtifactGroup(artifact.kind) === "Modified & Created Files",
    );
    counts.set("all", files.length);
    files.forEach(({ artifact }) => {
      const category = projectFileCategory(artifact);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    });
    return PROJECT_FILE_CATEGORIES.map(option => ({
      ...option,
      count: counts.get(option.value) ?? 0,
    }));
  }, [records]);
  const grouped = (["Modified & Created Files", "Results"] as const)
    .map(label => ({
      label,
      records: filtered.filter(
        ({ artifact }) => projectArtifactGroup(artifact.kind) === label,
      ),
    }))
    .filter(group => group.records.length > 0);
  const loading = projectArtifacts.isLoading;
  const projectHealth = projectHealthPresentation(health, agents, engines);
  const projectHealthTooltip = projectHealthDetail(health, agents, engines);

  return (
    <Box
      className="ponderosa-scroll"
      sx={{ minHeight: 0, minWidth: 0, width: "100%", overflowY: "auto" }}
    >
      <TabbedWorkspaceFrame<ProjectDetailView>
        icon={<FolderOutlinedIcon />}
        title={project.label}
        context={
          <Typography variant="body2" color="text.secondary" noWrap>
            {project.hostPath}
          </Typography>
        }
        status={
          <Tooltip
            title={`${projectHealthTooltip} Click for AI provider details.`}
            arrow
          >
            <Button
              size="small"
              color="inherit"
              aria-label={`${projectHealth.label}. ${projectHealthTooltip} Open AI provider details.`}
              onClick={onOpenEngineStatus}
              startIcon={
                <Box
                  sx={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    bgcolor: projectHealth.color,
                  }}
                />
              }
            >
              {projectHealth.label}
            </Button>
          </Tooltip>
        }
        actions={
          <ChatOverflowMenu
            label={`Actions for ${project.label}`}
            transcriptMarkdown=""
            transcriptFileName=""
            showExports={false}
            actions={[
              {
                label: "Project Settings",
                icon: <SettingsOutlinedIcon fontSize="small" />,
                onSelect: () => changeTab("settings"),
              },
              {
                label: "Delete Project",
                icon: <DeleteOutlineIcon fontSize="small" />,
                destructive: true,
                onSelect: () => setProjectDeleteOpen(true),
              },
            ]}
          />
        }
        tabs={{
          value: tab,
          onChange: changeTab,
          label: "Project",
          items: [
            {
              value: "overview",
              label: "Overview",
              icon: <DashboardOutlinedIcon />,
            },
            {
              value: "files",
              label: "Files & Results",
              icon: <Inventory2OutlinedIcon />,
            },
            {
              value: "agents",
              label: "Agents",
              icon: <SmartToyOutlinedIcon />,
            },
            {
              value: "triggers",
              label: "Automations",
              icon: <BoltOutlinedIcon />,
            },
            {
              value: "settings",
              label: "Settings",
              icon: <SettingsOutlinedIcon />,
            },
          ],
        }}
      />
      <Box
        sx={{
          p:
            tab === "agents" || tab === "triggers" || tab === "settings"
              ? 0
              : { xs: 1.5, sm: 3 },
        }}
      >
        <Stack spacing={1.5} sx={{ width: "100%", minWidth: 0 }}>
          {tab === "overview" ? (
            <>
              <ProjectOverview
                project={project}
                agents={agents}
                healthByAgentId={healthByAgentId}
                importantArtifacts={(projectArtifacts.data?.items ?? []).filter(
                  artifact =>
                    artifact.pinned || artifact.visibility === "published",
                )}
                conversations={conversations}
                notifications={notifications}
                preferences={preferences}
                onPreferences={onPreferences}
                onCreateConversation={onCreateConversation}
                onOpenConversation={onOpenConversation}
                onRenameConversation={onRenameConversation}
                onDeleteConversation={onDeleteConversation}
                onOpenImportantArtifact={artifact => {
                  if (artifact.previewUrl) setPreviewArtifact(artifact);
                  else {
                    const owner = agents.find(
                      agent =>
                        agent.id ===
                        (artifact.originAgentId ?? artifact.agentId),
                    );
                    if (owner) onOpenArtifact(owner.id, artifact.id);
                    else
                      document
                        .getElementById("project-files-and-results")
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                  }
                }}
              />
            </>
          ) : null}
          {tab === "files" ? (
            <>
              <Box>
                <Typography
                  id="project-files-and-results"
                  variant="h5"
                  component="h2"
                  fontWeight={800}
                  sx={{ scrollMarginTop: 16 }}
                >
                  Files &amp; Results
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Modified and created files, documents, images, downloads, and
                  results across this Project.
                </Typography>
              </Box>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1}
                sx={{ alignItems: { sm: "center" } }}
              >
                <TextField
                  size="small"
                  value={filter}
                  onChange={event => setFilter(event.target.value)}
                  placeholder="Search files, results, or agents"
                  inputProps={{ "aria-label": "Search project files" }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    ),
                  }}
                  sx={{ width: { xs: "100%", sm: 420 } }}
                />
                <FormControl
                  size="small"
                  sx={{ minWidth: 180, width: { xs: "100%", sm: "auto" } }}
                >
                  <InputLabel id="project-file-category-label">
                    File Types
                  </InputLabel>
                  <Select
                    labelId="project-file-category-label"
                    label="File Types"
                    multiple
                    value={fileCategories}
                    onChange={(
                      event: SelectChangeEvent<
                        Array<Exclude<ProjectFileCategory, "all">>
                      >,
                    ) => {
                      const value = event.target.value;
                      setFileCategories(
                        typeof value === "string"
                          ? (value.split(",") as Array<
                              Exclude<ProjectFileCategory, "all">
                            >)
                          : value,
                      );
                    }}
                    inputProps={{
                      "aria-label": "Filter project files by type",
                    }}
                    sx={{ minHeight: { xs: 44, sm: 40 } }}
                    renderValue={values => {
                      if (values.length === 0)
                        return `All (${fileCategoryOptions.find(option => option.value === "all")?.count ?? 0})`;
                      if (values.length <= 2)
                        return values
                          .map(
                            value =>
                              fileCategoryOptions.find(
                                candidate => candidate.value === value,
                              )?.label ?? value,
                          )
                          .join(", ");
                      return `${values.length} File Types`;
                    }}
                  >
                    {fileCategoryOptions
                      .filter(option => option.value !== "all")
                      .map(option => (
                        <MenuItem key={option.value} value={option.value}>
                          <Checkbox
                            checked={fileCategories.includes(
                              option.value as Exclude<
                                ProjectFileCategory,
                                "all"
                              >,
                            )}
                          />
                          {option.label} ({option.count})
                        </MenuItem>
                      ))}
                  </Select>
                </FormControl>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {filtered.length === records.length
                  ? `${records.length} project items`
                  : `${filtered.length} of ${records.length} project items`}
              </Typography>
              {(olderArtifacts?.hasMore ??
              projectArtifacts.data?.history.hasMore) ? (
                <Button
                  size="small"
                  color="inherit"
                  disabled={loadingOlder}
                  onClick={() => {
                    const cursor =
                      olderArtifacts?.cursor ??
                      projectArtifacts.data?.history.cursor;
                    if (!cursor) return;
                    setLoadingOlder(true);
                    void api
                      .listProjectArtifacts(projectId, 100, cursor)
                      .then(page => {
                        setOlderArtifacts(current => ({
                          items: uniqueBy(
                            [...page.items, ...(current?.items ?? [])],
                            artifact => artifact.id,
                          ),
                          cursor: page.history.cursor,
                          hasMore: page.history.hasMore,
                        }));
                      })
                      .finally(() => setLoadingOlder(false));
                  }}
                  sx={{ alignSelf: "center" }}
                >
                  {loadingOlder ? "Loading…" : "Load Older Files"}
                </Button>
              ) : null}
              {loading && records.length === 0 ? (
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", py: 2 }}
                >
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">
                    Loading project files…
                  </Typography>
                </Stack>
              ) : null}
              {projectArtifacts.isError ? (
                <Alert severity="error">
                  Project files could not be loaded. Try again.
                </Alert>
              ) : null}
              {!loading && records.length === 0 ? (
                <Alert severity="info">
                  No project files yet. Agent-created documents, images,
                  downloads, and generated results will appear here.
                </Alert>
              ) : null}
              {records.length > 0 && filtered.length === 0 ? (
                <Alert severity="info">
                  No project files match the active search and file-type
                  filters.
                </Alert>
              ) : null}
              <Box
                aria-label="Project files and results"
                sx={{ display: "grid", gap: 1.25 }}
              >
                {grouped.map(group => (
                  <Box
                    key={group.label}
                    component="section"
                    aria-label={group.label}
                  >
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      sx={{ display: "block", mb: 0.5 }}
                    >
                      {group.label}
                    </Typography>
                    <List
                      aria-label={`${group.label} items`}
                      disablePadding
                      sx={{ display: "grid", gap: 0.75 }}
                    >
                      {group.records.map(({ agent, artifact }) => {
                        const displayPath = projectArtifactDisplayPath(
                          artifact,
                          project.hostPath,
                        );
                        const label = artifactDisplayLabel(artifact, displayPath);
                        const originAgentId =
                          artifact.originAgentId ?? artifact.agentId;
                        const owner =
                          agent?.title ??
                          `Deleted Agent · ${originAgentId.slice(0, 8)}`;
                        const canOpen = Boolean(
                          artifact.previewUrl ||
                          agent ||
                          artifact.kind === "diff",
                        );
                        return (
                          <Box
                            key={`${artifact.projectId ?? projectId}:${artifact.id}`}
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              minWidth: 0,
                              borderRadius: 1.5,
                              bgcolor: "background.paper",
                              boxShadow: theme =>
                                `inset 0 0 0 1px ${theme.palette.divider}`,
                              overflow: "hidden",
                            }}
                          >
                            <ListItemButton
                              aria-label={`Open ${label} (${displayPath}) from ${owner}`}
                              title={displayPath}
                              disabled={!canOpen}
                              onClick={() => {
                                if (
                                  artifact.previewUrl ||
                                  artifact.kind === "diff"
                                )
                                  setPreviewArtifact(artifact);
                                else if (agent)
                                  onOpenArtifact(agent.id, artifact.id);
                              }}
                              sx={{ minWidth: 0, px: 1.5 }}
                            >
                              <ListItemIcon sx={{ minWidth: 40 }}>
                                <Inventory2OutlinedIcon />
                              </ListItemIcon>
                              <ListItemText
                                primary={label}
                                secondary={[
                                  displayPath,
                                  owner,
                                  artifact.executionId
                                    ? `Run ${artifact.executionId.slice(0, 8)}`
                                    : "No Run",
                                  artifact.visibility === "published"
                                    ? "Published"
                                    : "Project",
                                ].join(" · ")}
                                primaryTypographyProps={{
                                  fontWeight: 750,
                                  noWrap: true,
                                }}
                                secondaryTypographyProps={{ noWrap: true }}
                              />
                              <Stack
                                direction="row"
                                spacing={1}
                                sx={{
                                  ml: 1,
                                  alignItems: "center",
                                  flexShrink: 0,
                                  display: { xs: "none", lg: "flex" },
                                }}
                              >
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={artifact.kind.replaceAll("_", " ")}
                                />
                                {artifact.pinned ? (
                                  <Chip
                                    size="small"
                                    color="primary"
                                    variant="outlined"
                                    label="Pinned"
                                  />
                                ) : null}
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {new Date(
                                    artifact.createdAt,
                                  ).toLocaleDateString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                  })}
                                </Typography>
                              </Stack>
                            </ListItemButton>
                            {artifact.previewUrl ? (
                              <Button
                                aria-label={`Preview ${label}`}
                                onClick={() => setPreviewArtifact(artifact)}
                                size="small"
                                startIcon={<OpenInNewOutlinedIcon />}
                                sx={{
                                  display: { xs: "none", lg: "inline-flex" },
                                  mr: 0.5,
                                  flexShrink: 0,
                                }}
                              >
                                Preview
                              </Button>
                            ) : null}
                            {artifact.downloadUrl ? (
                              <Button
                                component="a"
                                href={artifact.downloadUrl}
                                download
                                size="small"
                                aria-label={`Download ${label}`}
                                startIcon={<DownloadOutlinedIcon />}
                                sx={{
                                  mr: { xs: 0.5, sm: 1 },
                                  px: { xs: 0.75, sm: 1 },
                                  flexShrink: 0,
                                }}
                              >
                                <Box
                                  component="span"
                                  sx={{ display: { xs: "none", sm: "inline" } }}
                                >
                                  Download
                                </Box>
                              </Button>
                            ) : null}
                          </Box>
                        );
                      })}
                    </List>
                  </Box>
                ))}
              </Box>
            </>
          ) : null}
          {tab === "agents" ? (
            <AgentsTab
              collection={{
                title: "Project Agents",
                detail: `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"} in ${project.label}`,
                totalCount: agents.length,
                variant: "embedded",
              }}
              agents={agents}
              projectId={projectId}
              engines={engines}
              conversations={conversations}
              statusByAgentId={statusByAgentId}
              healthByAgentId={healthByAgentId}
              progressiveBatchSize={COLLECTION_PROGRESSIVE_BATCH_SIZE}
              onOpenAgent={onOpenAgent}
              onOpenAgentSettings={onOpenAgentSettings}
              onAgentsDeleted={(_projectId, agentIds) =>
                onAgentsDeleted(agentIds)}
              onNewAgent={onNewAgent}
            />
          ) : null}
          {tab === "triggers" ? (
            <AllTriggersWorkspace
              projects={[project]}
              filterProjectId={projectId}
              embedded
              preferences={preferences}
              onPreferences={onPreferences}
              onNavigate={onNavigateTrigger}
              onCreate={onCreateTrigger}
            />
          ) : null}
          {tab === "settings" ? (
            <ProjectSettingsPanel
              project={project}
              engines={engines}
              preferences={preferences}
              onDeleted={onProjectDeleted}
            />
          ) : null}
        </Stack>
      </Box>
      <Dialog
        open={Boolean(previewArtifact)}
        onClose={() => setPreviewArtifact(undefined)}
        fullScreen={phonePreview}
        fullWidth
        maxWidth="lg"
        aria-labelledby="artifact-preview-title"
        slotProps={{
          paper: {
            sx: {
              maxHeight: { xs: "100dvh", sm: "calc(100% - 64px)" },
            },
          },
        }}
      >
        <DialogTitle component="div">
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            flexWrap="wrap"
            sx={{ alignItems: "center" }}
          >
            <Typography
              component="h2"
              variant="h6"
              id="artifact-preview-title"
              sx={{ m: 0 }}
            >
              {previewArtifact
                ? artifactDisplayLabel(
                    previewArtifact,
                    projectArtifactDisplayPath(previewArtifact, project.hostPath),
                  )
                : "File Preview"}
            </Typography>
            {previewArtifact ? (
              <>
                <Chip
                  size="small"
                  label={`Created by ${agents.find(agent => agent.id === (previewArtifact.originAgentId ?? previewArtifact.agentId))?.title ?? "deleted Agent"}`}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    previewArtifact.visibility === "published"
                      ? "Published"
                      : "Project Scope"
                  }
                />
              </>
            ) : null}
          </Stack>
        </DialogTitle>
        <DialogContent
          sx={{
            minWidth: 0,
            px: { xs: 1, sm: 2 },
            pt: { xs: "12px !important", sm: "20px !important" },
            pb: { xs: 1, sm: 2 },
            bgcolor: "background.default",
            overflow: "auto",
          }}
        >
          {previewArtifact ? (
            <ProjectArtifactPreview
              key={previewArtifact.id}
              artifact={previewArtifact}
              projectRoot={project.hostPath}
              agent={agents.find(
                candidate =>
                  candidate.id ===
                  (previewArtifact.originAgentId ?? previewArtifact.agentId),
              )}
            />
          ) : null}
        </DialogContent>
        <DialogActions
          sx={{
            flexWrap: "wrap",
            gap: 0.5,
            px: { xs: 1, sm: 2 },
            pb: { xs: "max(8px, env(safe-area-inset-bottom))", sm: 1 },
            "& .MuiButton-root": { minHeight: { xs: 44, sm: 36 } },
          }}
        >
          {previewArtifact
            ? (() => {
                const owner = agents.find(
                  agent =>
                    agent.id ===
                    (previewArtifact.originAgentId ?? previewArtifact.agentId),
                );
                return owner ? (
                  <Button
                    onClick={() => onOpenArtifact(owner.id, previewArtifact.id)}
                  >
                    Open Agent Record
                  </Button>
                ) : null;
              })()
            : null}
          {previewArtifact?.visibility ? (
            <Button
              disabled={updateArtifact.isPending}
              onClick={() =>
                updateArtifact.mutate({
                  artifactId: previewArtifact.id,
                  pinned: !previewArtifact.pinned,
                })
              }
            >
              {previewArtifact.pinned ? "Unpin" : "Pin"}
            </Button>
          ) : null}
          {previewArtifact?.visibility ? (
            <Button
              disabled={updateArtifact.isPending}
              onClick={() =>
                updateArtifact.mutate({
                  artifactId: previewArtifact.id,
                  visibility:
                    previewArtifact.visibility === "published"
                      ? "project"
                      : "published",
                })
              }
            >
              {previewArtifact.visibility === "published"
                ? "Make Project-Only"
                : "Publish"}
            </Button>
          ) : null}
          {previewArtifact?.downloadUrl ? (
            <Button
              component="a"
              href={previewArtifact.downloadUrl}
              download
              startIcon={<DownloadOutlinedIcon />}
            >
              Download
            </Button>
          ) : null}
          <Button onClick={() => setPreviewArtifact(undefined)}>Close</Button>
        </DialogActions>
      </Dialog>
      <ProjectDeletionDialog
        project={project}
        open={projectDeleteOpen}
        onClose={() => setProjectDeleteOpen(false)}
        onDeleted={onProjectDeleted}
      />
    </Box>
  );
}
