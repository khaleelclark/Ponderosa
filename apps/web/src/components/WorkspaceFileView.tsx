import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { Alert, Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { FilePreview } from "./filePreview/FilePreview";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";

export function WorkspaceFileView({ projectId, path, onBack }: { projectId: string; path: string; onBack(): void }): JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.workspaceFileView.detail(projectId, path),
    queryFn: () => api.getWorkspaceFileView(projectId, path),
    retry: false,
  });
  const file = query.data;
  const name = file?.name ?? path.split("/").at(-1) ?? path;
  return <Box sx={{ height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, px: { xs: 1, md: 2.5 }, py: 1, borderBottom: 1, borderColor: "divider" }}>
      <Tooltip title="Back to Chats"><IconButton aria-label="Back to Chats" onClick={onBack}><ArrowBackIcon /></IconButton></Tooltip>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="h6" component="h1" fontWeight={850} noWrap>{name}</Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {file ? `${file.path} · ${file.size.toLocaleString()} bytes` : path}
        </Typography>
      </Box>
      <PrimaryHeaderActionsOutlet />
    </Stack>
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", p: { xs: 1.5, md: 3 } }}>
      {query.isLoading ? (
        <Stack sx={{ height: "100%", alignItems: "center", justifyContent: "center" }}><FilePreview title={path} loading hideHeader /></Stack>
      ) : query.isError || !file ? (
        <Alert severity="error" action={<Button color="inherit" onClick={() => void query.refetch()}>Retry</Button>}>This file is missing, outside the Project, or unavailable.</Alert>
      ) : (
        <Box sx={{ width: "100%", maxWidth: 1280, mx: "auto" }}>
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
        </Box>
      )}
    </Box>
  </Box>;
}
