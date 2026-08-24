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

function speechSurfaceIsVisible(element: HTMLElement | null): boolean {
  if (
    !element ||
    !element.isConnected ||
    document.visibilityState !== "visible" ||
    element.getClientRects().length === 0
  ) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

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

  const stopVisibilityMonitoring = () => {
    visibilityCleanupRef.current?.();
    visibilityCleanupRef.current = undefined;
  };

  const stop = () => {
    if (activeReadAloud?.ownerId !== ownerId) return;
    stopVisibilityMonitoring();
    window.speechSynthesis.cancel();
    activeReadAloud = undefined;
    utteranceRef.current = undefined;
    if (mountedRef.current) {
      setError(undefined);
      setStatus("stopped");
    }
  };

  const beginVisibilityMonitoring = () => {
    stopVisibilityMonitoring();
    let frame: number | undefined;
    const stopIfInactive = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (
          activeReadAloud?.ownerId === ownerId &&
          !speechSurfaceIsVisible(rootRef.current)
        ) {
          stop();
        }
      });
    };
    const observer = new MutationObserver(stopIfInactive);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      subtree: true,
    });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(stopIfInactive);
    if (rootRef.current) resizeObserver?.observe(rootRef.current);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") stop();
      else stopIfInactive();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("hashchange", stopIfInactive);
    window.addEventListener("pagehide", stop);
    window.addEventListener("popstate", stopIfInactive);
    visibilityCleanupRef.current = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("hashchange", stopIfInactive);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("popstate", stopIfInactive);
    };
    stopIfInactive();
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
      stopVisibilityMonitoring();
      utteranceRef.current = undefined;
      if (mountedRef.current) setStatus("stopped");
    };
    utterance.onerror = event => {
      if (activeReadAloud?.ownerId === ownerId) activeReadAloud = undefined;
      stopVisibilityMonitoring();
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
    beginVisibilityMonitoring();
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
    return () => {
      mountedRef.current = false;
      stopVisibilityMonitoring();
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
