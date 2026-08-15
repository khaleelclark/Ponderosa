import UploadFileIcon from "@mui/icons-material/UploadFile";
import type { BrowserControlOwner, BrowserPendingFileChooserDto } from "@ponderosa/core";
import { Alert, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";

function displayOrigin(pageUrl?: string): string {
  if (!pageUrl) return "the current page";
  try {
    return new URL(pageUrl).origin;
  } catch {
    return "the current page";
  }
}

export function BrowserArtifactUpload({
  projectId,
  disabled,
  pending,
  chooser,
  controlOwner,
  pageUrl,
  onUpload,
  onCancel,
}: {
  projectId: string;
  disabled?: boolean;
  pending?: boolean;
  chooser?: BrowserPendingFileChooserDto;
  controlOwner: BrowserControlOwner;
  pageUrl?: string;
  onUpload(artifactId: string, selector?: string): void;
  onCancel(): void;
}): JSX.Element {
  const operator = controlOwner === "operator";
  const artifacts = useQuery({
    queryKey: ["browser-upload-artifacts", projectId],
    queryFn: () => api.listProjectArtifacts(projectId, 100),
    enabled: Boolean(projectId) && operator,
    staleTime: 5_000,
  });
  const choices = (artifacts.data?.items ?? []).filter((artifact) =>
    Boolean(artifact.size && artifact.sha256 && artifact.mediaType && artifact.downloadUrl),
  );
  const [artifactId, setArtifactId] = useState("");
  const [selector, setSelector] = useState("");

  useEffect(() => {
    if (artifactId && !choices.some((artifact) => artifact.id === artifactId)) setArtifactId("");
  }, [artifactId, choices]);

  return (
    <Stack spacing={1}>
      {chooser ? (
        <Alert
          severity="info"
          action={operator ? (
            <Button
              color="inherit"
              size="small"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : undefined}
        >
          <Typography variant="body2" component="span">
            {displayOrigin(pageUrl)} is requesting {chooser.mode === "selectMultiple" ? "one or more files" : "a file"}.
            {operator ? " Choose a managed Project artifact below." : " Take control to choose or cancel it."}
          </Typography>
        </Alert>
      ) : null}
      {operator ? (
        <Stack direction={{ xs: "column", md: "row" }} spacing={1} sx={{ alignItems: { md: "center" } }}>
          <TextField
            select
            size="small"
            label="Project artifact"
            value={artifactId}
            onChange={(event) => setArtifactId(event.target.value)}
            disabled={disabled || artifacts.isPending || choices.length === 0}
            sx={{ minWidth: { md: 240 }, flex: 1 }}
          >
            {choices.map((artifact) => (
              <MenuItem key={artifact.id} value={artifact.id}>
                {artifact.summary || artifact.path.split("/").at(-1) || artifact.id}
              </MenuItem>
            ))}
          </TextField>
          {!chooser ? (
            <TextField
              size="small"
              label="File input selector (optional)"
              placeholder='input[type="file"]'
              value={selector}
              onChange={(event) => setSelector(event.target.value)}
              disabled={disabled}
              sx={{ minWidth: { md: 220 }, flex: 1 }}
            />
          ) : null}
          <Button
            variant="outlined"
            startIcon={<UploadFileIcon />}
            disabled={disabled || pending || !artifactId}
            onClick={() => onUpload(artifactId, chooser ? undefined : selector.trim() || undefined)}
          >
            {chooser ? "Choose file" : "Upload"}
          </Button>
          {!artifacts.isPending && choices.length === 0 ? (
            <Typography variant="caption" color="text.secondary">No managed Project artifacts are available.</Typography>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
