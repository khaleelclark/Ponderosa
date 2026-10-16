import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import type { BrowserSession } from "./browserAdapters";
import type { BrowserEndpointAdapter, UnfencedBrowserInput } from "./browserAdapters";
import { useEffect, useRef, useState } from "react";
import type { BrowserFrameMetadata } from "@ponderosa/core";
import NearMeIcon from "@mui/icons-material/NearMe";
import { BrowserKeyboard } from "./BrowserKeyboard";
import {
  browserTouchScrollDelta,
  createBrowserBinaryFrameParser,
  createLatestBrowserFrameQueue,
  createBrowserFrameScheduler,
  decodeBrowserFrameSurface,
  normalizeBrowserWheelDelta,
  parseBrowserFrameEvent,
} from "../../browserInteraction";

const BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;

export function BrowserViewport<Session extends BrowserSession>({
  adapter,
  session,
  active,
  pollingEnabled = true,
  operatorControl,
  sendInput,
  refreshFrame,
  empty,
  accent = "warning.main",
  viewedPageId,
  keyboardTarget,
  preferBinary = true,
}: {
  adapter: BrowserEndpointAdapter<Session>;
  session?: Session;
  active: boolean;
  pollingEnabled?: boolean;
  operatorControl: boolean;
  sendInput(input: UnfencedBrowserInput): void;
  refreshFrame: React.MutableRefObject<() => void>;
  empty?: React.ReactNode;
  accent?: string;
  viewedPageId?: string;
  keyboardTarget?: Element | null;
  preferBinary?: boolean;
}): JSX.Element {
  const [hasFrame, setHasFrame] = useState(false);
  const [frameError, setFrameError] = useState<string>();
  const [metadata, setMetadata] = useState<BrowserFrameMetadata>();
  const container = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLCanvasElement>(null);
  const [imageBounds, setImageBounds] = useState({ width: 0, height: 0, left: 0 });
  const frameContext = useRef<BrowserFrameMetadata>();
  const frameAbort = useRef<AbortController>();
  const frameVisibility = useRef<() => void>();
  const pollingEnabledRef = useRef(pollingEnabled);
  pollingEnabledRef.current = pollingEnabled;
  useEffect(() => {
    frameVisibility.current?.();
  }, [pollingEnabled]);
  useEffect(() => {
    if (!metadata?.activity) return;
    const timer = setTimeout(() => setMetadata(current => current ? { ...current, activity: undefined } : current), Math.max(0, metadata.activity.at + 2_500 - Date.now()));
    return () => clearTimeout(timer);
  }, [metadata?.activity?.at]);
  const rawSendInput = sendInput;
  sendInput = input => rawSendInput({ ...input, expectedPageId: frameContext.current?.pageId ?? viewedPageId, expectedViewport: frameContext.current?.viewport });
  const pageId = viewedPageId ?? session?.activePageId;
  useEffect(() => {
    if (!active || !operatorControl || !pageId || !adapter.resizeViewport || !container.current || !session || session.location === "local") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let chain = Promise.resolve();
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      clearTimeout(timer);
      const size = { width: Math.min(2560, Math.max(320, Math.floor(entry.contentRect.width))), height: Math.min(1600, Math.max(200, Math.floor(entry.contentRect.height))) };
      timer = setTimeout(() => {
        chain = chain.then(async () => {
          if (cancelled || last === JSON.stringify(size)) return;
          try {
            await adapter.resizeViewport!(pageId, size, session.controlEpoch);
            last = JSON.stringify(size);
            refreshFrame.current();
          } catch (error) { if (!cancelled) setFrameError(error instanceof Error ? error.message : String(error)); }
        });
      }, 250);
    });
    observer.observe(container.current);
    return () => { cancelled = true; clearTimeout(timer); observer.disconnect(); };
  }, [active, operatorControl, adapter, pageId, session?.id, session?.controlEpoch, refreshFrame]);
  useEffect(() => {
    if (!image.current) return;
    const element = image.current;
    const observer = new ResizeObserver(() => setImageBounds({ width: element.clientWidth, height: element.clientHeight, left: element.offsetLeft }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [session?.status]);
  const touchGesture = useRef<{ pointerId: number; lastX: number; lastY: number }>();
  const suppressClick = useRef(false);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    const input = keyboard.current;
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing || !operatorControl) return;
      if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
        event.preventDefault();
        sendInput({ kind: "key", key: event.inputType === "deleteContentBackward" ? "Backspace" : "Delete" });
      }
    };
    input?.addEventListener("beforeinput", beforeInput);
    return () => input?.removeEventListener("beforeinput", beforeInput);
  }, [operatorControl, sendInput]);

  useEffect(() => {
    if (!active || session?.status !== "ready") {
      setHasFrame(false);
      return undefined;
    }
    let cancelled = false;
    let source: EventSource | undefined;
    let streamQueue: ReturnType<typeof createLatestBrowserFrameQueue<{ blob: Blob; metadata: BrowserFrameMetadata }>> | undefined;
    let binaryAbort: AbortController | undefined;
    let fallback = false;
    let scheduler: ReturnType<typeof createBrowserFrameScheduler> | undefined;
    let arrived = 0;
    let shown = 0;
    const showFrame = async (blob: Blob, nextMetadata: BrowserFrameMetadata | undefined, arrival: number, valid = () => true) => {
      // Paint directly into one persistent surface. Replacing an <img> URL on
      // every screencast frame made React, image layout and URL cleanup part of
      // the hot path, which is especially costly on mobile Safari.
      const decoded = await decodeBrowserFrameSurface(blob);
      if (cancelled || !valid() || !pollingEnabledRef.current || document.visibilityState !== "visible" || arrival <= shown) {
        decoded.close();
        return;
      }
      const surface = image.current;
      const context = surface?.getContext("2d", { alpha: false });
      if (!surface || !context) { decoded.close(); return; }
      try {
        if (surface.width !== decoded.width) surface.width = decoded.width;
        if (surface.height !== decoded.height) surface.height = decoded.height;
        context.drawImage(decoded.source, 0, 0);
      } finally { decoded.close(); }
      shown = arrival;
      setHasFrame(true);
      frameContext.current = nextMetadata;
      setMetadata(current => JSON.stringify(current) === JSON.stringify(nextMetadata) ? current : nextMetadata);
      setFrameError(current => current ? undefined : current);
    };
    const capture = async () => {
        if (!pollingEnabledRef.current || document.visibilityState !== "visible") return;
        const controller = new AbortController();
        frameAbort.current = controller;
        try {
          const frame = await adapter.getFrame(pageId, controller.signal);
          if (!cancelled) await showFrame(frame.blob, frame.metadata, ++arrived);
        } catch (error) {
          if (!cancelled && !controller.signal.aborted) setFrameError(error instanceof Error ? error.message : String(error));
        } finally {
          if (frameAbort.current === controller) frameAbort.current = undefined;
        }
    };
    const startPolling = () => {
      if (scheduler) { scheduler.setVisible(document.visibilityState === "visible" && pollingEnabledRef.current); return; }
      scheduler = createBrowserFrameScheduler({ capture });
      scheduler.setVisible(document.visibilityState === "visible" && pollingEnabledRef.current);
    };
    let legacyWatchdog: ReturnType<typeof setTimeout> | undefined;
    const closeStream = () => {
      if (legacyWatchdog) clearTimeout(legacyWatchdog);
      legacyWatchdog = undefined;
      streamQueue?.dispose(); streamQueue = undefined;
      source?.close(); source = undefined;
      binaryAbort?.abort(); binaryAbort = undefined;
    };
    const startLegacyStream = () => {
      if (typeof EventSource === "undefined") { fallback = true; startPolling(); return; }
      const opened = new EventSource(adapter.frameStreamUrl(pageId));
      source = opened;
      const armWatchdog = () => {
        if (legacyWatchdog) clearTimeout(legacyWatchdog);
        legacyWatchdog = setTimeout(() => {
          if (cancelled || source !== opened) return;
          closeStream();
          fallback = true;
          startPolling();
        }, 20_000);
      };
      armWatchdog();
      opened.addEventListener("heartbeat", armWatchdog);
      streamQueue = createLatestBrowserFrameQueue(async frame => {
        await showFrame(frame.blob, frame.metadata, ++arrived, () => source === opened);
      }, error => { if (!cancelled && source === opened) setFrameError(error instanceof Error ? error.message : String(error)); });
      opened.addEventListener("frame", event => {
        armWatchdog();
        try { streamQueue?.push(parseBrowserFrameEvent((event as MessageEvent).data)); }
        catch (error) { if (!cancelled) setFrameError(error instanceof Error ? error.message : String(error)); }
      });
      opened.onerror = () => {
        if (cancelled || source !== opened) return;
        closeStream();
        fallback = true;
        startPolling();
      };
    };
    const startStream = () => {
      if (!preferBinary || typeof fetch !== "function" || typeof ReadableStream === "undefined") { startLegacyStream(); return; }
      const controller = new AbortController();
      binaryAbort = controller;
      streamQueue = createLatestBrowserFrameQueue(async frame => {
        await showFrame(frame.blob, frame.metadata, ++arrived, () => binaryAbort === controller);
      }, error => { if (!cancelled && binaryAbort === controller) setFrameError(error instanceof Error ? error.message : String(error)); });
      void (async () => {
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const armWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => controller.abort(), 20_000);
        };
        try {
          armWatchdog();
          const url = adapter.frameStreamUrl(pageId);
          const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}format=binary`, { signal: controller.signal, credentials: "same-origin", cache: "no-store" });
          if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/vnd.ponderosa.browser-frames" || !response.body) throw new Error("Binary browser preview unavailable.");
          const reader = response.body.getReader();
          const parser = createBrowserBinaryFrameParser();
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) throw new Error("Browser preview stream ended.");
            armWatchdog();
            for (const frame of parser.push(next.value)) streamQueue?.push(frame);
          }
        } catch {
          if (cancelled || binaryAbort !== controller) return;
          closeStream();
          startLegacyStream();
        } finally { if (watchdog) clearTimeout(watchdog); }
      })();
    };
    const updateVisibility = () => {
      const visible = document.visibilityState === "visible" && pollingEnabledRef.current;
      if (!visible) {
        frameAbort.current?.abort();
        closeStream();
        scheduler?.setVisible(false);
      } else if (fallback) startPolling();
      else if (!source && !binaryAbort) startStream();
    };
    refreshFrame.current = () => scheduler?.requestInteractionRefresh();
    frameVisibility.current = updateVisibility;
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();
    return () => {
      cancelled = true;
      frameAbort.current?.abort();
      closeStream();
      document.removeEventListener("visibilitychange", updateVisibility);
      scheduler?.dispose();
      if (frameVisibility.current === updateVisibility) frameVisibility.current = undefined;
      refreshFrame.current = () => undefined;
      setHasFrame(false);
    };
  }, [active, adapter, refreshFrame, session?.id, session?.status, pageId, preferBinary]);

  const viewport = session?.status === "opening"
    ? <Stack spacing={1} alignItems="center"><CircularProgress /><Typography color="grey.300">Starting browser…</Typography></Stack>
    : session?.status === "failed"
      ? <Alert severity="error">{session.failure ?? "Browser failed to start."}</Alert>
      : session?.status !== "ready"
        ? empty
        : <><Box
            component="canvas"
            ref={image}
            role="img"
            aria-label={operatorControl ? "Interactive browser viewport. You have keyboard and pointer control." : "Interactive browser viewport. Agent has control."}
            tabIndex={operatorControl ? 0 : -1}
            onClick={(event) => {
              if (!operatorControl) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              keyboard.current?.focus({ preventScroll: true });
              sendInput({
                kind: "click",
                x: (event.clientX - rect.left) * (metadata?.viewport.width ?? event.currentTarget.width ?? BROWSER_VIEWPORT.width) / rect.width,
                y: (event.clientY - rect.top) * (metadata?.viewport.height ?? event.currentTarget.height ?? BROWSER_VIEWPORT.height) / rect.height,
              });
            }}
            onFocus={() => keyboard.current?.focus({ preventScroll: true })}
            onWheel={(event) => {
              if (!operatorControl) return;
              event.preventDefault();
              sendInput({
                kind: "scroll",
                deltaX: normalizeBrowserWheelDelta(event.deltaX, event.deltaMode, event.currentTarget.clientWidth),
                deltaY: normalizeBrowserWheelDelta(event.deltaY, event.deltaMode, event.currentTarget.clientHeight),
              });
            }}
            onPointerDown={(event) => {
              if (!operatorControl || event.pointerType !== "touch") return;
              touchGesture.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const gesture = touchGesture.current;
              if (!operatorControl || !gesture || gesture.pointerId !== event.pointerId) return;
              const deltaX = browserTouchScrollDelta(gesture.lastX, event.clientX);
              const deltaY = browserTouchScrollDelta(gesture.lastY, event.clientY);
              gesture.lastX = event.clientX;
              gesture.lastY = event.clientY;
              if (Math.abs(deltaX) + Math.abs(deltaY) < 2) return;
              suppressClick.current = true;
              event.preventDefault();
              sendInput({ kind: "scroll", deltaX, deltaY });
            }}
            onPointerUp={(event) => {
              if (touchGesture.current?.pointerId === event.pointerId) touchGesture.current = undefined;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              if (suppressClick.current) globalThis.setTimeout(() => { suppressClick.current = false; }, 0);
            }}
            onPointerCancel={() => { touchGesture.current = undefined; }}
            draggable={false}
            sx={{
              width: "auto",
              height: "auto",
              maxWidth: "100%",
              maxHeight: "100%",
              display: "block",
              visibility: hasFrame ? "visible" : "hidden",
              touchAction: operatorControl ? "none" : "auto",
              cursor: "default",
              outlineOffset: -3,
            }}
          />
          {!hasFrame ? <Stack sx={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}><CircularProgress size={24} /></Stack> : null}</>;

  return <Stack spacing={1} sx={{ minHeight: 0, minWidth: 0, width: "100%", height: "100%" }}>
    <Box
      ref={container}
      sx={{
        position: "relative",
        minHeight: 0,
        minWidth: 0,
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
        placeItems: "start center",
        bgcolor: "grey.950",
        borderRadius: 1,
        overflow: "hidden",
        border: 1,
        borderColor: operatorControl ? accent : "divider",
      }}
    >
      {viewport}
      {!operatorControl && metadata?.activity && metadata.pageId === pageId && Date.now() - metadata.activity.at < 2_500 ? <Box aria-label={metadata.activity.kind === "fill" ? "Agent filling field" : "Agent click"}
        sx={{ pointerEvents: "none", position: "absolute", zIndex: 1,
          left: imageBounds.left + metadata.activity.x / metadata.viewport.width * imageBounds.width,
          top: metadata.activity.y / metadata.viewport.height * imageBounds.height,
          ...(metadata.activity.kind === "fill" ? {
            width: (metadata.activity.width ?? 0) / metadata.viewport.width * imageBounds.width,
            height: (metadata.activity.height ?? 0) / metadata.viewport.height * imageBounds.height,
            border: "2px solid", borderColor: "info.main", bgcolor: "rgba(100,180,220,.12)", borderRadius: .5,
          } : { color: "info.main", filter: "drop-shadow(0 1px 2px black)", transform: "translate(-5px,-5px)" }) }}>
        {metadata.activity.kind === "click" ? <NearMeIcon sx={{ transform: "rotate(-90deg)", fontSize: 26 }} /> : null}
      </Box> : null}
      {operatorControl ? <Box component="textarea"
        ref={keyboard}
        aria-label="Type in the browser page. Escape returns focus to browser controls."
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => {
          composing.current = false;
          if (event.currentTarget.value) sendInput({ kind: "type", text: event.currentTarget.value });
          event.currentTarget.value = "";
        }}
        onChange={event => {
          if (composing.current) return;
          if (event.target.value) sendInput({ kind: "type", text: event.target.value });
          event.target.value = "";
        }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.stopPropagation();
            event.currentTarget.blur();
            event.currentTarget.closest('[role="dialog"]')?.querySelector<HTMLInputElement>('input[aria-label="Website address"]')?.focus();
            return;
          }
          // Native text entry/paste feeds onChange, preserving Unicode and IME.
          if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return;
          event.preventDefault();
          // Control is the browser API's primary-shortcut token; the host driver
          // maps it to Command when Chrome runs on macOS.
          const modifiers = `${event.ctrlKey || event.metaKey ? "Control+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}`;
          sendInput({ kind: "key", key: modifiers + event.key });
        }}
        sx={{ position: "absolute", left: 0, top: 0, width: "1px", height: "1px", pointerEvents: "none", opacity: .01, p: 0, border: 0, fontSize: 16 }}
      /> : null}
    </Box>
    {operatorControl && active ? <BrowserKeyboard portalTarget={keyboardTarget} onText={text => sendInput({ kind: "type", text })} onKey={key => sendInput({ kind: "key", key })} /> : null}
    {frameError ? <Alert severity="warning" role="status">Live frame disconnected: {frameError}</Alert> : null}
  </Stack>;
}
