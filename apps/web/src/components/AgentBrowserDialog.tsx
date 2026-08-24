import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import {
  Alert,
  Box,
  Button,
  Chip,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { BrowserSessionDto } from "@ponderosa/core";
import { useMemo, useState } from "react";
import { BrowserViewport } from "./browser/BrowserViewport";
import { BrowserPageStrip } from "./browser/BrowserPageStrip";
import { BrowserArtifactUpload } from "./browser/BrowserArtifactUpload";
import { agentBrowserAdapter } from "./browser/browserAdapters";
import { useBrowserController } from "./browser/useBrowserController";
import { FeatureErrorBoundary } from "./FeatureErrorBoundary";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";

export function AgentBrowserDialog({
  projectId,
  agentId,
  runId,
  agentTitle,
  backLabel = "Back to Agent",
  onClose,
}: {
  projectId: string;
  agentId: string;
  runId: string;
  agentTitle: string;
  backLabel?: string;
  onClose(): void;
}): JSX.Element {
  const adapter = useMemo(
    () => agentBrowserAdapter(projectId, agentId, runId),
    [agentId, projectId, runId],
  );
  const browser = useBrowserController<BrowserSessionDto>({ adapter, enabled: true });
  const [typeText, setTypeText] = useState("");
  const session = browser.session;
  const operator = session?.status === "ready" && session.controlOwner === "operator";

  const submitText = () => {
    if (!typeText) return;
    browser.sendInput({ kind: "type", text: typeText });
    setTypeText("");
  };
  const unavailable = browser.missing || session?.status === "closed" || session?.status === "failed";
  const queryError = browser.queryError instanceof Error
    ? browser.queryError.message
    : browser.queryError
      ? String(browser.queryError)
      : undefined;

  return (
    <Box
      aria-labelledby="agent-browser-title"
      sx={{
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        overflow: "hidden",
      }}
    >
      <FeatureErrorBoundary feature={`${agentTitle} browser`}>
        <DialogTitle id="agent-browser-title">
          <Stack spacing={0.25}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
              <Tooltip title={backLabel}>
                <IconButton aria-label={backLabel} onClick={onClose}>
                  <ArrowBackIcon />
                </IconButton>
              </Tooltip>
              <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {agentTitle}&apos;s Browser
              </Typography>
              <PrimaryHeaderActionsOutlet />
              {session?.status === "ready" ? (
                <Chip
                  size="small"
                  variant="outlined"
                  color={operator ? "success" : "info"}
                  label={operator ? "You have control" : `${agentTitle} has control`}
                />
              ) : null}
              {session ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={session.profileMode === "trusted"
                    ? `Trusted · ${session.profileName ?? "Profile"}`
                    : "Disposable"}
                />
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ pl: 6 }}>
              {session?.status === "opening"
                ? session.queuePosition
                  ? `Waiting for browser capacity · queue position ${session.queuePosition}`
                  : "Starting hosted browser"
                : session?.title || session?.url || "Live browser for this Agent Run"}
            </Typography>
          </Stack>
        </DialogTitle>
        <DialogContent
          dividers
          sx={{
            p: { xs: 1, sm: 2 },
            display: "grid",
            gridTemplateRows: "minmax(0, 1fr) auto",
            gap: 1,
            minHeight: 0,
          }}
        >
          <Box sx={{ display: "grid", gap: 1, minHeight: 0 }}>
            <BrowserPageStrip
              pages={session?.pages ?? []}
              activePageId={session?.activePageId}
              canManage={operator}
              busy={browser.activatePage.isPending || browser.closePage.isPending}
              onActivate={(pageId) => browser.activatePage.mutate(pageId)}
              onClose={(pageId) => browser.closePage.mutate(pageId)}
            />
          <BrowserViewport
            adapter={adapter}
            session={session}
            active
            operatorControl={operator}
            sendInput={browser.sendInput}
            refreshFrame={browser.refreshFrame}
            accent="info.main"
            empty={queryError ? (
              <Alert severity="error">This Agent browser could not be loaded. {queryError}</Alert>
            ) : session?.status === "opening" ? (
              <Alert severity="info">
                {session.queueReason === "profile_in_use"
                  ? "This trusted profile is in use. The Agent will continue automatically when its FIFO lease is available."
                  : "This browser is queued for host capacity and will open automatically."}
              </Alert>
            ) : unavailable ? (
              <Alert severity="info">This Agent browser is no longer available.</Alert>
            ) : undefined}
          />
          </Box>
          {session?.status === "ready" ? operator ? (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                size="small"
                fullWidth
                label="Type into focused page control"
                value={typeText}
                onChange={(event) => setTypeText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitText();
                  }
                }}
              />
              <Button variant="outlined" disabled={!typeText || browser.input.isPending} onClick={submitText}>
                Type
              </Button>
              <Button
                color="info"
                variant="outlined"
                disabled={browser.control.isPending}
                onClick={() => browser.control.mutate({ owner: "agent" })}
              >
                Return control to {agentTitle}
              </Button>
            </Stack>
          ) : (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" sx={{ flex: 1 }}>
                You are viewing {agentTitle}&apos;s live browser.
              </Typography>
              <Button
                variant="contained"
                disabled={browser.control.isPending}
                onClick={() => browser.control.mutate({ owner: "operator" })}
              >
                Take Control
              </Button>
            </Stack>
          ) : null}
          {session?.capabilities.fileUpload && (operator || session.pendingFileChooser) ? (
            <BrowserArtifactUpload
              projectId={projectId}
              disabled={browser.upload.isPending || browser.cancelFileChooser.isPending}
              pending={browser.upload.isPending || browser.cancelFileChooser.isPending}
              chooser={session?.pendingFileChooser}
              controlOwner={session?.controlOwner ?? "agent"}
              pageUrl={session?.url}
              onUpload={(artifactId, selector) => browser.upload.mutate({ artifactId, selector })}
              onCancel={() => browser.cancelFileChooser.mutate()}
            />
          ) : null}
          {browser.error ? (
            <Alert severity="error">
              {browser.error instanceof Error ? browser.error.message : String(browser.error)}
            </Alert>
          ) : null}
        </DialogContent>
      </FeatureErrorBoundary>
    </Box>
  );
}
