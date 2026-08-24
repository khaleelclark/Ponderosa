import { useCallback, useEffect, useRef, useState } from "react";
import {
  dictationErrorMessage,
  dictationUnavailableReason,
  speechRecognitionConstructor,
  type BrowserSpeechRecognition,
  type DictationStatus,
} from "./browserSpeech";

type RequestedEnd = "pause" | "stop";

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
): DictationController {
  const unavailableReason = dictationUnavailableReason();
  const [status, setStatus] = useState<DictationStatus>("ready");
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<BrowserSpeechRecognition>();
  const requestedEndRef = useRef<RequestedEnd>();
  const errorRef = useRef(false);
  const mountedRef = useRef(true);
  const transcriptHandlerRef = useRef(onFinalTranscript);
  transcriptHandlerRef.current = onFinalTranscript;

  const releaseRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognitionRef.current = undefined;
  }, []);

  const begin = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition || unavailableReason) return;
    const existingRecognition = recognitionRef.current;
    releaseRecognition();
    existingRecognition?.abort();
    requestedEndRef.current = undefined;
    errorRef.current = false;
    setError(undefined);
    setStatus("starting");

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;
    recognition.onstart = () => {
      if (mountedRef.current) setStatus("listening");
    };
    recognition.onresult = event => {
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
      if (event.error === "aborted" && requestedEndRef.current) return;
      errorRef.current = true;
      if (!mountedRef.current) return;
      setError(dictationErrorMessage(event.error, event.message));
      setStatus("error");
    };
    recognition.onend = () => {
      const requestedEnd = requestedEndRef.current;
      releaseRecognition();
      requestedEndRef.current = undefined;
      if (!mountedRef.current || errorRef.current) return;
      setStatus(requestedEnd === "pause" ? "paused" : "stopped");
    };

    try {
      recognition.start();
    } catch (startError) {
      releaseRecognition();
      errorRef.current = true;
      setError(
        startError instanceof Error
          ? startError.message
          : "Voice dictation could not start.",
      );
      setStatus("error");
    }
  }, [releaseRecognition, unavailableReason]);

  const pause = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    requestedEndRef.current = "pause";
    setStatus("pausing");
    try {
      recognition.stop();
    } catch (pauseError) {
      releaseRecognition();
      setError(
        pauseError instanceof Error
          ? pauseError.message
          : "Voice dictation could not pause.",
      );
      setStatus("error");
    }
  }, [releaseRecognition]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setStatus("stopped");
      return;
    }
    requestedEndRef.current = "stop";
    setStatus("stopping");
    try {
      recognition.stop();
    } catch (stopError) {
      releaseRecognition();
      setError(
        stopError instanceof Error
          ? stopError.message
          : "Voice dictation could not stop cleanly.",
      );
      setStatus("error");
    }
  }, [releaseRecognition]);

  useEffect(() => {
    mountedRef.current = true;
    const endForNavigation = () => {
      requestedEndRef.current = "stop";
      recognitionRef.current?.abort();
    };
    window.addEventListener("pagehide", endForNavigation);
    return () => {
      window.removeEventListener("pagehide", endForNavigation);
      mountedRef.current = false;
      requestedEndRef.current = "stop";
      recognitionRef.current?.abort();
      releaseRecognition();
    };
  }, [releaseRecognition]);

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
