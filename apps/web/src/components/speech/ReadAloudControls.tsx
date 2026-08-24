import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import { speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechControlGroupSx, visuallyHiddenSpeechStatusSx } from "./speechStyles";
import { speakableMessageText } from "./speechText";

type ReadAloudStatus = "idle" | "speaking" | "paused" | "stopped" | "error";

interface ActiveReadAloud {
  ownerId: string;
  stop(): void;
}

let activeReadAloud: ActiveReadAloud | undefined;

export function ReadAloudControls({ text }: { text: string }): JSX.Element {
  const ownerId = useId();
  const utteranceRef = useRef<SpeechSynthesisUtterance>();
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<ReadAloudStatus>("idle");
  const [error, setError] = useState<string>();
  const unavailable = speechSynthesisUnavailableReason();
  const speakableText = speakableMessageText(text);

  const stop = () => {
    if (activeReadAloud?.ownerId !== ownerId) return;
    window.speechSynthesis.cancel();
    activeReadAloud = undefined;
    utteranceRef.current = undefined;
    if (mountedRef.current) {
      setError(undefined);
      setStatus("stopped");
    }
  };

  const start = () => {
    if (unavailable || !speakableText) return;
    activeReadAloud?.stop();
    setError(undefined);
    const utterance = new SpeechSynthesisUtterance(speakableText);
    utterance.lang = navigator.language || "en-US";
    utterance.onstart = () => {
      if (mountedRef.current) setStatus("speaking");
    };
    utterance.onend = () => {
      if (activeReadAloud?.ownerId === ownerId) activeReadAloud = undefined;
      utteranceRef.current = undefined;
      if (mountedRef.current) setStatus("stopped");
    };
    utterance.onerror = event => {
      if (activeReadAloud?.ownerId === ownerId) activeReadAloud = undefined;
      utteranceRef.current = undefined;
      if (!mountedRef.current) return;
      if (event.error === "canceled" || event.error === "interrupted") {
        setStatus("stopped");
        return;
      }
      setError("The browser could not read this message aloud.");
      setStatus("error");
    };
    utteranceRef.current = utterance;
    activeReadAloud = { ownerId, stop };
    window.speechSynthesis.speak(utterance);
    setStatus("speaking");
  };

  const toggle = () => {
    if (status === "speaking" && activeReadAloud?.ownerId === ownerId) {
      window.speechSynthesis.pause();
      setStatus("paused");
      return;
    }
    if (status === "paused" && activeReadAloud?.ownerId === ownerId) {
      window.speechSynthesis.resume();
      setStatus("speaking");
      return;
    }
    start();
  };

  useEffect(() => {
    mountedRef.current = true;
    const endForNavigation = () => stop();
    window.addEventListener("pagehide", endForNavigation);
    return () => {
      window.removeEventListener("pagehide", endForNavigation);
      mountedRef.current = false;
      if (activeReadAloud?.ownerId === ownerId) {
        window.speechSynthesis.cancel();
        activeReadAloud = undefined;
      }
      utteranceRef.current = undefined;
    };
  }, [ownerId]);

  const label = unavailable
    ? unavailable
    : status === "speaking"
      ? "Pause read aloud"
      : status === "paused"
        ? "Resume read aloud"
        : "Read message aloud";
  const liveStatus = error
    ? error
    : status === "speaking"
      ? "Reading message aloud"
      : status === "paused"
        ? "Read aloud paused"
        : status === "stopped"
          ? "Read aloud stopped"
          : "";

  return (
    <Box component="span" sx={speechControlGroupSx}>
      <Tooltip title={label}>
        <span>
          <IconButton
            size="small"
            color={status === "speaking" ? "primary" : error ? "error" : "inherit"}
            aria-label={label}
            aria-pressed={status === "speaking"}
            disabled={Boolean(unavailable) || !speakableText}
            onClick={event => {
              event.stopPropagation();
              toggle();
            }}
          >
            {status === "speaking" ? (
              <PauseIcon fontSize="inherit" />
            ) : status === "paused" ? (
              <PlayArrowIcon fontSize="inherit" />
            ) : (
              <VolumeUpIcon fontSize="inherit" />
            )}
          </IconButton>
        </span>
      </Tooltip>
      {status === "speaking" || status === "paused" ? (
        <Tooltip title="Stop read aloud">
          <IconButton
            size="small"
            aria-label="Stop read aloud"
            onClick={event => {
              event.stopPropagation();
              stop();
            }}
          >
            <StopIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      ) : null}
      <Box
        component="span"
        aria-live="polite"
        role={error ? "alert" : "status"}
        sx={visuallyHiddenSpeechStatusSx}
      >
        {liveStatus}
      </Box>
    </Box>
  );
}
