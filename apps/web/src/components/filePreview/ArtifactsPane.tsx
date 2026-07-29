import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DifferenceIcon from "@mui/icons-material/Difference";
import SearchIcon from "@mui/icons-material/Search";
import TerminalIcon from "@mui/icons-material/Terminal";
import { Alert, Box, Chip, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, Stack, TextField, Typography } from "@mui/material";
import type { ArtifactDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import type { ExecutionItem } from "../../hooks/useAgentStream";
import { telemetryElementId } from "../../telemetryFocus";
import { ResourceContextMenu } from "../ResourceContextMenu";
import type { ResourceContextMenuState } from "../ResourceContextMenu";
import { AgentArtifactPreview } from "./ArtifactPreview";

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

function compactPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) {
    return path;
  }
  return `${parts[0]}/.../${parts.at(-1)}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function artifactDisplayLabel(artifact: Pick<ArtifactDto, "kind" | "path" | "summary">): string {
  const summary = artifact.summary?.trim();
  const fileAction = summary?.match(/^(create|edit|delete)\s+(.+)$/i);
  if (fileAction) {
    const action = fileAction[1]![0]!.toUpperCase() + fileAction[1]!.slice(1).toLowerCase();
    return `${action} · ${fileName(fileAction[2]!)}`;
  }
  if (artifact.kind === "log" && summary) {
    const command = summary.replace(/^\/bin\/(?:ba)?sh\s+-lc\s+/, "");
    return `Command · ${command.length > 56 ? `${command.slice(0, 55)}…` : command}`;
  }
  return summary || fileName(artifact.path) || "Result";
}

export function ArtifactsPane({
  artifacts,
  agentId,
  agentTitle,
  timeline,
  initialArtifactId,
  onSelectArtifact,
  onOpenArtifactInNewTab,
}: {
  artifacts: ArtifactDto[];
  agentId: string;
  agentTitle: string;
  timeline: ExecutionItem[];
  initialArtifactId?: string;
  onSelectArtifact?(artifactId: string): void;
  onOpenArtifactInNewTab?(artifactId: string): void;
}): JSX.Element {
  const orderedArtifacts = artifacts.filter((artifact) => artifact.kind !== "log").sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(
    initialArtifactId && orderedArtifacts.some((artifact) => artifact.id === initialArtifactId)
      ? initialArtifactId
      : orderedArtifacts[0]?.id,
  );
  const [filter, setFilter] = useState("");
  const [artifactMenu, setArtifactMenu] = useState<ResourceContextMenuState<string>>();

  useEffect(() => {
    if (initialArtifactId && orderedArtifacts.some((artifact) => artifact.id === initialArtifactId)) {
      if (selectedArtifactId !== initialArtifactId) setSelectedArtifactId(initialArtifactId);
    } else if (!selectedArtifactId || !orderedArtifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(orderedArtifacts[0]?.id);
    }
  }, [artifacts, initialArtifactId, orderedArtifacts, selectedArtifactId]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleArtifacts = orderedArtifacts.filter((artifact) => !normalizedFilter || [
    artifactDisplayLabel(artifact), artifact.path, artifact.summary, artifact.kind,
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter));
  const groups = [
    { label: "Files", kinds: new Set<ArtifactDto["kind"]>(["generated_file", "document", "screenshot", "diff"]) },
    { label: "Results", kinds: new Set<ArtifactDto["kind"]>(["test_report", "pr_summary"]) },
  ].map((group) => ({ ...group, artifacts: visibleArtifacts.filter((artifact) => group.kinds.has(artifact.kind)) }))
    .filter((group) => group.artifacts.length > 0);

  const selectedArtifact = orderedArtifacts.find((artifact) => artifact.id === selectedArtifactId);
  const liveSeq = selectedArtifact?.id.startsWith("live-artifact-")
    ? Number(selectedArtifact.id.replace("live-artifact-", ""))
    : undefined;
  const liveEvent = timeline.find((item) => item.seq === liveSeq)?.event;
  const liveContent =
    liveEvent?.type === "file_change"
      ? (liveEvent.diff ?? `No diff body for ${liveEvent.path}.`)
      : liveEvent?.type === "test_result"
        ? `## Test result\n\n${liveEvent.summary}`
        : undefined;

  if (orderedArtifacts.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">No files or results yet. Generated files, diffs, and test reports appear here; command output is available in Activity.</Alert>
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
                return <ListItemButton
                  key={artifact.id}
                  id={telemetryElementId("artifacts", artifact.id)}
                  tabIndex={initialArtifactId === artifact.id ? -1 : undefined}
                  selected={selected}
                  onClick={() => {
                    setSelectedArtifactId(artifact.id);
                    onSelectArtifact?.(artifact.id);
                  }}
                  onContextMenu={(event) => { event.preventDefault(); setArtifactMenu({ anchor: event.currentTarget, resource: artifact.id }); }}
                  aria-current={selected ? "true" : undefined}
                  sx={{ borderRadius: 1.5, mb: 0.25, alignItems: "flex-start", px: 1, py: 0.75 }}
                >
                  <ListItemIcon sx={{ minWidth: 34, mt: 0.25, color: selected ? "primary.main" : "text.secondary" }}>{artifactIcon(artifact.kind)}</ListItemIcon>
                  <ListItemText
                    primary={artifactDisplayLabel(artifact)}
                    secondary={<>{compactPath(artifact.path)}<br />{new Date(artifact.createdAt).toLocaleString()}</>}
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
        <AgentArtifactPreview artifact={selectedArtifact} agentId={agentId} agentTitle={agentTitle} liveContent={liveContent} />
        </Box>
      </Box>
      <ResourceContextMenu state={artifactMenu} onClose={() => setArtifactMenu(undefined)} onOpenInNewTab={onOpenArtifactInNewTab} />
    </Box>
  );
}
