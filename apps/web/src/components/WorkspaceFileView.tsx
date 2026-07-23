import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { FilePreview } from "./filePreview/FilePreview";

export function WorkspaceFileView({ projectId, path }: { projectId: string; path: string }): JSX.Element {
  const query = useQuery({
    queryKey: ["workspace-file-view", projectId, path],
    queryFn: () => api.getWorkspaceFileView(projectId, path),
    retry: false,
  });
  if (query.isLoading) return <Stack sx={{ height: "100%", alignItems: "center", justifyContent: "center" }}><FilePreview title={path} loading hideHeader /></Stack>;
  if (query.isError || !query.data) return <Box sx={{ p: { xs: 2, md: 3 } }}><Alert severity="error" action={<Button color="inherit" onClick={() => void query.refetch()}>Retry</Button>}>This file is missing, outside the Project, or unavailable.</Alert></Box>;
  const file = query.data;
  return <Box className="ponderosa-scroll" sx={{ height: "100%", overflowY: "auto", p: { xs: 1.5, md: 3 } }}>
    <Stack spacing={2} sx={{ width: "100%", maxWidth: 1280, mx: "auto" }}>
      <Box>
        <Typography variant="h5" fontWeight={850} noWrap>{file.name}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{file.path} · {file.size.toLocaleString()} bytes</Typography>
      </Box>
      <FilePreview
        title={file.name}
        path={file.path}
        mediaType={file.mediaType}
        content={file.text}
        previewUrl={file.previewUrl}
        downloadUrl={file.downloadUrl}
        truncated={file.truncated}
        emptyMessage={file.truncated
          ? (file.downloadUrl ? "This text file is too large to display safely. Download it to view the complete file." : "This file is too large to display or download through Ponderosa safely.")
          : undefined}
        maxHeight="calc(100dvh - 220px)"
      />
    </Stack>
  </Box>;
}
