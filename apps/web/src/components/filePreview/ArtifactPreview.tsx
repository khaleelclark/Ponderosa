import { Alert, Box, Chip, Stack } from "@mui/material";
import type { AgentDto, ArtifactContentDto, ArtifactDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";
import { FilePreview } from "./FilePreview";
import { createdFileUnifiedDiff, recordedArtifactDiff } from "./artifactDiff";
import { previewCapability } from "./mimeCapabilities";
import { presentProjectPath } from "../../projectPathPresentation";
import { artifactDisplayLabel, artifactDisplayPath } from "./artifactPresentation";

function ArtifactProvenance({
  artifact,
  agentTitle,
}: {
  artifact: ArtifactDto;
  agentTitle: string;
}): JSX.Element {
  return <Stack direction="row" spacing={.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 1 }}>
    <Chip size="small" label={`Created by ${agentTitle}`} />
    <Chip size="small" variant="outlined" label={artifact.visibility === "published" ? "Published" : "Project scope"} />
  </Stack>;
}

export function AgentArtifactPreview({
  artifact,
  agentId,
  agentTitle,
  projectRoot,
}: {
  artifact?: ArtifactDto;
  agentId: string;
  agentTitle: string;
  projectRoot?: string;
}): JSX.Element {
  const contentQuery = useQuery({
    queryKey: queryKeys.projectArtifacts.agentContent(agentId, artifact?.id),
    queryFn: () => api.getArtifact(agentId, artifact!.id),
    enabled: Boolean(artifact
      && !["image", "pdf"].includes(previewCapability({
        mediaType: artifact.mediaType,
        path: artifact.sourcePath ?? artifact.path,
        artifactKind: artifact.kind,
      }).kind)),
  });
  if (!artifact) return <Box sx={{ p: 2 }}><Alert severity="info">Select a file or result to inspect its contents.</Alert></Box>;
  const content: ArtifactContentDto | undefined = contentQuery.data;
  const safeArtifactPath = artifactDisplayPath(artifact, projectRoot);
  const previewContent = artifact.kind === "diff" && content
    ? recordedArtifactDiff(artifact, content.content, safeArtifactPath)
    : content?.content;
  return <Box sx={{ p: 1.5, minWidth: 0 }}>
    <ArtifactProvenance artifact={artifact} agentTitle={agentTitle} />
    <FilePreview
      title={artifactDisplayLabel(artifact, safeArtifactPath)}
      path={safeArtifactPath}
      mediaType={artifact.mediaType}
      artifactKind={artifact.kind}
      contentType={content?.contentType}
      content={previewContent}
      previewUrl={artifact.previewUrl}
      downloadUrl={content?.downloadUrl ?? artifact.downloadUrl}
      loading={contentQuery.isLoading}
      error={contentQuery.isError}
      truncated={content?.truncated}
      totalBytes={content?.totalBytes}
      emptyMessage="Artifact content is not available yet."
    />
  </Box>;
}

export function ProjectArtifactPreview({
  artifact,
  projectRoot,
  agent,
}: {
  artifact: ArtifactDto;
  projectRoot: string;
  agent?: AgentDto;
}): JSX.Element {
  const sourcePath = artifact.sourcePath ?? artifact.path;
  const presentedPath = presentProjectPath(projectRoot, sourcePath);
  const capability = previewCapability({
    mediaType: artifact.mediaType,
    path: artifact.sourcePath ?? artifact.path,
    artifactKind: artifact.kind,
  });
  const recorded = useQuery({
    queryKey: queryKeys.projectArtifacts.recorded(artifact.id, agent?.id),
    queryFn: () => api.getArtifact(agent!.id, artifact.id),
    enabled: Boolean(agent && artifact.kind === "diff"),
  });
  const text = useQuery({
    queryKey: queryKeys.projectArtifacts.textPreview(
      artifact.id,
      artifact.previewUrl,
    ),
    queryFn: async ({ signal }) => {
      const response = await fetch(artifact.previewUrl!, { cache: "no-store", credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
      return response.text();
    },
    enabled: Boolean(artifact.previewUrl && artifact.kind !== "diff" && ["text", "markdown", "diff"].includes(capability.kind)),
  });
  let content = artifact.kind === "diff" && recorded.data
    ? recordedArtifactDiff(artifact, recorded.data.content, presentedPath.displayPath)
    : text.data;
  let contentType = artifact.kind === "diff" ? "diff" as const : capability.kind === "markdown" ? "markdown" as const : "text" as const;
  let informational: string | undefined;
  if (artifact.kind === "diff" && !agent) informational = "The originating Agent was deleted, so this durable diff cannot be retrieved from its bounded artifact route.";
  else if (artifact.kind === "diff" && recorded.data && !content) informational = "This canonical file-change record does not contain a line-oriented diff. Ponderosa will not substitute current working-tree content.";
  else if (text.data !== undefined) {
    content = createdFileUnifiedDiff(presentedPath.displayPath, text.data);
    contentType = "diff";
  }
  if (informational) return <Alert severity="info">{informational}</Alert>;
  const displayLabel = artifactDisplayLabel(artifact, presentedPath.displayPath);
  const createdDiffLabel = text.data !== undefined && contentType === "diff" ? `Created-file diff for ${displayLabel}` : undefined;
  return <Box
    aria-label={createdDiffLabel}
    data-testid={artifact.kind === "diff" ? "project-recorded-diff" : undefined}
  >
    <FilePreview
      title={displayLabel}
      path={presentedPath.displayPath}
      mediaType={artifact.mediaType}
      artifactKind={artifact.kind}
      contentType={contentType}
      content={content}
      previewUrl={artifact.previewUrl}
      downloadUrl={artifact.downloadUrl}
      loading={recorded.isLoading || text.isLoading}
      error={recorded.isError || text.isError}
      emptyMessage="This file has no safe inline preview. Download it or open its originating Agent record when available."
    />
  </Box>;
}
