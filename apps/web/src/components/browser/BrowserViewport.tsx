import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import type { BrowserSession } from "./browserAdapters";
import type { BrowserEndpointAdapter, UnfencedBrowserInput } from "./browserAdapters";
import { useEffect, useRef, useState } from "react";
import {
  browserTouchScrollDelta,
  createBrowserFrameScheduler,
  decodeBrowserFrame,
  normalizeBrowserWheelDelta,
} from "../../browserInteraction";

const BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;

export function BrowserViewport<Session extends BrowserSession>({
  adapter,
  session,
  active,
  operatorControl,
  sendInput,
  refreshFrame,
  empty,
  accent = "warning.main",
}: {
  adapter: BrowserEndpointAdapter<Session>;
  session?: Session;
  active: boolean;
  operatorControl: boolean;
  sendInput(input: UnfencedBrowserInput): void;
  refreshFrame: React.MutableRefObject<() => void>;
  empty?: React.ReactNode;
  accent?: string;
}): JSX.Element {
  const [frameUrl, setFrameUrl] = useState<string>();
  const [frameError, setFrameError] = useState<string>();
  const touchGesture = useRef<{ pointerId: number; lastX: number; lastY: number }>();
  const suppressClick = useRef(false);

  useEffect(() => {
    if (!active || session?.status !== "ready") {
      setFrameUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return undefined;
      });
      return undefined;
    }
    let cancelled = false;
    const scheduler = createBrowserFrameScheduler({
      capture: async () => {
        try {
          const frame = await adapter.getFrame();
          if (cancelled || document.visibilityState !== "visible") return;
          const next = await decodeBrowserFrame(frame.blob);
          if (cancelled || document.visibilityState !== "visible") {
            URL.revokeObjectURL(next);
            return;
          }
          setFrameUrl((current) => {
            if (current) URL.revokeObjectURL(current);
            return next;
          });
          setFrameError(undefined);
        } catch (error) {
          if (!cancelled) setFrameError(error instanceof Error ? error.message : String(error));
        }
      },
    });
    const updateVisibility = () => scheduler.setVisible(document.visibilityState === "visible");
    refreshFrame.current = () => scheduler.requestInteractionRefresh();
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", updateVisibility);
      scheduler.dispose();
      refreshFrame.current = () => undefined;
      setFrameUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return undefined;
      });
    };
  }, [active, adapter, refreshFrame, session?.id, session?.status]);

  const viewport = session?.status === "opening"
    ? <Stack spacing={1} alignItems="center"><CircularProgress /><Typography color="grey.300">Starting browser…</Typography></Stack>
    : session?.status === "failed"
      ? <Alert severity="error">{session.failure ?? "Browser failed to start."}</Alert>
      : session?.status !== "ready"
        ? empty
        : frameUrl
          ? <Box
            component="img"
            src={frameUrl}
            alt={`Interactive browser viewport: ${session.title ?? session.url ?? "page"}`}
            aria-label={operatorControl ? "Interactive browser viewport. You have keyboard and pointer control." : "Interactive browser viewport. Agent has control."}
            tabIndex={operatorControl ? 0 : -1}
            onClick={(event) => {
              if (!operatorControl) return;
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              sendInput({
                kind: "click",
                x: (event.clientX - rect.left) * BROWSER_VIEWPORT.width / rect.width,
                y: (event.clientY - rect.top) * BROWSER_VIEWPORT.height / rect.height,
              });
            }}
            onKeyDown={(event) => {
              if (!operatorControl || event.key === "Tab" || event.key === "Escape") return;
              event.preventDefault();
              sendInput({ kind: "key", key: event.key });
            }}
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
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              touchAction: operatorControl ? "none" : "auto",
              cursor: operatorControl ? "crosshair" : "default",
              outlineOffset: -3,
            }}
          />
          : <Stack sx={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}><CircularProgress size={24} /></Stack>;

  return <Stack spacing={1} sx={{ minHeight: 0 }}>
    <Box
      data-testid="browser-viewport"
      sx={{
        position: "relative",
        minHeight: 0,
        width: "100%",
        height: "100%",
        aspectRatio: `${BROWSER_VIEWPORT.width} / ${BROWSER_VIEWPORT.height}`,
        display: "grid",
        placeItems: "center",
        bgcolor: "grey.950",
        borderRadius: 1,
        overflow: "hidden",
        border: 1,
        borderColor: operatorControl ? accent : "divider",
      }}
    >
      {viewport}
    </Box>
    {frameError ? <Alert severity="warning" role="status">Live frame disconnected: {frameError}</Alert> : null}
  </Stack>;
}
