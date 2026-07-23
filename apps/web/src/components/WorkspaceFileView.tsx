import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ChatMessageBody } from "./panes";

export function WorkspaceFileView({ projectId, path }: { projectId: string; path: string }): JSX.Element {
  const query = useQuery({
    queryKey: ["workspace-file-view", projectId, path],
    queryFn: () => api.getWorkspaceFileView(projectId, path),
    retry: false,
  });
  if (query.isLoading) return <Stack sx={{ height: "100%", alignItems: "center", justifyContent: "center" }}><CircularProgress size={28} /></Stack>;
  if (query.isError || !query.data) return <Box sx={{ p: { xs: 2, md: 3 } }}><Alert severity="error" action={<Button color="inherit" onClick={() => void query.refetch()}>Retry</Button>}>This file is missing, outside the Project, or unavailable.</Alert></Box>;
  const file = query.data;
  const markdown = /(?:markdown|mdown)$/iu.test(file.mediaType) || /\.md(?:own)?$/iu.test(file.name);
  return <Box className="ponderosa-scroll" sx={{ height: "100%", overflowY: "auto", p: { xs: 1.5, md: 3 } }}>
    <Stack spacing={2} sx={{ width: "100%", maxWidth: 1280, mx: "auto" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="h5" fontWeight={850} noWrap>{file.name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{file.path} · {file.size.toLocaleString()} bytes</Typography>
        </Box>
        {file.downloadUrl ? <Button component="a" href={file.downloadUrl} startIcon={<DownloadOutlinedIcon />} variant="outlined">Download</Button> : null}
      </Stack>
      {file.text !== undefined ? <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2.5 }, overflow: "hidden" }}>
        {markdown ? <ChatMessageBody text={file.text} collapseLongMessage={false} projectId={projectId} /> : <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 13 }}>{file.text}</Box>}
      </Paper> : file.previewUrl && file.mediaType.startsWith("image/") ? <Paper variant="outlined" sx={{ p: 1.5, display: "grid", placeItems: "center" }}><Box component="img" src={file.previewUrl} alt={file.name} sx={{ maxWidth: "100%", maxHeight: "calc(100dvh - 220px)", objectFit: "contain" }} /></Paper>
        : file.previewUrl ? <Box component="iframe" title={file.name} src={file.previewUrl} sx={{ width: "100%", minHeight: "70dvh", border: 1, borderColor: "divider", borderRadius: 2, bgcolor: "background.paper" }} />
          : <Alert severity="info">{file.truncated ? (file.downloadUrl ? "This text file is too large to display safely. Download it to view the complete file." : "This file is too large to display or download through Ponderosa safely.") : "This file type cannot be displayed safely in Ponderosa. Download it to open it with a compatible application."}</Alert>}
    </Stack>
  </Box>;
}
