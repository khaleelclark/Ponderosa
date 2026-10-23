import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  CoordinationRequestArtifactDto,
  CoordinationRequestUpdateDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import { queryKeys } from "../queryKeys";
import { useWorkspaceReadOnly } from "./WorkspaceReadOnlyContext";

const UPDATE_PREVIEW_CHARACTERS = 900;

function stateLabel(state: string): string {
  if (state === "outcome_unknown") return "Result unconfirmed";
  return state
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

function updateKindLabel(kind: CoordinationRequestUpdateDto["kind"]): string {
  if (kind === "waiting_dependency") return "Waiting on dependency";
  if (kind === "dependency_resolved") return "Dependency resolved";
  if (kind === "recipient_unavailable") return "Recipient unavailable";
  if (kind === "outcome_unknown") return "Result unconfirmed";
  return stateLabel(kind);
}

function updateActor(
  update: CoordinationRequestUpdateDto,
  agentTitle: (agentId: string | undefined) => string,
): string {
  if (update.actorKind === "agent") return agentTitle(update.actorId);
  if (update.actorKind === "user") return "You";
  if (update.actorKind === "supervisor") return "Supervisor";
  return "System";
}

function textWithoutArtifactPointer(
  text: string | undefined,
  artifacts: CoordinationRequestArtifactDto[],
): string | undefined {
  if (!text || artifacts.length === 0) return text;
  const withoutPointer = text
    .replace(
      /(?:Full (?:question|result):\s*)?ponderosa:\/\/artifact\/[A-Za-z0-9._:-]+/gu,
      "",
    )
    .trim();
  return withoutPointer || undefined;
}

function ResultArtifact({
  artifact,
}: {
  artifact: CoordinationRequestArtifactDto;
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ mt: 1, p: 1.25 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{ alignItems: { xs: "stretch", sm: "center" } }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2">{artifact.title || "Request result"}</Typography>
          <Typography variant="caption" color="text.secondary">
            {artifact.mediaType} · {artifact.byteLength.toLocaleString()} bytes
          </Typography>
        </Box>
        {artifact.previewUrl ? (
          <Button
            component="a"
            href={artifact.previewUrl}
            target="_blank"
            rel="noreferrer"
            size="small"
            aria-label={`Open result ${artifact.title || artifact.id}`}
          >
            Open result
          </Button>
        ) : null}
        {artifact.downloadUrl ? (
          <Button
            component="a"
            href={artifact.downloadUrl}
            size="small"
            aria-label={`Download result ${artifact.title || artifact.id}`}
          >
            Download
          </Button>
        ) : null}
      </Stack>
      {!artifact.previewUrl && !artifact.downloadUrl ? (
        <Alert severity="warning" sx={{ mt: 1 }}>
          This result artifact is no longer available.
        </Alert>
      ) : null}
    </Paper>
  );
}

function RequestUpdate({
  update,
  questionNumber,
  answeredQuestionNumber,
  agentTitle,
  onOpenWork,
}: {
  update: CoordinationRequestUpdateDto;
  questionNumber?: number;
  answeredQuestionNumber?: number;
  agentTitle: (agentId: string | undefined) => string;
  onOpenWork?: (focusId: string) => void;
}): JSX.Element {
  const [showFullText, setShowFullText] = useState(false);
  const text = textWithoutArtifactPointer(update.text, update.artifacts);
  const textIsLong = Boolean(text && text.length > UPDATE_PREVIEW_CHARACTERS);
  const visibleText = textIsLong && !showFullText
    ? `${text!.slice(0, UPDATE_PREVIEW_CHARACTERS).trimEnd()}…`
    : text;
  const unresolvedArtifactRefs = update.refs.filter((ref) =>
    ref.startsWith("ponderosa://artifact/")
    && !update.artifacts.some((artifact) => ref.endsWith(`/${artifact.id}`)));
  const actionLabel = update.kind === "question"
    ? "View full question"
    : ["answer", "completed", "blocked", "failed"].includes(update.kind)
      ? "View full result"
      : "View full update";

  return (
    <Box
      component="li"
      sx={{
        listStyle: "none",
        ml: answeredQuestionNumber ? 2 : 0,
        pl: 1.5,
        py: 1.25,
        borderLeft: 3,
        borderColor: answeredQuestionNumber ? "primary.main" : "divider",
      }}
      aria-label={`${updateKindLabel(update.kind)} update by ${updateActor(update, agentTitle)}`}
    >
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
        <Chip size="small" variant="outlined" label={updateKindLabel(update.kind)} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {updateActor(update, agentTitle)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {new Date(update.createdAt).toLocaleString()}
        </Typography>
      </Stack>
      {questionNumber ? (
        <Typography variant="caption" color="text.secondary">
          Question {questionNumber}
        </Typography>
      ) : null}
      {answeredQuestionNumber ? (
        <Typography variant="caption" color="primary.main" sx={{ display: "block", fontWeight: 700 }}>
          Answer to Question {answeredQuestionNumber}
        </Typography>
      ) : null}
      {visibleText ? (
        <Typography
          variant="body2"
          sx={{ mt: 0.75, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {visibleText}
        </Typography>
      ) : null}
      {update.outcomeCause?.runId && onOpenWork ? (
        <Button size="small" onClick={() => onOpenWork(`run:${update.outcomeCause!.runId}`)}>
          Review Agent activity
        </Button>
      ) : null}
      {update.outcomeCause?.incidentId ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          Related server-start recovery: {update.outcomeCause.incidentId}
        </Typography>
      ) : null}
      {update.textTruncated ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          Update text is bounded in this view.
        </Typography>
      ) : null}
      {textIsLong ? (
        <Button
          size="small"
          sx={{ mt: 0.5 }}
          aria-expanded={showFullText}
          onClick={() => setShowFullText((current) => !current)}
        >
          {showFullText ? "Show bounded preview" : actionLabel}
        </Button>
      ) : null}
      {update.artifacts.map((artifact) => (
        <ResultArtifact key={artifact.id} artifact={artifact} />
      ))}
      {unresolvedArtifactRefs.length > 0 && update.artifacts.length === 0 ? (
        <Alert severity="warning" sx={{ mt: 1 }}>
          The referenced result is unavailable.
        </Alert>
      ) : null}
      {!visibleText && update.artifacts.length === 0 && unresolvedArtifactRefs.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          No additional text was recorded for this update.
        </Typography>
      ) : null}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
        Resulting state: {stateLabel(update.resultingState)}
      </Typography>
    </Box>
  );
}

export function RequestLifecycleCard({
  projectId,
  conversationId,
  requestId,
  state,
  requesterAgentId,
  recipientAgentId,
  requestText,
  hasUpdates = false,
  hasResult = false,
  updatedAt,
  agentTitle,
  defaultExpanded = false,
  onOpenWork,
}: {
  projectId: string;
  conversationId?: string;
  requestId: string;
  state: string;
  requesterAgentId?: string;
  recipientAgentId: string;
  requestText?: string;
  hasUpdates?: boolean;
  hasResult?: boolean;
  updatedAt: string;
  agentTitle: (agentId: string | undefined) => string;
  defaultExpanded?: boolean;
  onOpenWork?: (focusId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  const query = useQuery({
    queryKey: queryKeys.agentWork.detail(
      projectId,
      conversationId,
      `request:${requestId}`,
    ),
    queryFn: () =>
      api.getAgentWorkItemDetails(projectId, "request", requestId, {
        conversationId,
      }),
    enabled: expanded,
    staleTime: 15_000,
  });
  const lifecycle = query.data?.requestLifecycle;
  const readOnly = useWorkspaceReadOnly();
  const queryClient = useQueryClient();
  const [confirmRetry, setConfirmRetry] = useState(false);
  const retry = useMutation({
    mutationFn: async () => {
      if (readOnly || !lifecycle?.request.retryAvailable) throw new Error("This assignment cannot be retried.");
      try {
        const result = await api.retryCoordinationRequest(requestId, { idempotencyKey: `operator-retry:${requestId}` });
        if (result?.retryOfRequestId !== requestId || !result.requestIds?.length) throw new Error("Unconfirmed recovery");
        return result;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status < 500) throw error;
        throw new Error("Could not confirm whether the retry started. Check activity before trying again; repeating work may duplicate changes.");
      }
    },
    onSuccess: () => {
      setConfirmRetry(false);
      // The accepted successor is canonical even if a background refresh fails.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]).catch(() => {});
    },
  });
  const retryAvailable = !readOnly && lifecycle?.request.retryAvailable && !retry.isSuccess;
  const questions = useMemo(
    () =>
      new Map(
        (lifecycle?.updates ?? [])
          .filter((update) => update.kind === "question")
          .map((update, index) => [update.id, index + 1]),
      ),
    [lifecycle?.updates],
  );
  const resolvedRequestText = lifecycle?.request.text ?? requestText;
  const requester = requesterAgentId ? agentTitle(requesterAgentId) : "You";
  const recipient = agentTitle(recipientAgentId);
  const detailsId = `request-lifecycle-${requestId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  return (
    <Accordion
      expanded={expanded}
      onChange={(_, next) => setExpanded(next)}
      disableGutters
      variant="outlined"
      sx={{
        borderRadius: "10px !important",
        "&:before": { display: "none" },
        overflow: "hidden",
      }}
    >
      <AccordionSummary
        aria-controls={detailsId}
        aria-label={`${expanded ? "Collapse" : "Expand"} updates for request from ${requester} to ${recipient}`}
        sx={{ minWidth: 0, "& .MuiAccordionSummary-content": { minWidth: 0 } }}
      >
        <Box sx={{ width: "100%", minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              {requester} → {recipient}
            </Typography>
            <Chip size="small" label={stateLabel(state)} />
          </Stack>
          {requestText ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              “{requestText}”
            </Typography>
          ) : null}
          <Stack direction="row" spacing={1} sx={{ mt: 0.5, alignItems: "center" }}>
            <Typography variant="caption" color="text.secondary">
              {state === "outcome_unknown"
                ? "Result unconfirmed · open to see why"
                : hasResult ? "Result available" : hasUpdates ? "Updates available" : "No updates yet"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
              {new Date(updatedAt).toLocaleString()}
            </Typography>
          </Stack>
        </Box>
      </AccordionSummary>
      <AccordionDetails id={detailsId} sx={{ pt: 0 }}>
        {query.isLoading ? (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", py: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Loading Request updates…</Typography>
          </Stack>
        ) : null}
        {query.isError ? (
          <Alert severity="error">Request updates could not be loaded.</Alert>
        ) : null}
        {lifecycle ? (
          <Stack spacing={1.25}>
            <Box>
              <Typography variant="overline" color="text.secondary">Request</Typography>
              {resolvedRequestText ? (
                <>
                  <Typography
                    variant="body2"
                    sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {resolvedRequestText}
                  </Typography>
                  {lifecycle.request.textTruncated ? (
                    <Typography variant="caption" color="text.secondary">
                      Request text is bounded in this view.
                    </Typography>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No request text was recorded.
                </Typography>
              )}
            </Box>
            {lifecycle.updatesTruncated ? (
              <Alert severity="info">
                Earlier Request updates are omitted from this bounded view.
              </Alert>
            ) : null}
            <Box component="ol" sx={{ p: 0, m: 0 }} aria-label="Request update history">
              {lifecycle.updates.map((update) => (
                <RequestUpdate
                  key={update.id}
                  update={update}
                  questionNumber={questions.get(update.id)}
                  answeredQuestionNumber={
                    update.inReplyToUpdateId
                      ? questions.get(update.inReplyToUpdateId)
                      : undefined
                  }
                  agentTitle={agentTitle}
                  onOpenWork={onOpenWork}
                />
              ))}
            </Box>
            {lifecycle.updates.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                The recipient has not posted an update yet.
              </Typography>
            ) : null}
            {onOpenWork ? (
              <Button
                size="small"
                onClick={() => onOpenWork(`request:${requestId}`)}
                aria-label={`Open Work details for request ${requestId}`}
                sx={{ alignSelf: "flex-start" }}
              >
                Open Work details
              </Button>
            ) : null}
            {expanded && retryAvailable ? <Button size="small" disabled={retry.isPending} sx={{ alignSelf: "flex-start" }} onClick={() => { retry.reset(); setConfirmRetry(true); }}>Retry assignment…</Button> : null}
          </Stack>
        ) : null}
        <Dialog open={confirmRetry} onClose={() => { if (!retry.isPending) setConfirmRetry(false); }} fullWidth maxWidth="xs" aria-labelledby={`retry-assignment-${requestId}`} onClick={event => event.stopPropagation()}>
          <DialogTitle id={`retry-assignment-${requestId}`}>Retry this assignment?</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{resolvedRequestText ?? "Assignment description unavailable."}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>Earlier work or changes may already exist. Retrying starts another attempt and may duplicate changes. Review the activity first.</Typography>
            {retry.isError ? <Alert severity="error" sx={{ mt: 1 }}>{retry.error instanceof Error ? retry.error.message : "The retry could not be started."}</Alert> : null}
          </DialogContent>
          <DialogActions>
            <Button disabled={retry.isPending} onClick={() => setConfirmRetry(false)}>Not now</Button>
            <Button disabled={retry.isPending || !retryAvailable} onClick={() => retry.mutate()}>{retry.isPending ? "Starting…" : "Retry assignment"}</Button>
          </DialogActions>
        </Dialog>
      </AccordionDetails>
    </Accordion>
  );
}
