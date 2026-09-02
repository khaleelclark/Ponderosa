import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  dictationErrorMessage,
  dictationUnavailableReason,
  speechRecognitionConstructor,
  type BrowserSpeechRecognition,
  type DictationStatus,
} from "./browserSpeech";
import {
  monitorSpeechSurfaceAccessibility,
  speechSurfaceIsAccessible,
} from "./speechSurfaceAccessibility";

type RequestedEnd = "pause" | "stop";
const DICTATION_SETTLE_TIMEOUT_MS = 3_000;

export interface DictationController {
  error?: string;
  status: DictationStatus;
  unavailableReason?: string;
  pause(): void;
  resume(): void;
  start(): void;
  stop(): void;
}

export function useDictation(
  onFinalTranscript: (transcript: string) => void,
  onSettlingChange: (settling: boolean) => void,
  surfaceRef: RefObject<HTMLElement | null>,
): DictationController {
  const unavailableReason = dictationUnavailableReason();
  const [status, setStatus] = useState<DictationStatus>("ready");
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<BrowserSpeechRecognition>();
  const generationRef = useRef(0);
  const settlingRef = useRef(false);
  const settleTimerRef = useRef<number>();
  const surfaceCleanupRef = useRef<() => void>();
  const requestedEndRef = useRef<RequestedEnd>();
  const errorRef = useRef(false);
  const mountedRef = useRef(true);
  const transcriptHandlerRef = useRef(onFinalTranscript);
  const settlingHandlerRef = useRef(onSettlingChange);
  transcriptHandlerRef.current = onFinalTranscript;
  settlingHandlerRef.current = onSettlingChange;

  const updateSettling = useCallback((next: boolean) => {
    if (settlingRef.current === next) return;
    settlingRef.current = next;
    settlingHandlerRef.current(next);
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== undefined) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
    }
  }, []);

  const stopSurfaceMonitoring = useCallback(() => {
    surfaceCleanupRef.current?.();
    surfaceCleanupRef.current = undefined;
  }, []);

  const releaseRecognition = useCallback(
    (recognition: BrowserSpeechRecognition) => {
      try {
        recognition.onstart = null;
      } catch {
        // Continue fencing even if a browser implementation rejects cleanup.
      }
      try {
        recognition.onresult = null;
      } catch {
        // Continue fencing even if a browser implementation rejects cleanup.
      }
      try {
        recognition.onerror = null;
      } catch {
        // Continue fencing even if a browser implementation rejects cleanup.
      }
      try {
        recognition.onend = null;
      } catch {
        // Continue fencing even if a browser implementation rejects cleanup.
      }
      if (recognitionRef.current === recognition) {
        recognitionRef.current = undefined;
        stopSurfaceMonitoring();
      }
    },
    [stopSurfaceMonitoring],
  );

  const abandonGeneration = useCallback(
    (
      recognition: BrowserSpeechRecognition | undefined,
      generation: number,
      message: string,
      warnAboutPendingSpeech = true,
    ) => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      clearSettleTimer();
      stopSurfaceMonitoring();
      if (recognition) releaseRecognition(recognition);
      requestedEndRef.current = undefined;
      errorRef.current = true;
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          // The generation is already fenced and every callback detached.
        }
      }
      updateSettling(false);
      if (!mountedRef.current) return;
      setError(
        warnAboutPendingSpeech
          ? `${message} Pending speech may not have been added; review the draft before sending.`
          : message,
      );
      setStatus("error");
    },
    [
      clearSettleTimer,
      releaseRecognition,
      stopSurfaceMonitoring,
      updateSettling,
    ],
  );

  const abandonForSurfaceLoss = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    abandonGeneration(
      recognition,
      generationRef.current,
      "Voice dictation stopped because this message composer became inaccessible.",
    );
  }, [abandonGeneration]);

  const scheduleSettleTimeout = useCallback(
    (recognition: BrowserSpeechRecognition, generation: number) => {
      clearSettleTimer();
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = undefined;
        abandonGeneration(
          recognition,
          generation,
          "Voice dictation did not finish in time.",
        );
      }, DICTATION_SETTLE_TIMEOUT_MS);
    },
    [abandonGeneration, clearSettleTimer],
  );

  const begin = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition || unavailableReason) return;
    if (!speechSurfaceIsAccessible(surfaceRef.current)) {
      setError(
        "Voice dictation is unavailable while this message composer is inactive.",
      );
      setStatus("error");
      return;
    }
    clearSettleTimer();
    const existingRecognition = recognitionRef.current;
    if (existingRecognition) releaseRecognition(existingRecognition);
    try {
      existingRecognition?.abort();
    } catch {
      // The old generation is detached before the new one starts.
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    requestedEndRef.current = undefined;
    errorRef.current = false;
    updateSettling(true);
    setError(undefined);
    setStatus("starting");

    let recognition: BrowserSpeechRecognition | undefined;
    try {
      recognition = new Recognition();
      if (generationRef.current !== generation || !mountedRef.current) {
        try {
          recognition.abort();
        } catch {
          // A concurrent lifecycle fence already owns this generation.
        }
        return;
      }
      const activeRecognition = recognition;
      recognitionRef.current = activeRecognition;
      activeRecognition.continuous = true;
      activeRecognition.interimResults = true;
      activeRecognition.lang = navigator.language || "en-US";
      activeRecognition.maxAlternatives = 1;
      if (generationRef.current !== generation) return;
      activeRecognition.onstart = () => {
        if (generationRef.current === generation && mountedRef.current) {
          setStatus("listening");
        }
      };
      activeRecognition.onresult = event => {
        if (generationRef.current !== generation) return;
        const finalTranscripts: string[] = [];
        for (
          let index = event.resultIndex;
          index < event.results.length;
          index += 1
        ) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript;
          if (result?.isFinal && transcript?.trim()) {
            finalTranscripts.push(transcript.trim());
          }
        }
        if (finalTranscripts.length) {
          transcriptHandlerRef.current(finalTranscripts.join(" "));
        }
      };
      activeRecognition.onerror = event => {
        if (generationRef.current !== generation) return;
        if (event.error === "aborted" && requestedEndRef.current) return;
        abandonGeneration(
          activeRecognition,
          generation,
          dictationErrorMessage(event.error, event.message),
        );
      };
      activeRecognition.onend = () => {
        if (generationRef.current !== generation) return;
        generationRef.current += 1;
        const requestedEnd = requestedEndRef.current;
        clearSettleTimer();
        releaseRecognition(activeRecognition);
        requestedEndRef.current = undefined;
        updateSettling(false);
        if (!mountedRef.current || errorRef.current) return;
        setStatus(requestedEnd === "pause" ? "paused" : "stopped");
      };
      if (generationRef.current !== generation) return;

      const stopMonitoring = monitorSpeechSurfaceAccessibility(
        () => surfaceRef.current,
        abandonForSurfaceLoss,
      );
      if (generationRef.current !== generation) {
        stopMonitoring();
        return;
      }
      surfaceCleanupRef.current = stopMonitoring;
      activeRecognition.start();
    } catch (startError) {
      const detail =
        startError instanceof Error && startError.message.trim()
          ? ` ${startError.message.trim()}`
          : "";
      abandonGeneration(
        recognition,
        generation,
        `Voice dictation could not start.${detail} Check microphone access and try again.`,
        false,
      );
    }
  }, [
    abandonGeneration,
    abandonForSurfaceLoss,
    clearSettleTimer,
    releaseRecognition,
    surfaceRef,
    unavailableReason,
    updateSettling,
  ]);

  const pause = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    requestedEndRef.current = "pause";
    setStatus("pausing");
    const generation = generationRef.current;
    scheduleSettleTimeout(recognition, generation);
    try {
      recognition.stop();
    } catch (pauseError) {
      abandonGeneration(
        recognition,
        generation,
        pauseError instanceof Error
          ? pauseError.message
          : "Voice dictation could not pause.",
      );
    }
  }, [abandonGeneration, scheduleSettleTimeout]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      const wasSettling = settlingRef.current;
      generationRef.current += 1;
      clearSettleTimer();
      stopSurfaceMonitoring();
      requestedEndRef.current = undefined;
      updateSettling(false);
      if (wasSettling) {
        errorRef.current = true;
        setError(
          "Voice dictation stopped before it finished. Pending speech may not have been added; review the draft before sending.",
        );
        setStatus("error");
      } else {
        setStatus("stopped");
      }
      return;
    }
    requestedEndRef.current = "stop";
    setStatus("stopping");
    const generation = generationRef.current;
    scheduleSettleTimeout(recognition, generation);
    try {
      recognition.stop();
    } catch (stopError) {
      abandonGeneration(
        recognition,
        generation,
        stopError instanceof Error
          ? stopError.message
          : "Voice dictation could not stop cleanly.",
      );
    }
  }, [
    abandonGeneration,
    clearSettleTimer,
    scheduleSettleTimeout,
    stopSurfaceMonitoring,
    updateSettling,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const endForNavigation = () => {
      const recognition = recognitionRef.current;
      if (!recognition && !settlingRef.current) return;
      abandonGeneration(
        recognition,
        generationRef.current,
        "Voice dictation stopped because this page became inactive.",
      );
    };
    window.addEventListener("pagehide", endForNavigation);
    return () => {
      window.removeEventListener("pagehide", endForNavigation);
      mountedRef.current = false;
      generationRef.current += 1;
      clearSettleTimer();
      stopSurfaceMonitoring();
      requestedEndRef.current = "stop";
      const recognition = recognitionRef.current;
      if (recognition) {
        releaseRecognition(recognition);
        try {
          recognition.abort();
        } catch {
          // Unmount already fenced this generation.
        }
      }
      updateSettling(false);
    };
  }, [
    abandonGeneration,
    clearSettleTimer,
    releaseRecognition,
    stopSurfaceMonitoring,
    updateSettling,
  ]);

  return {
    error,
    status,
    unavailableReason,
    pause,
    resume: begin,
    start: begin,
    stop,
  };
}
