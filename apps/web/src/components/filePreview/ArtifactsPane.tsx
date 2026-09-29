import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DifferenceIcon from "@mui/icons-material/Difference";
import SearchIcon from "@mui/icons-material/Search";
import TerminalIcon from "@mui/icons-material/Terminal";
import { Alert, Box, Button, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, Stack, TextField, Typography } from "@mui/material";
import { routeToPath } from "../../routeRegistry";
import type { ArtifactDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { telemetryElementId } from "../../telemetryFocus";
import { AgentArtifactPreview } from "./ArtifactPreview";
import { artifactDisplayLabel, artifactDisplayPath, artifactSearchText } from "./artifactPresentation";

function artifactIcon(kind: ArtifactDto["kind"]): JSX.Element {
  if (kind === "diff") {
    return <DifferenceIcon fontSize="small" />;
  }
  if (kind === "test_report") {
    return <CheckCircleOutlineIcon fontSize="small" />;
  }
  if (kind === "log") {
    return <TerminalIcon fontSize="small" />;
  }
  return <ArticleIcon fontSize="small" />;
}

export function ArtifactsPane({
  artifacts,
  agentId,
  agentTitle,
  projectId,
  projectRoot,
  initialArtifactId,
  onSelectArtifact,
}: {
  artifacts: ArtifactDto[];
  agentId: string;
  agentTitle: string;
  projectId: string;
  projectRoot?: string;
  initialArtifactId?: string;
  onSelectArtifact?(artifactId: string): void;
}): JSX.Element {
  const orderedArtifacts = artifacts.filter((artifact) => artifact.kind !== "log").sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(
    initialArtifactId && orderedArtifacts.some((artifact) => artifact.id === initialArtifactId)
      ? initialArtifactId
      : orderedArtifacts[0]?.id,
  );
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (initialArtifactId && orderedArtifacts.some((artifact) => artifact.id === initialArtifactId)) {
      if (selectedArtifactId !== initialArtifactId) setSelectedArtifactId(initialArtifactId);
    } else if (!selectedArtifactId || !orderedArtifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(orderedArtifacts[0]?.id);
    }
  }, [artifacts, initialArtifactId, orderedArtifacts, selectedArtifactId]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleArtifacts = orderedArtifacts.filter((artifact) =>
    !normalizedFilter || artifactSearchText(artifact, projectRoot).includes(normalizedFilter));
  const groups = [
    { label: "Files", kinds: new Set<ArtifactDto["kind"]>(["generated_file", "document", "screenshot", "diff"]) },
    { label: "Results", kinds: new Set<ArtifactDto["kind"]>(["test_report", "pr_summary"]) },
  ].map((group) => ({ ...group, artifacts: visibleArtifacts.filter((artifact) => group.kinds.has(artifact.kind)) }))
    .filter((group) => group.artifacts.length > 0);

  const selectedArtifact = orderedArtifacts.find((artifact) => artifact.id === selectedArtifactId);
  if (orderedArtifacts.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">No files or results yet. Generated files, diffs, and test reports appear here; command output is available in the Chat's Work log and Technical details.</Alert>
        <Button component="a" href={routeToPath({ kind: "agent", projectId, agentId, view: "technical" })}>Open {agentTitle}’s Technical details</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0, height: "100%", overflow: "hidden" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, px: 1.5, py: 1.25, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={750}>Files &amp; Results</Typography>
          <Typography variant="caption" color="text.secondary">{orderedArtifacts.length} item{orderedArtifacts.length === 1 ? "" : "s"} from this agent</Typography>
        </Box>
        <TextField
          size="small"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search files and results"
          inputProps={{ "aria-label": "Search agent files and results" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ width: { xs: "100%", sm: 280 } }}
        />
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(260px, 320px) minmax(0, 1fr)" }, gridTemplateRows: { xs: "minmax(180px, 34%) minmax(0, 1fr)", lg: "minmax(0, 1fr)" }, minHeight: 0 }}>
        <Box component="nav" aria-label="Agent files and results" sx={{ minHeight: 0, overflowY: "auto", borderRight: { lg: 1 }, borderBottom: { xs: 1, lg: 0 }, borderColor: "divider", bgcolor: "background.paper", p: 0.75 }}>
          {groups.length === 0 ? <Alert severity="info" sx={{ m: 0.75 }}>No files or results match “{filter.trim()}”.</Alert> : groups.map((group) => <Box key={group.label} sx={{ mb: 1 }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: "block", px: 1, py: 0.5 }}>{group.label}</Typography>
            <List disablePadding>
              {group.artifacts.map((artifact) => {
                const selected = artifact.id === selectedArtifactId;
                const displayPath = artifactDisplayPath(artifact, projectRoot);
                const displayLabel = artifactDisplayLabel(artifact, displayPath);
                return <ListItemButton
                  key={artifact.id}
                  aria-label={`Open ${displayLabel} (${displayPath})`}
                  title={displayPath}
                  id={telemetryElementId("artifacts", artifact.id)}
                  tabIndex={initialArtifactId === artifact.id ? -1 : undefined}
                  selected={selected}
                  onClick={() => {
                    setSelectedArtifactId(artifact.id);
                    onSelectArtifact?.(artifact.id);
                  }}
                  aria-current={selected ? "true" : undefined}
                  sx={{ borderRadius: 1.5, mb: 0.25, alignItems: "flex-start", px: 1, py: 0.75 }}
                >
                  <ListItemIcon sx={{ minWidth: 34, mt: 0.25, color: selected ? "primary.main" : "text.secondary" }}>{artifactIcon(artifact.kind)}</ListItemIcon>
                  <ListItemText
                    primary={displayLabel}
                    secondary={new Date(artifact.createdAt).toLocaleString()}
                    primaryTypographyProps={{ variant: "body2", fontWeight: selected ? 750 : 600, noWrap: true }}
                    secondaryTypographyProps={{ variant: "caption", color: "text.secondary", component: "span", sx: { lineHeight: 1.35 } }}
                    sx={{ minWidth: 0, m: 0 }}
                  />
                </ListItemButton>;
              })}
            </List>
          </Box>)}
        </Box>
        <Box sx={{ minWidth: 0, minHeight: 0, overflow: "auto", bgcolor: "background.default" }}>
        <AgentArtifactPreview
          artifact={selectedArtifact}
          agentId={agentId}
          agentTitle={agentTitle}
          projectId={projectId}
          projectRoot={projectRoot}
        />
        </Box>
      </Box>
    </Box>
  );
}
