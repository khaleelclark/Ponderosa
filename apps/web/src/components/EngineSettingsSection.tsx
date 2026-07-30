import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    `${minutes}m`,
  ].filter(Boolean).join(" ");
}

export function EngineSettingsSection({
  onOpenPonderosa,
}: {
  onOpenPonderosa(): void;
}): JSX.Element {
  const [stream, setStream] = useState<"server" | "error">("server");
  const [stopping, setStopping] = useState(false);
  const status = useQuery({
    queryKey: queryKeys.engine.status,
    queryFn: () => api.getEngineStatus(),
    refetchInterval: stopping ? false : 5_000,
  });
  const log = useQuery({
    queryKey: queryKeys.engine.log(stream),
    queryFn: () => api.getEngineLog(stream),
    refetchInterval: stopping ? false : 5_000,
  });
  const stop = useMutation({
    mutationFn: () => api.stopEngine(),
    onSuccess: () => setStopping(true),
  });

  if (status.isLoading) {
    return <CircularProgress aria-label="Loading Ponderosa Engine status" />;
  }
  if (status.isError || !status.data) {
    return (
      <Alert severity="error">
        Ponderosa Engine status could not be loaded. Reopen the installed
        Ponderosa Engine application or inspect its local logs.
      </Alert>
    );
  }

  const engine = status.data;
  const selectedLog = log.data;
  return (
    <Stack spacing={2.5}>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ justifyContent: "space-between", alignItems: { sm: "flex-start" } }}
        >
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
              <Typography variant="h6" fontWeight={800}>
                Ponderosa Engine
              </Typography>
              <Chip
                size="small"
                color={stopping ? "warning" : "success"}
                label={stopping ? "Stopping…" : "Running"}
              />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              The local service that runs Agents and serves the Ponderosa web app.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            <Button
              variant="contained"
              startIcon={<HomeOutlinedIcon />}
              onClick={onOpenPonderosa}
            >
              Open Ponderosa
            </Button>
            <Button
              color="error"
              variant="outlined"
              startIcon={<StopCircleOutlinedIcon />}
              disabled={stopping || stop.isPending}
              onClick={() => {
                if (window.confirm(
                  "Stop Ponderosa Engine? Active work will be asked to shut down safely. Reopen the desktop application to start it again.",
                )) stop.mutate();
              }}
            >
              Stop Engine
            </Button>
          </Stack>
        </Stack>
        <Box
          sx={{
            mt: 2.5,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 2,
          }}
        >
          {[
            ["Version", engine.version],
            ["Channel", engine.channel],
            ["Uptime", formatUptime(engine.uptimeSeconds)],
            ["Process", String(engine.pid)],
            ["Revision", engine.revision.slice(0, 12)],
            ["Work intake", engine.acceptingDurableIntake ? "Ready" : "Paused"],
          ].map(([label, value]) => (
            <Box key={label}>
              <Typography variant="caption" color="text.secondary">
                {label}
              </Typography>
              <Typography variant="body2" fontWeight={700}>
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 2, overflowWrap: "anywhere" }}
        >
          Data: {engine.dataDir}
        </Typography>
        {stop.isError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            Ponderosa Engine could not begin a safe shutdown.
          </Alert>
        ) : null}
        {stopping ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            Shutdown has started. This page will disconnect when the Engine exits.
            Reopen Ponderosa Engine to start it again.
          </Alert>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{ justifyContent: "space-between", alignItems: { sm: "center" }, mb: 1.5 }}
        >
          <Box>
            <Typography variant="h6" fontWeight={800}>
              Live logs
            </Typography>
            <Typography variant="body2" color="text.secondary">
              A bounded tail updates every five seconds; older log content stays on disk.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              startIcon={<RefreshOutlinedIcon />}
              onClick={() => void log.refetch()}
            >
              Refresh
            </Button>
            <Button
              size="small"
              startIcon={<ContentCopyOutlinedIcon />}
              disabled={!selectedLog?.text}
              onClick={() => void navigator.clipboard.writeText(selectedLog?.text ?? "")}
            >
              Copy
            </Button>
          </Stack>
        </Stack>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={stream}
          onChange={(_, value: "server" | "error" | null) => {
            if (value) setStream(value);
          }}
          sx={{ mb: 1.5 }}
        >
          <ToggleButton value="server">Server</ToggleButton>
          <ToggleButton value="error">Errors</ToggleButton>
        </ToggleButtonGroup>
        {log.isError ? (
          <Alert severity="warning">
            This log could not be read. The Engine is still running.
          </Alert>
        ) : (
          <>
            <Box
              component="pre"
              aria-label={`${stream} log`}
              sx={{
                m: 0,
                p: 1.5,
                minHeight: 240,
                maxHeight: 440,
                overflow: "auto",
                borderRadius: 1,
                bgcolor: "rgba(0, 0, 0, 0.22)",
                color: "text.primary",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {selectedLog?.text || "No log output yet."}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              {selectedLog
                ? `${formatBytes(selectedLog.totalBytes)} on disk${
                    selectedLog.truncated ? " · showing the latest 64 KiB" : ""
                  }`
                : "Loading log…"}
            </Typography>
          </>
        )}
      </Paper>
    </Stack>
  );
}
