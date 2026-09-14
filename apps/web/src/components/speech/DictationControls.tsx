import MicNoneIcon from "@mui/icons-material/MicNone";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import {
  speechControlGroupSx,
  speechStatusSx,
  visuallyHiddenSpeechStatusSx,
} from "./speechStyles";
import { useDictation } from "./useDictation";

export function DictationControls({
  disabled,
  onFinalTranscript,
  onSettlingChange,
  onActiveChange,
}: {
  disabled: boolean;
  onFinalTranscript(transcript: string): void;
  onSettlingChange(settling: boolean): void;
  onActiveChange?(active: boolean): void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dictation = useDictation(
    onFinalTranscript,
    onSettlingChange,
    rootRef,
  );
  const active = ["starting", "listening", "pausing", "stopping"].includes(
    dictation.status,
  );
  const paused = dictation.status === "paused";
  useEffect(() => {
    onActiveChange?.(active || paused);
  }, [active, paused, onActiveChange]);
  const busy = dictation.status === "pausing" || dictation.status === "stopping";
  const canStopForDisabled =
    dictation.status === "starting" ||
    dictation.status === "listening" ||
    paused;

  useEffect(() => {
    if (disabled && canStopForDisabled) dictation.stop();
  }, [canStopForDisabled, dictation.stop, disabled]);

  const unavailable = dictation.unavailableReason;
  const primaryLabel = unavailable
    ? unavailable
    : dictation.status === "listening" || dictation.status === "starting"
      ? "Pause voice dictation"
      : paused
        ? "Resume voice dictation"
        : "Start voice dictation";
  const statusLabel = dictation.error
    ? dictation.error
    : dictation.status === "starting"
      ? "Starting dictation…"
      : dictation.status === "listening"
        ? "Listening…"
        : dictation.status === "pausing"
          ? "Pausing dictation…"
          : dictation.status === "paused"
            ? "Dictation paused"
            : dictation.status === "stopping"
              ? "Stopping dictation…"
              : dictation.status === "stopped"
                ? "Dictation stopped"
                : undefined;

  return (
    <Box ref={rootRef} sx={speechControlGroupSx}>
      <Tooltip title={primaryLabel}>
        <span>
          <IconButton
            color={dictation.status === "listening" ? "primary" : "inherit"}
            aria-label={primaryLabel}
            aria-pressed={dictation.status === "listening"}
            disabled={disabled || Boolean(unavailable) || busy}
            onClick={() => {
              if (dictation.status === "listening" || dictation.status === "starting") {
                dictation.pause();
              } else if (paused) {
                dictation.resume();
              } else {
                dictation.start();
              }
            }}
          >
            {dictation.status === "listening" || dictation.status === "starting" ? (
              <PauseIcon />
            ) : (
              <MicNoneIcon />
            )}
          </IconButton>
        </span>
      </Tooltip>
      {active || paused ? (
        <Tooltip title="Stop voice dictation">
          <span>
            <IconButton
              aria-label="Stop voice dictation"
              disabled={busy}
              onClick={dictation.stop}
            >
              <StopIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {statusLabel ? (
        <Typography
          aria-live="polite"
          color={dictation.error ? "error" : "text.secondary"}
          role={dictation.error ? "alert" : "status"}
          variant="caption"
          sx={[
            speechStatusSx,
            !dictation.error ? { "@media (max-width: 899.95px)": visuallyHiddenSpeechStatusSx } : {},
          ]}
          title={statusLabel}
        >
          {statusLabel}
        </Typography>
      ) : null}
      {unavailable ? (
        <Box
          component="span"
          sx={visuallyHiddenSpeechStatusSx}
        >
          {unavailable}
        </Box>
      ) : null}
    </Box>
  );
}
