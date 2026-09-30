import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import type { ResponseFileActivityDto } from "@ponderosa/core";
import { presentProjectPath } from "../../projectPathPresentation";

export function ResponseFileActivity({
  files,
  onOpenFile,
  onViewAll,
  viewAllUnavailableReason,
  projectId,
  projectRoot,
}: {
  files: ResponseFileActivityDto[];
  onOpenFile?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  viewAllUnavailableReason?: string;
  projectId?: string;
  projectRoot?: string;
}): JSX.Element | null {
  if (files.length === 0) return null;
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const hasLineTotals = files.some((file) => file.additions !== undefined || file.deletions !== undefined);
  const inProgress = files.some((file) => file.status === "in_progress");
  return <Box component="aside" aria-label="File activity" sx={{ mt: 1 }}>
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "flex-start", minWidth: 0 }}>
      <Paper component="details" variant="outlined" sx={{ flex: 1, minWidth: 0, bgcolor: "action.hover", "& > summary": { cursor: "pointer", listStylePosition: "inside" } }}>
        <Box component="summary" sx={{ px: 1, py: 0.625 }}>
          <Stack component="span" direction="row" spacing={0.75} sx={{ display: "inline-flex", alignItems: "baseline", ml: 0.25 }}>
            <Typography component="span" variant="caption" sx={{ fontWeight: 700 }}>
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </Typography>
            {hasLineTotals ? <>
              <Typography component="span" variant="caption" color="success.main">+{additions}</Typography>
              <Typography component="span" variant="caption" color="error.main">−{deletions}</Typography>
            </> : null}
            {inProgress ? <Typography component="span" variant="caption" color="info.main">Live</Typography> : null}
          </Stack>
        </Box>
        <Stack spacing={0.25} sx={{ px: 0.5, pb: 0.5 }}>
          {files.map((file) => {
            const displayPath = presentProjectPath(projectRoot ?? "", file.path).displayPath;
            const generated = file.artifactKind === "generated_file" && file.artifactId && projectId;
            const root = generated ? `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(file.artifactId!)}` : undefined;
            return <Stack
              key={`${file.sourceSeq}:${file.path}`}
              direction="row"
              sx={{ alignItems: "center", minWidth: 0 }}
            >
              <Button
                size="small"
                color="inherit"
                onClick={() => onOpenFile?.(file)}
                disabled={!onOpenFile}
                aria-label={file.previewable ? `Open focused diff for ${displayPath}` : `Open file artifact for ${displayPath}`}
                sx={{ display: "flex", flex: 1, minWidth: 0, justifyContent: "flex-start", textTransform: "none", minHeight: 30, px: 0.75, py: 0.25, textAlign: "left" }}
              >
                <Typography variant="caption" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayPath}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ ml: 1, flexShrink: 0 }}>
                  {file.kind}{file.additions !== undefined || file.deletions !== undefined ? ` · +${file.additions ?? 0} −${file.deletions ?? 0}` : " · Files & Results"}
                </Typography>
                <OpenInNewIcon sx={{ ml: 0.5, fontSize: 14, flexShrink: 0 }} />
              </Button>
              {root ? <>
                <Button size="small" component="a" href={`${root}/preview`} target="_blank" rel="noreferrer" sx={{ minWidth: 0, px: .75 }}>Preview</Button>
                <Button size="small" component="a" href={`${root}/download`} download sx={{ minWidth: 0, px: .75 }}>Download</Button>
              </> : null}
            </Stack>;
          })}
        </Stack>
      </Paper>
      {onViewAll ? <Button size="small" color="inherit" onClick={onViewAll} sx={{ flexShrink: 0, minWidth: 0, px: 0.75 }}>Review All</Button> : null}
    </Stack>
    {viewAllUnavailableReason ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>{viewAllUnavailableReason}</Typography> : null}
  </Box>;
}
