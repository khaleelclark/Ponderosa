import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import { speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechControlGroupSx, visuallyHiddenSpeechStatusSx } from "./speechStyles";
import { speakableMessageText } from "./speechText";
import {
  monitorSpeechSurfaceAccessibility,
  speechSurfaceIsAccessible,
} from "./speechSurfaceAccessibility";

type ReadAloudStatus = "idle" | "speaking" | "paused" | "stopped" | "error";

interface ActiveReadAloud {
  ownerId: string;
  surfaceCleanup?: () => void;
  utterance: SpeechSynthesisUtterance;
  stop(): Error | undefined;
}

let activeReadAloud: ActiveReadAloud | undefined;

export function ReadAloudControls({ text }: { text: string }): JSX.Element {
  const ownerId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance>();
  const visibilityCleanupRef = useRef<() => void>();
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<ReadAloudStatus>("idle");
  const [error, setError] = useState<string>();
  const unavailable = speechSynthesisUnavailableReason();
  const speakableText = speakableMessageText(text);

  const stopVisibilityMonitoring = (owner?: ActiveReadAloud) => {
    const cleanup = owner
      ? owner.surfaceCleanup
      : visibilityCleanupRef.current;
    if (owner) owner.surfaceCleanup = undefined;
    if (visibilityCleanupRef.current === cleanup) {
      visibilityCleanupRef.current = undefined;
    }
    try {
      cleanup?.();
    } catch {
      // Speech ownership must still be released if cleanup rejects.
    }
  };

  const releaseOwner = (owner: ActiveReadAloud) => {
    stopVisibilityMonitoring(owner);
    if (activeReadAloud === owner) activeReadAloud = undefined;
    if (utteranceRef.current === owner.utterance) {
      utteranceRef.current = undefined;
    }
  };

  const stopOwner = (owner: ActiveReadAloud): Error | undefined => {
    if (activeReadAloud !== owner) {
      releaseOwner(owner);
      return undefined;
    }
    releaseOwner(owner);
    let cancelError: Error | undefined;
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      cancelError =
        error instanceof Error
          ? error
          : new Error("Speech cancellation failed.");
    }
    if (mountedRef.current) {
      if (cancelError) {
        setError("The browser could not read this message aloud.");
        setStatus("error");
      } else {
        setError(undefined);
        setStatus("stopped");
      }
    }
    return cancelError;
  };

  const stop = () => {
    const owner = activeReadAloud;
    if (owner?.ownerId === ownerId) stopOwner(owner);
  };

  const start = () => {
    if (unavailable || !speakableText) return;
    setError(undefined);
    let owner: ActiveReadAloud | undefined;
    let speechMayBeQueued = false;
    try {
      if (!speechSurfaceIsAccessible(rootRef.current)) return;
      const utterance = new SpeechSynthesisUtterance(speakableText);
      owner = {
        ownerId,
        utterance,
        stop: () => (owner ? stopOwner(owner) : undefined),
      };
      const exactOwner = owner;
      utterance.lang = navigator.language || "en-US";
      utterance.onstart = () => {
        if (activeReadAloud === exactOwner && mountedRef.current) {
          setStatus("speaking");
        }
      };
      utterance.onend = () => {
        if (activeReadAloud !== exactOwner) return;
        releaseOwner(exactOwner);
        if (mountedRef.current) setStatus("stopped");
      };
      utterance.onerror = event => {
        if (activeReadAloud !== exactOwner) return;
        releaseOwner(exactOwner);
        if (!mountedRef.current) return;
        if (event.error === "canceled" || event.error === "interrupted") {
          setStatus("stopped");
          return;
        }
        setError("The browser could not read this message aloud.");
        setStatus("error");
      };

      const replacementError = activeReadAloud?.stop();
      if (replacementError) throw replacementError;
      utteranceRef.current = utterance;
      activeReadAloud = exactOwner;
      const cleanup = monitorSpeechSurfaceAccessibility(
        () => rootRef.current,
        () => stopOwner(exactOwner),
      );
      exactOwner.surfaceCleanup = cleanup;
      if (activeReadAloud !== exactOwner) {
        stopVisibilityMonitoring(exactOwner);
        return;
      }
      visibilityCleanupRef.current = cleanup;
      speechMayBeQueued = true;
      window.speechSynthesis.speak(utterance);
      if (activeReadAloud === exactOwner) setStatus("speaking");
    } catch {
      const ownsSynthesis = owner !== undefined && activeReadAloud === owner;
      if (owner) releaseOwner(owner);
      if (ownsSynthesis || speechMayBeQueued) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // The failed owner is fenced even if browser cancellation rejects.
        }
      }
      if (!mountedRef.current) return;
      setError("The browser could not read this message aloud.");
      setStatus("error");
    }
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
    return () => {
      mountedRef.current = false;
      stopVisibilityMonitoring();
      const owner = activeReadAloud;
      if (owner?.ownerId === ownerId) stopOwner(owner);
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
    <Box ref={rootRef} component="span" sx={speechControlGroupSx}>
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
