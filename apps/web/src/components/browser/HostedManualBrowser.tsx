import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { BrowserKeyboard } from "./BrowserKeyboard";

export function HostedManualBrowser({ projectId, sessionId, epoch, responsive = false, readOnly = false, connectionSetup = true }: { projectId: string; sessionId: string; epoch: number; responsive?: boolean; readOnly?: boolean; connectionSetup?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const remote = useRef<import("@novnc/novnc/lib/rfb.js").default>();
  const [fit, setFit] = useState(true);
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => { if (remote.current) remote.current.scaleViewport = fit; }, [fit]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [resizeError, setResizeError] = useState(false);
  useEffect(() => {
    if (!responsive || readOnly || !container.current || status !== "connected") return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    let latest: { width: number; height: number } | undefined, running = false;
    const send = async () => {
      if (running || !latest || disposed) return;
      const size = latest; latest = undefined; running = true;
      try { await api.resizeHostedDisplay(projectId, sessionId, epoch, size.width, size.height); if (!disposed) setResizeError(false); }
      catch { if (!disposed) setResizeError(true); }
      finally { running = false; if (latest && !disposed) void send(); }
    };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
      latest = { width: Math.max(320, Math.min(1280, Math.round(entry.contentRect.width))), height: Math.max(200, Math.min(1280, Math.round(entry.contentRect.height))) };
      clearTimeout(timer); timer = setTimeout(() => void send(), 150);
    });
    observer.observe(container.current);
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); };
  }, [responsive, readOnly, status, projectId, sessionId, epoch]);
  useEffect(() => {
    let disposed = false;
    let connection: import("@novnc/novnc/lib/rfb.js").default | undefined;
    setStatus("connecting");
    void (async () => {
      try {
        const [{ default: RFB }, ticket] = await Promise.all([import("@novnc/novnc/lib/rfb.js"), api.hostedBrowserTicket(projectId, sessionId, epoch)]);
        if (disposed || !container.current) return;
        const url = new URL(ticket.path, window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        connection = new RFB(container.current, url.href, { wsProtocols: ["binary", ticket.protocol] });
        remote.current = connection;
        connection.scaleViewport = fitRef.current;
        connection.resizeSession = false;
        connection.qualityLevel = 9;
        connection.compressionLevel = 2;
        connection.focusOnClick = true;
        connection.viewOnly = readOnly;
        connection.addEventListener("connect", () => { if (!disposed) setStatus("connected"); });
        connection.addEventListener("disconnect", () => { if (!disposed) setStatus("disconnected"); });
        connection.addEventListener("securityfailure", () => { if (!disposed) setStatus("disconnected"); });
      } catch { if (!disposed) setStatus("disconnected"); }
    })();
    return () => { disposed = true; connection?.disconnect(); if (remote.current === connection) remote.current = undefined; };
  }, [projectId, sessionId, epoch, attempt, readOnly]);
  return <Stack sx={{ flex: 1, minHeight: 0, position: "relative" }}>
    <Stack direction="row" justifyContent="space-between" sx={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1, px: .5, bgcolor: "background.paper", borderTop: 1, borderColor: "divider", "& .MuiButton-root": { fontSize: 12, minHeight: 30, py: .25 } }}>
      {connectionSetup ? <Button size="small" disabled={readOnly || status !== "connected"} onClick={() => {
        const connection = remote.current;
        if (!connection) return;
        connection.sendKey(0xffe3, "ControlLeft", true);
        connection.sendKey(0x74, "KeyT");
        connection.sendKey(0xffe3, "ControlLeft", false);
        window.setTimeout(() => {
          if (remote.current !== connection) return;
          for (const character of "chrome://inspect/#remote-debugging") connection.sendKey(character.codePointAt(0)!);
          connection.sendKey(0xff0d, "Enter");
        }, 200);
      }}>Connection setup</Button> : <Typography variant="caption" sx={{ alignSelf: "center" }}>{readOnly ? "Agent has control" : "You have control"}</Typography>}
      <BrowserKeyboard disabled={readOnly || status !== "connected"} onText={text => {
        for (const character of text) {
          const point = character.codePointAt(0)!;
          remote.current?.sendKey(point === 10 ? 0xff0d : point <= 255 ? point : 0x01000000 + point);
        }
      }} onKey={key => {
        const keys: Record<string, number> = { Backspace: 0xff08, Delete: 0xffff, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 };
        if (keys[key]) remote.current?.sendKey(keys[key]);
      }} />
      <Button size="small" onClick={() => setFit(value => !value)}>{fit ? "Actual size" : "Fit browser"}</Button>
    </Stack>
    {status === "connecting" ? <Typography role="status" variant="caption" sx={{ px: 1.5 }}>Connecting to your browser…</Typography> : null}
    {resizeError ? <Typography role="status" variant="caption" sx={{ px: 1.5 }}>Could not resize the browser. The existing view is still available.</Typography> : null}
    {status === "disconnected" ? <Alert severity="warning" action={<Button onClick={() => setAttempt(value => value + 1)}>Reconnect view</Button>}>The view disconnected. Your browser remains open; input is not retried.</Alert> : null}
    <Box ref={container} aria-label="Manual Chrome browser" sx={{ flex: 1, minHeight: 0, mb: "31px", overflow: "hidden", bgcolor: "#171b18", "& > div": { alignItems: "flex-start !important" }, "& canvas": { outline: "none" } }} />
  </Stack>;
}
