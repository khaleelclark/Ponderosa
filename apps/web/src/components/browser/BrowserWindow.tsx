import { Box, IconButton, Paper, Portal, Tooltip, useMediaQuery } from "@mui/material";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import PictureInPictureAltIcon from "@mui/icons-material/PictureInPictureAlt";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import { useEffect, useRef, useState, type ReactNode } from "react";

type Mode = "docked" | "floating" | "expanded";
type Bounds = { x: number; y: number; width: number; height: number };
export interface BrowserWindowOptions {
  docked?: boolean;
  onDock?(): void;
  onUndock?(): void;
  onActivate?(): void;
  layer?: number;
  offset?: number;
  label?: string;
}
function fit(bounds: Bounds): Bounds {
  const width = Math.min(window.innerWidth, Math.max(360, bounds.width));
  const height = Math.min(window.innerHeight, Math.max(280, bounds.height));
  return { width, height, x: Math.max(0, Math.min(bounds.x, window.innerWidth - width)), y: Math.max(0, Math.min(bounds.y, window.innerHeight - height)) };
}

/** In-app floating window: keeps the same live surface mounted across modes. */
export function BrowserWindow({ children, onDockWidth, onClose, docked, onDock, onUndock, onActivate, layer = 0, offset = 0, label = "Browser" }: {
  children(controls: ReactNode): ReactNode;
  onDockWidth?(width: number): void;
  onClose(): void;
} & BrowserWindowOptions): JSX.Element {
  const mobile = useMediaQuery("(max-width: 899px)");
  const [requestedMode, setMode] = useState<Mode>("docked");
  const mode = requestedMode === "expanded" ? "expanded" : docked === undefined ? requestedMode : docked ? "docked" : "floating";
  const [bounds, setBounds] = useState<Bounds>(() => fit({ x: docked === undefined ? window.innerWidth - 740 : 24 + offset * 28, y: 80 + offset * 28, width: 720, height: 520 }));
  const [dockWidth, setDockWidth] = useState(() => Math.min(900, window.innerWidth * .5));
  const gesture = useRef<{ kind: "move" | "resize" | "dock"; x: number; y: number; bounds: Bounds; dock: number }>();
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const element = surface.current;
    element?.focus({ preventScroll: true });
    return () => { if (element?.contains(document.activeElement)) previous?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const resize = () => { setBounds(value => fit(value)); setDockWidth(value => Math.min(value, window.innerWidth * .7)); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const reportDockWidth = useRef(onDockWidth); reportDockWidth.current = onDockWidth;
  useEffect(() => { reportDockWidth.current?.(!mobile && mode === "docked" ? dockWidth : 0); return () => reportDockWidth.current?.(0); }, [mobile, mode, dockWidth]);
  const start = (event: React.PointerEvent<HTMLElement>, kind: "move" | "resize" | "dock") => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind, x: event.clientX, y: event.clientY, bounds, dock: dockWidth };
  };
  const controls = !mobile ? <>
    {([ ["docked", "Dock browser", <VerticalSplitIcon />], ["floating", "Float browser", <PictureInPictureAltIcon />], ["expanded", "Expand browser", <OpenInFullIcon />] ] as const).map(([value, label, icon]) =>
      <Tooltip key={value} title={label}><IconButton size="small" aria-label={label} aria-pressed={mode === value} color={mode === value ? "primary" : "default"} onClick={() => { setMode(value); if (value === "docked") onDock?.(); else onUndock?.(); }}>{icon}</IconButton></Tooltip>)}
  </> : null;
  const full = mobile || mode === "expanded";
  return <Portal><Paper ref={surface} tabIndex={-1} role="dialog" aria-modal="false" aria-label={label} elevation={mode === "floating" ? 18 : 4}
    onFocusCapture={onActivate}
    onKeyDown={event => { if (event.key === "Escape" && event.target === event.currentTarget) onClose(); }}
    onPointerDown={event => {
      onActivate?.();
      if (!mobile && mode === "floating" && (event.target as HTMLElement).closest("[data-browser-drag]") && !(event.target as HTMLElement).closest("button,input,[role=combobox]")) start(event, "move");
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (!current) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (current.kind === "dock") setDockWidth(Math.min(window.innerWidth * .7, Math.max(360, current.dock - dx)));
      else setBounds(fit(current.kind === "move" ? { ...current.bounds, x: current.bounds.x + dx, y: current.bounds.y + dy } : { ...current.bounds, width: current.bounds.width + dx, height: current.bounds.height + dy }));
    }}
    onPointerUp={() => { gesture.current = undefined; }} onPointerCancel={() => { gesture.current = undefined; }}
    sx={{ position: "fixed", zIndex: theme => theme.zIndex.drawer + 1 + layer, display: "flex", flexDirection: "column", overflow: "hidden", border: 1, borderColor: "divider", borderRadius: mode === "floating" && !mobile ? 2 : 0,
      ...(full ? { inset: 0 } : mode === "docked" ? { top: 0, right: 0, bottom: 0, width: dockWidth } : { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }) }}>
    {children(controls)}
    {!mobile && mode === "docked" ? <Box role="separator" aria-label="Resize browser panel" aria-orientation="vertical" tabIndex={0}
      onPointerDown={event => start(event, "dock")}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setDockWidth(value => Math.min(window.innerWidth * .7, Math.max(360, value + (event.key === "ArrowLeft" ? 32 : -32)))); } }}
      sx={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", touchAction: "none", "&:hover, &:focus-visible": { bgcolor: "primary.main" } }} /> : null}
    {!mobile && mode === "floating" ? <Box role="button" aria-label="Resize floating browser" tabIndex={0}
      onPointerDown={event => start(event, "resize")}
      onKeyDown={event => { if (event.key.startsWith("Arrow")) { event.preventDefault(); setBounds(value => fit({ ...value, width: value.width + (event.key === "ArrowRight" ? 32 : event.key === "ArrowLeft" ? -32 : 0), height: value.height + (event.key === "ArrowDown" ? 32 : event.key === "ArrowUp" ? -32 : 0) })); } }}
      sx={{ position: "absolute", right: 0, bottom: 0, width: 20, height: 20, cursor: "nwse-resize", touchAction: "none", borderRight: "4px solid", borderBottom: "4px solid", borderColor: "text.secondary", borderRadius: "0 0 6px 0" }} /> : null}
  </Paper></Portal>;
}
