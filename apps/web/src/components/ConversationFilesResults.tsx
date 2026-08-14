import CloseIcon from "@mui/icons-material/Close";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { AgentDto, ArtifactDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../api";
import { uniqueBy } from "../collections";
import { queryKeys } from "../queryKeys";
import { ProjectArtifactPreview } from "./filePreview/ArtifactPreview";
import { artifactDisplayLabel, artifactSearchText } from "./filePreview/artifactPresentation";
import {
  projectArtifactDisplayPath,
  projectArtifactGroup,
  projectOutputKinds,
} from "./ProjectArtifactsView.helpers";

export function ConversationFilesResults({
  projectId,
  projectRoot,
  conversationId,
  agents,
}: {
  projectId: string;
  projectRoot: string;
  conversationId: string;
  agents: AgentDto[];
}): JSX.Element {
  const theme = useTheme();
  const fullScreenPreview = useMediaQuery(theme.breakpoints.down("sm"));
  const [filter, setFilter] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactDto>();
  const [older, setOlder] = useState<{
    items: ArtifactDto[];
    cursor?: string;
    hasMore: boolean;
  }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const artifacts = useQuery({
    queryKey: queryKeys.projectArtifacts.conversation(
      projectId,
      conversationId,
    ),
    queryFn: () => api.listConversationArtifacts(projectId, conversationId),
  });
  const agentById = useMemo(
    () => new Map(agents.map(agent => [agent.id, agent] as const)),
    [agents],
  );
  const records = useMemo(
    () =>
      uniqueBy(
        [...(older?.items ?? []), ...(artifacts.data?.items ?? [])],
        artifact => artifact.id,
      )
        .filter(artifact => projectOutputKinds.has(artifact.kind))
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        ),
    [artifacts.data?.items, older?.items],
  );
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      records.filter(artifact => {
        const owner = agentById.get(
          artifact.originAgentId ?? artifact.agentId,
        );
        return (
          !normalizedFilter ||
          [
            owner?.title,
            artifactSearchText(artifact, projectRoot),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedFilter)
        );
      }),
    [agentById, normalizedFilter, projectRoot, records],
  );
  const grouped = (["Modified & Created Files", "Results"] as const)
    .map(label => ({
      label,
      artifacts: filtered.filter(
        artifact => projectArtifactGroup(artifact.kind) === label,
      ),
    }))
    .filter(group => group.artifacts.length > 0);
  const hasMore = older?.hasMore ?? artifacts.data?.history.hasMore ?? false;
  const previewOwner = previewArtifact
    ? agentById.get(previewArtifact.originAgentId ?? previewArtifact.agentId)
    : undefined;

  return (
    <Box
      role="tabpanel"
      aria-label="Chat files and results"
      sx={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: "background.default",
      }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{
          alignItems: { sm: "center" },
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle1" fontWeight={800}>
            Files &amp; Results
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {records.length} item{records.length === 1 ? "" : "s"} created by
            Agents in this Chat
          </Typography>
        </Box>
        <TextField
          size="small"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Search files, results, or agents"
          inputProps={{ "aria-label": "Search Chat files and results" }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ width: { xs: "100%", sm: 360 } }}
        />
      </Stack>

      <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", p: { xs: 1, sm: 1.5 } }}>
        {artifacts.isLoading && records.length === 0 ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", p: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Loading Chat files…
            </Typography>
          </Stack>
        ) : null}
        {artifacts.isError ? (
          <Alert severity="error">Chat files could not be loaded. Try again.</Alert>
        ) : null}
        {!artifacts.isLoading && records.length === 0 ? (
          <Alert severity="info">
            No files or results yet. Anything created by an Agent in this Chat
            will appear here.
          </Alert>
        ) : null}
        {records.length > 0 && filtered.length === 0 ? (
          <Alert severity="info">No files or results match “{filter.trim()}”.</Alert>
        ) : null}
        <Stack spacing={1.25}>
          {grouped.map(group => (
            <Box component="section" aria-label={group.label} key={group.label}>
              <Typography variant="overline" color="text.secondary" sx={{ display: "block", px: 0.5, mb: 0.5 }}>
                {group.label}
              </Typography>
              <List disablePadding aria-label={`${group.label} items`} sx={{ display: "grid", gap: 0.75 }}>
                {group.artifacts.map(artifact => {
                  const ownerId = artifact.originAgentId ?? artifact.agentId;
                  const owner = agentById.get(ownerId);
                  const displayPath = projectArtifactDisplayPath(
                    artifact,
                    projectRoot,
                  );
                  const label = artifactDisplayLabel(artifact, displayPath);
                  return (
                    <Box
                      key={artifact.id}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        minWidth: 0,
                        borderRadius: 1.5,
                        bgcolor: "background.paper",
                        boxShadow: theme => `inset 0 0 0 1px ${theme.palette.divider}`,
                        overflow: "hidden",
                      }}
                    >
                      <ListItemButton
                        aria-label={`Preview ${label} from ${owner?.title ?? "Deleted Agent"}`}
                        title={displayPath}
                        onClick={() => setPreviewArtifact(artifact)}
                        sx={{ minWidth: 0 }}
                      >
                      <ListItemIcon sx={{ minWidth: 40 }}>
                        <Inventory2OutlinedIcon />
                      </ListItemIcon>
                      <ListItemText
                        primary={label}
                        secondary={[
                          displayPath,
                          owner?.title ?? `Deleted Agent · ${ownerId.slice(0, 8)}`,
                          new Date(artifact.createdAt).toLocaleString(),
                        ].join(" · ")}
                        primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
                        secondaryTypographyProps={{ noWrap: true }}
                        sx={{ minWidth: 0 }}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={artifact.kind.replaceAll("_", " ")}
                        sx={{ display: { xs: "none", md: "inline-flex" }, ml: 1 }}
                      />
                      </ListItemButton>
                      {artifact.downloadUrl ? (
                        <Button
                          component="a"
                          href={artifact.downloadUrl}
                          download
                          size="small"
                          aria-label={`Download ${label}`}
                          startIcon={<DownloadOutlinedIcon />}
                          sx={{ mr: 1, flexShrink: 0 }}
                        >
                          <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
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
          {hasMore ? (
            <Button
              color="inherit"
              disabled={loadingOlder}
              onClick={() => {
                const cursor = older?.cursor ?? artifacts.data?.history.cursor;
                if (!cursor) return;
                setLoadingOlder(true);
                void api
                  .listConversationArtifacts(projectId, conversationId, 100, cursor)
                  .then(page =>
                    setOlder(current => ({
                      items: uniqueBy(
                        [...page.items, ...(current?.items ?? [])],
                        artifact => artifact.id,
                      ),
                      cursor: page.history.cursor,
                      hasMore: page.history.hasMore,
                    })),
                  )
                  .finally(() => setLoadingOlder(false));
              }}
              sx={{ alignSelf: "center" }}
            >
              {loadingOlder ? "Loading…" : "Load Older Files"}
            </Button>
          ) : null}
        </Stack>
      </Box>

      <Dialog
        open={Boolean(previewArtifact)}
        onClose={() => setPreviewArtifact(undefined)}
        fullScreen={fullScreenPreview}
        fullWidth
        maxWidth="lg"
        aria-labelledby="chat-artifact-preview-title"
      >
        <DialogTitle id="chat-artifact-preview-title" component="div">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography component="h2" variant="h6" noWrap sx={{ minWidth: 0, flex: 1 }}>
              {previewArtifact
                ? artifactDisplayLabel(
                    previewArtifact,
                    projectArtifactDisplayPath(previewArtifact, projectRoot),
                  )
                : "Preview"}
            </Typography>
            <IconButton aria-label="Close preview" onClick={() => setPreviewArtifact(undefined)}>
              <CloseIcon />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
          {previewArtifact ? (
            <ProjectArtifactPreview
              artifact={previewArtifact}
              projectRoot={projectRoot}
              agent={previewOwner}
            />
          ) : null}
        </DialogContent>
        <DialogActions>
          {previewArtifact?.downloadUrl ? (
            <Button component="a" href={previewArtifact.downloadUrl} download startIcon={<DownloadOutlinedIcon />}>
              Download
            </Button>
          ) : null}
          <Button onClick={() => setPreviewArtifact(undefined)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
