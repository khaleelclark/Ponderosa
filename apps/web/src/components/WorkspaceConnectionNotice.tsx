import { Alert, Box } from "@mui/material";
import type { WorkspaceConnectionState } from "../hooks/useWorkspaceStream";

export function WorkspaceConnectionNotice({
  connection,
}: {
  connection: WorkspaceConnectionState;
}): JSX.Element {
  const lastSync = connection.lastSuccessfulSyncAt
    ? new Date(connection.lastSuccessfulSyncAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : undefined;
  const message = connection.status === "connecting"
    ? "Connecting live workspace updates…"
    : connection.status === "reconnecting"
      ? `Reconnecting live workspace updates${lastSync ? ` · Last synced ${lastSync}` : ""}…`
      : connection.status === "stale"
        ? `Live workspace updates are stale${lastSync ? ` · Last synced ${lastSync}` : ""}. Displayed data may be out of date.`
        : connection.status === "unavailable"
          ? "Live workspace updates are unavailable. Displayed data may be out of date."
          : undefined;

  return (
    <>
      {message ? (
        <Alert
          severity={connection.prolongedDisconnect ? "warning" : "info"}
          variant="outlined"
          sx={{
            borderRadius: 0,
            borderInline: 0,
            py: 0,
            "& .MuiAlert-message": { py: 0.5 },
          }}
        >
          {message}
        </Alert>
      ) : null}
      <Box
        aria-live="polite"
        sx={{
          position: "absolute",
          width: 1,
          height: 1,
          p: 0,
          m: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {connection.announcement}
      </Box>
    </>
  );
}
