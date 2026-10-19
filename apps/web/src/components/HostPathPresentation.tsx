import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { copyText } from "../clipboard";
import { useMutationNotification } from "./MutationNotifications";

export function compactHostPath(path: string): string {
  return path
    .replace(/^\/home\/[^/]+(?=\/|$)/u, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/u, "~")
    .replace(/^[a-z]:\\Users\\[^\\]+(?=\\|$)/iu, "~");
}

function pathParts(path: string): { prefix: string; final: string } {
  const compact = compactHostPath(path);
  const separator = compact.includes("\\") ? "\\" : "/";
  const index = compact.lastIndexOf(separator);
  if (index <= 0) return { prefix: "", final: compact };
  return {
    prefix: compact.slice(0, index + 1),
    final: compact.slice(index + 1),
  };
}

export function HostPathPresentation({
  path,
  label = "Host path",
  copyable = true,
}: {
  path: string;
  label?: string;
  copyable?: boolean;
}): JSX.Element {
  const notify = useMutationNotification();
  const parts = pathParts(path);
  return (
    <Box sx={{ display: "flex", alignItems: "center", minWidth: 0, maxWidth: "100%" }}>
      <Tooltip title={`${label}: ${path}`} arrow>
        <Box
          component="span"
          tabIndex={0}
          aria-label={`${label}: ${path}`}
          sx={{ display: "flex", minWidth: 0, maxWidth: "100%", outlineOffset: 2 }}
        >
          {parts.prefix ? (
            <Typography
              component="span"
              variant="body2"
              color="text.secondary"
              noWrap
              sx={{ minWidth: 16, overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {parts.prefix}
            </Typography>
          ) : null}
          <Typography component="span" variant="body2" color="text.secondary" noWrap>
            {parts.final}
          </Typography>
        </Box>
      </Tooltip>
      {copyable ? (
        <Tooltip title={`Copy ${label.toLocaleLowerCase()}`}>
          <IconButton
            size="small"
            aria-label={`Copy ${label.toLocaleLowerCase()}`}
            onClick={() => {
              void copyText(path).then(
                () => notify({ key: `copy-path:${path}`, message: `${label} copied.` }),
                () => notify({
                  key: `copy-path-error:${path}`,
                  message: `${label} could not be copied.`,
                  severity: "error",
                  persistent: true,
                }),
              );
            }}
          >
            <ContentCopyOutlinedIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      ) : null}
    </Box>
  );
}
