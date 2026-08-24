import { useCallback, useEffect, useRef, useState } from "react";
import {
  dictationErrorMessage,
  dictationUnavailableReason,
  speechRecognitionConstructor,
  type BrowserSpeechRecognition,
  type DictationStatus,
} from "./browserSpeech";

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
): DictationController {
  const unavailableReason = dictationUnavailableReason();
  const [status, setStatus] = useState<DictationStatus>("ready");
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<BrowserSpeechRecognition>();
  const generationRef = useRef(0);
  const settlingRef = useRef(false);
  const settleTimerRef = useRef<number>();
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

  const releaseRecognition = useCallback(
    (recognition: BrowserSpeechRecognition) => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (recognitionRef.current === recognition) {
        recognitionRef.current = undefined;
      }
    },
    [],
  );

  const abandonRecognition = useCallback(
    (
      recognition: BrowserSpeechRecognition,
      generation: number,
      message: string,
    ) => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      clearSettleTimer();
      releaseRecognition(recognition);
      requestedEndRef.current = undefined;
      errorRef.current = true;
      try {
        recognition.abort();
      } catch {
        // The generation is already fenced and every callback detached.
      }
      updateSettling(false);
      if (!mountedRef.current) return;
      setError(
        `${message} Pending speech may not have been added; review the draft before sending.`,
      );
      setStatus("error");
    },
    [clearSettleTimer, releaseRecognition, updateSettling],
  );

  const scheduleSettleTimeout = useCallback(
    (recognition: BrowserSpeechRecognition, generation: number) => {
      clearSettleTimer();
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = undefined;
        abandonRecognition(
          recognition,
          generation,
          "Voice dictation did not finish in time.",
        );
      }, DICTATION_SETTLE_TIMEOUT_MS);
    },
    [abandonRecognition, clearSettleTimer],
  );

  const begin = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition || unavailableReason) return;
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

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;
    recognition.onstart = () => {
      if (generationRef.current === generation && mountedRef.current) {
        setStatus("listening");
      }
    };
    recognition.onresult = event => {
      if (generationRef.current !== generation) return;
      const finalTranscripts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
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
    recognition.onerror = event => {
      if (generationRef.current !== generation) return;
      if (event.error === "aborted" && requestedEndRef.current) return;
      abandonRecognition(
        recognition,
        generation,
        dictationErrorMessage(event.error, event.message),
      );
    };
    recognition.onend = () => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      const requestedEnd = requestedEndRef.current;
      clearSettleTimer();
      releaseRecognition(recognition);
      requestedEndRef.current = undefined;
      updateSettling(false);
      if (!mountedRef.current || errorRef.current) return;
      setStatus(requestedEnd === "pause" ? "paused" : "stopped");
    };

    try {
      recognition.start();
    } catch (startError) {
      abandonRecognition(
        recognition,
        generation,
        startError instanceof Error
          ? startError.message
          : "Voice dictation could not start.",
      );
    }
  }, [
    abandonRecognition,
    clearSettleTimer,
    releaseRecognition,
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
      abandonRecognition(
        recognition,
        generation,
        pauseError instanceof Error
          ? pauseError.message
          : "Voice dictation could not pause.",
      );
    }
  }, [abandonRecognition, scheduleSettleTimeout]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setStatus("stopped");
      return;
    }
    requestedEndRef.current = "stop";
    setStatus("stopping");
    const generation = generationRef.current;
    scheduleSettleTimeout(recognition, generation);
    try {
      recognition.stop();
    } catch (stopError) {
      abandonRecognition(
        recognition,
        generation,
        stopError instanceof Error
          ? stopError.message
          : "Voice dictation could not stop cleanly.",
      );
    }
  }, [abandonRecognition, scheduleSettleTimeout]);

  useEffect(() => {
    mountedRef.current = true;
    const endForNavigation = () => {
      generationRef.current += 1;
      clearSettleTimer();
      requestedEndRef.current = "stop";
      const recognition = recognitionRef.current;
      if (recognition) {
        releaseRecognition(recognition);
        try {
          recognition.abort();
        } catch {
          // Navigation already fenced this generation.
        }
      }
      updateSettling(false);
    };
    window.addEventListener("pagehide", endForNavigation);
    return () => {
      window.removeEventListener("pagehide", endForNavigation);
      mountedRef.current = false;
      generationRef.current += 1;
      clearSettleTimer();
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
  }, [clearSettleTimer, releaseRecognition, updateSettling]);

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
